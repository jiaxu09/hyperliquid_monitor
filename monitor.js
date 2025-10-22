// index.js for Appwrite Function (Final Version with SDK Bug Workaround)

const { Client, Databases, ID, Query } = require('node-appwrite');
const axios = require('axios');
const nodemailer = require('nodemailer');
const { ethers } = require('ethers');

// ============================================================================
// --- 辅助函数 (No changes needed here) ---
// ============================================================================
function comparePositions(previous, current, address) { /* ... same as before ... */ }
function formatEmailMessage(title, coin, pos, address, isClose = false, prevPos = null) { /* ... same as before ... */ }
async function sendEmailNotification(transporter, subject, htmlBody, sender, receiver, log, error) { /* ... same as before ... */ }

// ============================================================================
// --- Appwrite Function Entrypoint ---
// ============================================================================
module.exports = async (context) => {
    const { res, log, error } = context;

    // --- 1. Load Environment Variables ---
    const TARGET_ADDRESS = '0xb317D2BC2D3d2Df5Fa441B5bAE0AB9d8b07283ae';
    const SENDER_EMAIL = 'jiaxu99.w@gmail.com';
    const APP_PASSWORD = 'hqmv qwbm qpik juiq';
    const RECEIVER_EMAIL = 'jiaxu99.w@gmail.com';
    const APPWRITE_DATABASE_ID = '68f83b0400132c94d002';
    const APPWRITE_COLLECTION_ID = 'hyperliquidstates';
    const APPWRITE_ENDPOINT = 'https://syd.cloud.appwrite.io/v1';
    const APPWRITE_PROJECT_ID = '68f83a530002fd707c12';
    const APPWRITE_API_KEY = 'standard_7ed5da113991e48205f5b2b34825efc512795358d933080c96a22b5980a23ded1e49f7bb868cc0c68e1e74294213a99162e5fe1c55520c02741b52a2b67d48838fd33135566177ce3652daac8bfb1c01286c4f26d8e5daeab888b2cd050daa7313461b3b0974cc999a8dcca03aaddbfe1e35d784f81be0699fe6b9082690fa02';

    // --- 2. Initialize Appwrite Client ---
    const client = new Client()
        .setEndpoint(APPWRITE_ENDPOINT)
        .setProject(APPWRITE_PROJECT_ID)
        .setKey(APPWRITE_API_KEY);
    
    const databases = new Databases(client);

    // --- 3. Core Logic ---
    try {
        if (!TARGET_ADDRESS) {
            throw new Error("Environment variable TARGET_ADDRESS is not set.");
        }

        const checksumAddress = ethers.getAddress(TARGET_ADDRESS);
        log(`Monitoring checksum address: ${checksumAddress}`);

        let previousPositions = {};
        let documentId = null;

        // ========================================================================
        // [BUGFIX] Avoid using the 'queries' parameter to prevent the SDK bug.
        // Fetch all documents and filter them in the function's code instead.
        // ========================================================================
        const allDocumentsResponse = await databases.listDocuments(
            APPWRITE_DATABASE_ID,
            APPWRITE_COLLECTION_ID
        );

        const document = allDocumentsResponse.documents.find(doc => doc.user_address === checksumAddress);

        if (document) {
            documentId = document.$id;
            if (document.positions_json && document.positions_json.trim() !== '') {
                previousPositions = JSON.parse(document.positions_json);
            }
            log('Successfully found and fetched previous state from DB.');
        } else {
            log('No previous state found for this address. Will create a new record.');
        }
        // ========================================================================
        // End of Bugfix
        // ========================================================================

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
                        liquidationPx: pos.position.liquidationPx ? parseFloat(pos.position.liquidationPx) : null,
                        marginUsed: parseFloat(pos.position.marginUsed)
                    };
                }
            });
        }
        log('Successfully fetched current state from Hyperliquid API.');

        const notifications = comparePositions(previousPositions, currentPositions, checksumAddress);
        if (notifications.length > 0) {
            log(`Found ${notifications.length} position changes. Sending notifications...`);
            const transporter = nodemailer.createTransport({
                service: 'gmail',
                auth: { user: SENDER_EMAIL, pass: APP_PASSWORD }
            });
            for (const notification of notifications) {
                await sendEmailNotification(transporter, notification.subject, notification.htmlBody, SENDER_EMAIL, RECEIVER_EMAIL, log, error);
            }
        } else {
            log('No position changes detected.');
        }

        const newPositionsJson = JSON.stringify(currentPositions);
        if (documentId) {
            await databases.updateDocument(APPWRITE_DATABASE_ID, APPWRITE_COLLECTION_ID, documentId, {
                positions_json: newPositionsJson
            });
            log('Updated existing state in DB.');
        } else {
            await databases.createDocument(APPWRITE_DATABASE_ID, APPWRITE_COLLECTION_ID, ID.unique(), {
                user_address: checksumAddress,
                positions_json: newPositionsJson
            });
            log('Created new state record in DB.');
        }

        log('Execution finished successfully.');
        return res.empty();

    } catch (err) {
        error(`Execution failed: ${err.stack}`);
        return res.send(err.message, 500);
    }
};

// --- Helper Functions (pasted here for completeness) ---
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
    
    const liquidationPrice = pos.liquidationPx ? `$${pos.liquidationPx}` : 'N/A';

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
                <li><strong>Liquidation Price:</strong> ${liquidationPrice}</li>
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