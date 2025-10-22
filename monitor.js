// index.js for Appwrite Function (Final Version)

const { Client, Databases, ID, Query } = require('node-appwrite');
const axios = require('axios');
const nodemailer = require('nodemailer');
const { ethers } = require('ethers');

// Appwrite Function的入口函数 - 使用新的 context 签名
module.exports = async (context) => {
    const { res, log, error } = context;

    // =========================================================================
    // --- 环境变量配置 (在Appwrite Function设置中配置) ---
    // =========================================================================
    const TARGET_ADDRESS = process.env.TARGET_ADDRESS;
    const SENDER_EMAIL = process.env.SENDER_EMAIL;
    const APP_PASSWORD = process.env.APP_PASSWORD;
    const RECEIVER_EMAIL = process.env.RECEIVER_EMAIL;
    const APPWRITE_DATABASE_ID = process.env.APPWRITE_DATABASE_ID;
    const APPWRITE_COLLECTION_ID = process.env.APPWRITE_COLLECTION_ID;
    // =========================================================================

    // --- 初始化Appwrite客户端 ---
    // Appwrite会自动注入这些环境变量，无需手动设置
    const client = new Client()
        .setEndpoint(process.env.APPWRITE_ENDPOINT)
        .setProject(process.env.APPWRITE_PROJECT_ID)
        .setKey(process.env.APPWRITE_API_KEY);
    
    const databases = new Databases(client);

    // --- 核心逻辑 ---
    try {
        // 1. 验证并转换地址为校验和格式 (解决422错误)
        const checksumAddress = ethers.getAddress(TARGET_ADDRESS);
        log(`Monitoring checksum address: ${checksumAddress}`);

        // 2. 从Appwrite DB获取上一次的仓位状态
        let previousPositions = {};
        let documentId = null;

        // 在集合中为每个监控地址创建一个唯一的文档ID
        // 我们可以使用地址本身作为文档ID，但需要处理'0x'前缀和长度限制
        // 一个更稳健的方法是查询
        const queryResponse = await databases.listDocuments(
            APPWRITE_DATABASE_ID,
            APPWRITE_COLLECTION_ID,
            [Query.equal('user_address', checksumAddress)]
        );

        if (queryResponse.total > 0) {
            const document = queryResponse.documents[0];
            documentId = document.$id;
            // 确保 positions_json 存在且不为空
            if (document.positions_json && document.positions_json.trim() !== '') {
                previousPositions = JSON.parse(document.positions_json);
            }
            log('Successfully fetched previous state from DB.');
        } else {
            log('No previous state found for this address. Will create a new record.');
        }

        // 3. 从Hyperliquid API获取当前仓位状态
        const apiResponse = await axios.post('https://api.hyperliquid.xyz/info', {
            type: 'userState',
            user: checksumAddress
        });

        const assetPositions = apiResponse.data.assetPositions;
        const currentPositions = {};
        if (assetPositions && assetPositions.length > 0) {
            assetPositions.forEach(pos => {
                if (pos.position && parseFloat(pos.position.szi) !== 0) {
                    const coin = pos.position.coin;
                    currentPositions[coin] = {
                        szi: parseFloat(pos.position.szi),
                        entryPx: parseFloat(pos.position.entryPx),
                        liquidationPx: parseFloat(pos.position.liquidationPx),
                        marginUsed: parseFloat(pos.position.marginUsed)
                    };
                }
            });
        }
        log('Successfully fetched current state from Hyperliquid API.');

        // 4. 比较新旧状态并发送通知
        const notifications = comparePositions(previousPositions, currentPositions, checksumAddress);
        if (notifications.length > 0) {
            log(`Found ${notifications.length} position changes. Sending notifications...`);
            const transporter = nodemailer.createTransport({
                service: 'gmail',
                auth: { user: SENDER_EMAIL, pass: APP_PASSWORD.replace(/\s/g, '') }
            });
            for (const notification of notifications) {
                await sendEmailNotification(transporter, notification.subject, notification.htmlBody, SENDER_EMAIL, RECEIVER_EMAIL, log, error);
            }
        } else {
            log('No position changes detected.');
        }

        // 5. 将当前状态保存回Appwrite DB
        const newPositionsJson = JSON.stringify(currentPositions);
        if (documentId) {
            await databases.updateDocument(APPWRITE_DATABASE_ID, APPWRITE_COLLECTION_ID, documentId, {
                positions_json: newPositionsJson
            });
            log('Updated existing state in DB.');
        } else {
            // 为集合添加一个 user_address 属性以供查询
            await databases.createDocument(APPWRITE_DATABASE_ID, APPWRITE_COLLECTION_ID, ID.unique(), {
                user_address: checksumAddress,
                positions_json: newPositionsJson
            });
            log('Created new state record in DB.');
        }

        return res.json({ success: true, message: 'Check complete.' });

    } catch (err) {
        error(`Execution failed: ${err.message}`);
        return res.json({ success: false, error: err.message }, 500);
    }
};

