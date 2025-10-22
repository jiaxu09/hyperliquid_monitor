# hyperliquid_monitor
const TARGET_ADDRESS = '0xb317D2BC2D3d2Df5Fa441B5bAE0AB9d8b07283ae';
    const SENDER_EMAIL = 'jiaxu99.w@gmail.com';
    const APP_PASSWORD = 'hqmv qwbm qpik juiq';
    const RECEIVER_EMAIL = 'jiaxu99.w@gmail.com';
    const APPWRITE_DATABASE_ID = '68f83b0400132c94d002';
    const APPWRITE_COLLECTION_ID = 'hyperliquidstates';
    const APPWRITE_ENDPOINT = 'https://syd.cloud.appwrite.io/v1';
    const APPWRITE_PROJECT_ID = '68f83a530002fd707c12';
    const APPWRITE_API_KEY = 'standard_7ed5da113991e48205f5b2b34825efc512795358d933080c96a22b5980a23ded1e49f7bb868cc0c68e1e74294213a99162e5fe1c55520c02741b52a2b67d48838fd33135566177ce3652daac8bfb1c01286c4f26d8e5daeab888b2cd050daa7313461b3b0974cc999a8dcca03aaddbfe1e35d784f81be0699fe6b9082690fa02';
------
const HYPERLIQUID_ADDRESS = process.env.TARGET_ADDRESS;
    const GMAIL_USER = process.env.SENDER_EMAIL;
    const GMAIL_APP_PASSWORD = process.env.APP_PASSWORD;
    const NOTIFY_EMAIL = process.env.RECEIVER_EMAIL;
    const APPWRITE_ENDPOINT = process.env.APPWRITE_ENDPOINT || 'https://cloud.appwrite.io/v1';
    const APPWRITE_PROJECT_ID = process.env.APPWRITE_PROJECT_ID;
    const APPWRITE_API_KEY = process.env.APPWRITE_API_KEY;
    const DATABASE_ID = process.env.APPWRITE_DATABASE_ID;
    const COLLECTION_ID = process.env.APPWRITE_COLLECTION_ID;