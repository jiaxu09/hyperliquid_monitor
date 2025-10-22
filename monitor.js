import { Client, Databases } from 'node-appwrite';
import nodemailer from 'nodemailer';

export default async ({ req, res, log, error }) => {
  try {
    // 环境变量配置
    const HYPERLIQUID_ADDRESS = process.env.TARGET_ADDRESS;
    const GMAIL_USER = process.env.SENDER_EMAIL;
    const GMAIL_APP_PASSWORD = process.env.APP_PASSWORD;
    const NOTIFY_EMAIL = process.env.RECEIVER_EMAIL;
    const APPWRITE_ENDPOINT = process.env.APPWRITE_ENDPOINT || 'https://cloud.appwrite.io/v1';
    const APPWRITE_PROJECT_ID = process.env.APPWRITE_PROJECT_ID;
    const APPWRITE_API_KEY = process.env.APPWRITE_API_KEY;
    const DATABASE_ID = process.env.APPWRITE_DATABASE_ID;
    const COLLECTION_ID = process.env.APPWRITE_COLLECTION_ID;

    // 验证必要参数
    if (!HYPERLIQUID_ADDRESS || !GMAIL_USER || !GMAIL_APP_PASSWORD || !NOTIFY_EMAIL) {
      throw new Error('Missing required environment variables');
    }

    log('Starting position monitoring...');

    // 获取当前仓位
    const currentPositions = await getHyperliquidPositions(HYPERLIQUID_ADDRESS);
    log('Current positions:', JSON.stringify(currentPositions));

    // 获取上次保存的仓位
    const previousPositions = await getPreviousPositions(
      APPWRITE_ENDPOINT,
      APPWRITE_PROJECT_ID,
      APPWRITE_API_KEY,
      DATABASE_ID,
      COLLECTION_ID,
      log
    );
    log('Previous positions:', JSON.stringify(previousPositions));

    // 检测仓位变化
    const changes = detectPositionChanges(previousPositions, currentPositions);
    
    if (changes.length > 0) {
      log('Position changes detected:', JSON.stringify(changes));
      
      // 发送邮件通知
      await sendEmailNotification(
        GMAIL_USER,
        GMAIL_APP_PASSWORD,
        NOTIFY_EMAIL,
        HYPERLIQUID_ADDRESS,
        changes,
        log
      );

      // 保存新的仓位状态
      await saveCurrentPositions(
        APPWRITE_ENDPOINT,
        APPWRITE_PROJECT_ID,
        APPWRITE_API_KEY,
        DATABASE_ID,
        COLLECTION_ID,
        currentPositions,
        log
      );

      return res.json({
        success: true,
        message: `检测到 ${changes.length} 个仓位变化`,
        changes: changes
      });
    } else {
      log('No position changes detected');
      
      // 即使没有变化，也更新时间戳
      await saveCurrentPositions(
        APPWRITE_ENDPOINT,
        APPWRITE_PROJECT_ID,
        APPWRITE_API_KEY,
        DATABASE_ID,
        COLLECTION_ID,
        currentPositions,
        log
      );
      
      return res.json({
        success: true,
        message: '未检测到仓位变化'
      });
    }

  } catch (err) {
    error('Error:', err.message);
    error('Stack:', err.stack);
    return res.json({
      success: false,
      error: err.message
    }, 500);
  }
};

// 获取 Hyperliquid 仓位信息
async function getHyperliquidPositions(address) {
  const url = 'https://api.hyperliquid.xyz/info';
  
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      type: 'clearinghouseState',
      user: address
    })
  });

  if (!response.ok) {
    throw new Error(`Hyperliquid API 错误: ${response.status}`);
  }

  const data = await response.json();
  
  // 提取仓位信息
  const positions = {};
  if (data.assetPositions && data.assetPositions.length > 0) {
    data.assetPositions.forEach(position => {
      if (position.position && parseFloat(position.position.szi) !== 0) {
        positions[position.position.coin] = {
          coin: position.position.coin,
          size: parseFloat(position.position.szi),
          entryPrice: parseFloat(position.position.entryPx),
          unrealizedPnl: parseFloat(position.position.unrealizedPnl || 0),
          leverage: parseFloat(position.position.leverage?.value || 1),
          liquidationPrice: parseFloat(position.position.liquidationPx || 0)
        };
      }
    });
  }

  return positions;
}