// --- 辅助函数 ---

function comparePositions(previous, current, address) {
    const notifications = [];
    const allCoins = new Set([...Object.keys(previous), ...Object.keys(current)]);

    allCoins.forEach(coin => {
        const prev = previous[coin];
        const curr = current[coin];
        let notificationData = null;

        if (!prev && curr) {
            notificationData = formatEmailMessage('🚀 New Position Opened', coin, curr, address);
        } else if (prev && !curr) {
            notificationData = formatEmailMessage('✅ Position Closed', coin, prev, address, true);
        } else if (prev && curr && prev.szi !== curr.szi) {
            if (Math.abs(curr.szi) > Math.abs(prev.szi)) {
                notificationData = formatEmailMessage('➕ Position Increased', coin, curr, address, false, prev);
            } else {
                notificationData = formatEmailMessage('➖ Position Decreased', coin, curr, address, false, prev);
            }
        }
        if (notificationData) {
            notifications.push(notificationData);
        }
    });
    return notifications;
}

function formatEmailMessage(title, coin, pos, address, isClose = false, prevPos = null) {
    const positionType = pos.szi > 0 ? 'LONG' : 'SHORT';
    const size = Math.abs(pos.szi).toFixed(4);
    const subject = `Hyperliquid Alert: ${title} - ${coin}`;

    let changeText = '';
    if (prevPos) {
        const prevSize = Math.abs(prevPos.szi).toFixed(4);
        const change = (Math.abs(pos.szi) - Math.abs(prevPos.szi)).toFixed(4);
        changeText = `
            <li><strong>Previous Size:</strong> ${prevSize} ${coin}</li>
            <li><strong>Change:</strong> ${change} ${coin}</li>
        `;
    }

    const htmlBody = `
        <div style="font-family: sans-serif; line-height: 1.6;">
            <h2 style="color: #333;">${subject}</h2>
            <p>A position change was detected for address: <strong>${address}</strong></p>
            <hr>
            <ul style="list-style-type: none; padding: 0;">
                <li><strong>Action:</strong> ${title}</li>
                <li><strong>Asset:</strong> ${coin}</li>
                <li><strong>Direction:</strong> ${positionType}</li>
                <li><strong>Current Size:</strong> ${size} ${coin}</li>
                ${changeText}
                <li><strong>Entry Price:</strong> $${pos.entryPx}</li>
                <li><strong>Liquidation Price:</strong> $${pos.liquidationPx || 'N/A'}</li>
                <li><strong>Margin Used:</strong> $${pos.marginUsed.toFixed(2)}</li>
            </ul>
            <hr>
            <p style="font-size: 12px; color: #888;">This is an automated notification from your Appwrite Function.</p>
        </div>
    `;
    return { subject, htmlBody };
}

async function sendEmailNotification(transporter, subject, htmlBody, sender, receiver, log, error) {
    const mailOptions = {
        from: `"Hyperliquid Monitor" <${sender}>`,
        to: receiver,
        subject: subject,
        html: htmlBody
    };
    try {
        await transporter.sendMail(mailOptions);
        log(`Email notification sent: ${subject}`);
    } catch (err) {
        error(`Error sending email: ${err.message}`);
    }
}