// 检测仓位变化
function detectPositionChanges(previousPositions, currentPositions) {
  const changes = [];
  const prevPos = previousPositions || {};
  const currPos = currentPositions || {};

  // 检查新开仓位和仓位增加
  for (const [coin, position] of Object.entries(currPos)) {
    if (!prevPos[coin]) {
      // 新开仓
      changes.push({
        type: 'OPENED',
        coin: coin,
        size: position.size,
        entryPrice: position.entryPrice,
        leverage: position.leverage,
        unrealizedPnl: position.unrealizedPnl,
        timestamp: new Date().toISOString()
      });
    } else {
      const sizeDiff = Math.abs(position.size) - Math.abs(prevPos[coin].size);
      if (sizeDiff > 0.0001) {
        // 加仓
        changes.push({
          type: 'INCREASED',
          coin: coin,
          previousSize: prevPos[coin].size,
          currentSize: position.size,
          sizeChange: position.size - prevPos[coin].size,
          entryPrice: position.entryPrice,
          leverage: position.leverage,
          unrealizedPnl: position.unrealizedPnl,
          timestamp: new Date().toISOString()
        });
      } else if (sizeDiff < -0.0001) {
        // 减仓
        changes.push({
          type: 'DECREASED',
          coin: coin,
          previousSize: prevPos[coin].size,
          currentSize: position.size,
          sizeChange: position.size - prevPos[coin].size,
          entryPrice: position.entryPrice,
          unrealizedPnl: position.unrealizedPnl,
          timestamp: new Date().toISOString()
        });
      }
    }
  }

  // 检查平仓
  for (const [coin, position] of Object.entries(prevPos)) {
    if (!currPos[coin]) {
      changes.push({
        type: 'CLOSED',
        coin: coin,
        previousSize: position.size,
        previousEntryPrice: position.entryPrice,
        timestamp: new Date().toISOString()
      });
    }
  }

  return changes;
}

// 发送邮件通知
async function sendEmailNotification(gmailUser, gmailPassword, recipientEmail, address, changes, log) {
  try {
    const transporter = nodemailer.createTransport({
      service: 'gmail',
      auth: {
        user: gmailUser,
        pass: gmailPassword
      }
    });

    // 构建邮件内容
    let emailBody = `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        <h2 style="color: #333;">🚨 Hyperliquid 仓位变化通知</h2>
        <p><strong>监控地址:</strong> <code>${address}</code></p>
        <p><strong>时间:</strong> ${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}</p>
        <hr style="border: 1px solid #ddd;">
    `;

    changes.forEach((change, index) => {
      emailBody += `<div style="margin: 20px 0; padding: 15px; background-color: #f9f9f9; border-left: 4px solid `;
      
      switch (change.type) {
        case 'OPENED':
          emailBody += `#4CAF50;">
            <h3 style="color: #4CAF50; margin-top: 0;">🟢 新开仓位</h3>
            <p><strong>币种:</strong> ${change.coin}</p>
            <p><strong>仓位大小:</strong> ${change.size}</p>
            <p><strong>开仓价格:</strong> $${change.entryPrice.toFixed(4)}</p>
            <p><strong>杠杆:</strong> ${change.leverage}x</p>
            <p><strong>未实现盈亏:</strong> <span style="color: ${change.unrealizedPnl >= 0 ? 'green' : 'red'}">$${change.unrealizedPnl.toFixed(2)}</span></p>
          `;
          break;
        
        case 'INCREASED':
          emailBody += `#2196F3;">
            <h3 style="color: #2196F3; margin-top: 0;">🔵 加仓</h3>
            <p><strong>币种:</strong> ${change.coin}</p>
            <p><strong>原仓位:</strong> ${change.previousSize}</p>
            <p><strong>当前仓位:</strong> ${change.currentSize}</p>
            <p><strong>增加:</strong> +${Math.abs(change.sizeChange).toFixed(4)}</p>
            <p><strong>入场价:</strong> $${change.entryPrice.toFixed(4)}</p>
            <p><strong>杠杆:</strong> ${change.leverage}x</p>
            <p><strong>未实现盈亏:</strong> <span style="color: ${change.unrealizedPnl >= 0 ? 'green' : 'red'}">$${change.unrealizedPnl.toFixed(2)}</span></p>
          `;
          break;
        
        case 'DECREASED':
          emailBody += `#FF9800;">
            <h3 style="color: #FF9800; margin-top: 0;">🟠 减仓</h3>
            <p><strong>币种:</strong> ${change.coin}</p>
            <p><strong>原仓位:</strong> ${change.previousSize}</p>
            <p><strong>当前仓位:</strong> ${change.currentSize}</p>
            <p><strong>减少:</strong> ${change.sizeChange.toFixed(4)}</p>
            <p><strong>当前价格:</strong> $${change.entryPrice.toFixed(4)}</p>
            <p><strong>未实现盈亏:</strong> <span style="color: ${change.unrealizedPnl >= 0 ? 'green' : 'red'}">$${change.unrealizedPnl.toFixed(2)}</span></p>
          `;
          break;
        
        case 'CLOSED':
          emailBody += `#F44336;">
            <h3 style="color: #F44336; margin-top: 0;">🔴 平仓</h3>
            <p><strong>币种:</strong> ${change.coin}</p>
            <p><strong>平仓大小:</strong> ${change.previousSize}</p>
            <p><strong>开仓价格:</strong> $${change.previousEntryPrice.toFixed(4)}</p>
          `;
          break;
      }
      
      emailBody += `</div>`;
    });

    emailBody += `
        <hr style="border: 1px solid #ddd; margin-top: 30px;">
        <p style="color: #666; font-size: 12px;">此邮件由 Hyperliquid 仓位监控系统自动发送</p>
      </div>
    `;

    const mailOptions = {
      from: gmailUser,
      to: recipientEmail,
      subject: `🚨 Hyperliquid 仓位提醒 - ${changes.length} 个变化`,
      html: emailBody
    };

    await transporter.sendMail(mailOptions);
    log('Email sent successfully');
  } catch (err) {
    log('Email send error:', err.message);
    throw err;
  }
}

// 获取之前保存的仓位
async function getPreviousPositions(endpoint, projectId, apiKey, databaseId, collectionId, log) {
  try {
    const client = new Client()
      .setEndpoint(endpoint)
      .setProject(projectId)
      .setKey(apiKey);

    const databases = new Databases(client);

    const documents = await databases.listDocuments(databaseId, collectionId);
    
    if (documents.documents.length > 0) {
      // 按时间排序，获取最新的
      const latestDoc = documents.documents.sort((a, b) => 
        new Date(b.timestamp) - new Date(a.timestamp)
      )[0];
      
      log('Found previous positions document:', latestDoc.$id);
      return JSON.parse(latestDoc.positions_json);
    }
    
    log('No previous positions found');
    return {};
  } catch (err) {
    log('Error getting previous positions:', err.message);
    return {};
  }
}

// 保存当前仓位
async function saveCurrentPositions(endpoint, projectId, apiKey, databaseId, collectionId, positions, log) {
  try {
    const client = new Client()
      .setEndpoint(endpoint)
      .setProject(projectId)
      .setKey(apiKey);

    const databases = new Databases(client);

    // 删除旧记录（只保留最新的）
    const documents = await databases.listDocuments(databaseId, collectionId);
    for (const doc of documents.documents) {
      await databases.deleteDocument(databaseId, collectionId, doc.$id);
      log('Deleted old document:', doc.$id);
    }

    // 创建新记录
    const newDoc = await databases.createDocument(
      databaseId,
      collectionId,
      'unique()',
      {
        positions_json: JSON.stringify(positions),
        timestamp: new Date().toISOString()
      }
    );
    
    log('Saved new positions document:', newDoc.$id);
  } catch (err) {
    log('Error saving positions:', err.message);
    throw err;
  }
}