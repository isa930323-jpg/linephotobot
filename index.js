const express = require('express');
const line = require('@line/bot-sdk');
const cloudinary = require('cloudinary').v2;
const path = require('path');
const basicAuth = require('express-basic-auth');
const { MongoClient, ObjectId } = require('mongodb');
const cors = require('cors');

const app = express();

// ===== 設定 =====
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));
app.options('*', cors());

// ===== Instagram 設定 =====
const IG_VERIFY_TOKEN = process.env.IG_VERIFY_TOKEN || 'your_verify_token_here';
const IG_ACCESS_TOKEN = process.env.IG_ACCESS_TOKEN;

// Instagram 使用者暫存照片
const igUserTempPhotos = new Map();

// ===== LINE 設定 =====
const config = {
  channelAccessToken: process.env.LINE_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET,
};

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_NAME,
  api_key: process.env.CLOUDINARY_KEY,
  api_secret: process.env.CLOUDINARY_SECRET
});

const client = new line.Client(config);

// ===== MongoDB 設定 =====
const mongoUri = process.env.MONGODB_URI || 'mongodb://localhost:27017/line_bot';
const mongoClient = new MongoClient(mongoUri);
let db;
let messagesCollection;
let photosCollection;

async function connectMongo() {
  // ... 保持原樣
}

// ===== 認證中間件 =====
const authMiddleware = basicAuth({
    users: { [process.env.WEB_USER]: process.env.WEB_PASS },
    challenge: true,
    realm: 'MyLineAlbum'
});

// ===== 標籤設定 =====
const ALLOWED_TAGS = ['#碳盤查', '#永續', '#淨零', '#生活', '#鹿角蕨', '#積水鳳梨', '#植物'];

function extractAndFilterTags(text) {
  // ... 保持原樣
}

// ===== 資料庫操作函數 =====
async function saveMessageToDB(message) { /* ... */ }
async function getMessagesFromDB(limit = 100, tag = null) { /* ... */ }
async function deleteMessageFromDB(messageId) { /* ... */ }
async function clearAllMessagesFromDB() { /* ... */ }
async function savePhotoToDB(photo) { /* ... */ }
async function deletePhotoFromDB(photoId) { /* ... */ }
async function clearAllPhotosFromDB() { /* ... */ }

// ===== LINE 核心邏輯 =====
const userTempPhotos = new Map();

// ===== Instagram 函數（必須放在 handleEvent 之前或之後，不能放在裡面）=====

// 發送 Instagram 訊息
async function sendInstagramMessage(recipientId, text) {
  if (!IG_ACCESS_TOKEN) {
    console.log('⚠️ 未設定 IG_ACCESS_TOKEN，無法發送回覆');
    return;
  }
  
  try {
    const url = `https://graph.facebook.com/v22.0/me/messages?access_token=${IG_ACCESS_TOKEN}`;
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        recipient: { id: recipientId },
        message: { text: text }
      })
    });
    
    const result = await response.json();
    console.log('📤 Instagram 回覆發送:', result);
  } catch (error) {
    console.error('發送 Instagram 訊息失敗:', error);
  }
}

// 處理 Instagram 圖片
async function handleInstagramImage(senderId, imageUrl, event) {
  try {
    const response = await fetch(imageUrl);
    const buffer = await response.buffer();
    
    const uploadResult = await new Promise((resolve, reject) => {
      const uploadStream = cloudinary.uploader.upload_stream(
        { folder: 'instagram_uploads' },
        (error, result) => {
          if (error) reject(error);
          else resolve(result);
        }
      );
      uploadStream.end(buffer);
    });
    
    if (igUserTempPhotos.has(senderId)) {
      await savePhotoToDB({
        id: uploadResult.public_id,
        url: uploadResult.secure_url,
        userId: senderId,
        displayName: 'Instagram',
        platform: 'instagram',
        timestamp: new Date().toISOString(),
        type: 'photo'
      });
      
      await sendInstagramMessage(senderId, '📸 照片已儲存到相簿！\n\n📌 因為你連續上傳照片，這張直接進相簿。');
      
    } else {
      const timeoutId = setTimeout(async () => {
        if (igUserTempPhotos.has(senderId)) {
          const tempPhoto = igUserTempPhotos.get(senderId);
          console.log(`⏰ Instagram 照片超時，自動存入相簿: ${tempPhoto.publicId}`);
          
          await savePhotoToDB({
            id: tempPhoto.publicId,
            url: tempPhoto.photoUrl,
            userId: senderId,
            displayName: 'Instagram',
            platform: 'instagram',
            timestamp: new Date().toISOString(),
            type: 'photo'
          });
          
          igUserTempPhotos.delete(senderId);
        }
      }, 300000);
      
      igUserTempPhotos.set(senderId, {
        photoUrl: uploadResult.secure_url,
        publicId: uploadResult.public_id,
        timeoutId: timeoutId,
        timestamp: Date.now()
      });
      
      await sendInstagramMessage(senderId, '🖼️ 照片已接收！\n\n✅ 5分鐘內輸入文字 → 圖文隨筆\n⏰ 超過5分鐘 → 自動存入相簿');
    }
    
  } catch (error) {
    console.error('處理 Instagram 圖片失敗:', error);
  }
}

// 處理 Instagram 事件
async function handleInstagramEvent(event) {
  const senderId = event.sender.id;
  const message = event.message;
  
  if (!message) return;
  
  // 處理圖片
  if (message.attachments && message.attachments.length > 0) {
    for (const attachment of message.attachments) {
      if (attachment.type === 'image') {
        const imageUrl = attachment.payload.url;
        await handleInstagramImage(senderId, imageUrl, event);
      }
    }
  }
  
  // 處理文字
  if (message.text) {
    const text = message.text;
    const tags = extractAndFilterTags(text);
    
    if (igUserTempPhotos.has(senderId)) {
      const tempPhoto = igUserTempPhotos.get(senderId);
      
      if (tempPhoto.timeoutId) {
        clearTimeout(tempPhoto.timeoutId);
      }
      igUserTempPhotos.delete(senderId);
      
      const messageData = {
        id: event.timestamp.toString(),
        text: text,
        imageUrl: tempPhoto.photoUrl,
        imagePublicId: tempPhoto.publicId,
        userId: senderId,
        displayName: 'Instagram',
        platform: 'instagram',
        timestamp: new Date().toISOString(),
        type: 'message_with_photo',
        tags: tags
      };
      
      await saveMessageToDB(messageData);
      await sendInstagramMessage(senderId, `📝 圖文隨筆已儲存！\n🏷️ 標籤：${tags.length > 0 ? tags.join('、') : '無'}`);
      
    } else {
      const messageData = {
        id: event.timestamp.toString(),
        text: text,
        userId: senderId,
        displayName: 'Instagram',
        platform: 'instagram',
        timestamp: new Date().toISOString(),
        type: 'text_only',
        tags: tags
      };
      
      await saveMessageToDB(messageData);
      await sendInstagramMessage(senderId, `📝 純文字隨筆已儲存！\n💡 先傳照片再傳文字，可發圖文隨筆`);
    }
  }
}

// ===== LINE handleEvent 函數 =====
async function handleEvent(event) {
  // 處理圖片訊息
  if (event.type === 'message' && event.message.type === 'image') {
    // ... 保持你原來的 LINE 圖片處理邏輯
  }
  
  // 處理文字訊息
  if (event.type === 'message' && event.message.type === 'text') {
    // ... 保持你原來的 LINE 文字處理邏輯
  }
  
  // 其他訊息
  if (event.type === 'message') {
    await client.replyMessage(event.replyToken, {
      type: 'text',
      text: '目前只支援圖片和文字訊息喔！'
    });
  }
  
  return null;
}

// ===== 路由 =====
app.get('/health', (req, res) => res.status(200).send('I am alive!'));

// Instagram Webhook 驗證（GET）
app.get('/instagram/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const challenge = req.query['hub.challenge'];
  const verifyToken = req.query['hub.verify_token'];

  console.log(`🔍 Instagram 驗證請求: mode=${mode}, token=${verifyToken}, 預期=${IG_VERIFY_TOKEN}`);

  if (mode === 'subscribe' && verifyToken === IG_VERIFY_TOKEN) {
    console.log('✅ Instagram Webhook 驗證成功');
    res.status(200).send(challenge);
  } else {
    console.log('❌ Instagram Webhook 驗證失敗');
    res.status(403).send('驗證失敗');
  }
});

// Instagram Webhook 接收事件（POST）
app.post('/instagram/webhook', async (req, res) => {
  console.log('📨 Instagram Webhook 收到事件');
  res.status(200).send('OK');
  
  try {
    const entries = req.body.entry || [];
    for (const entry of entries) {
      const messaging = entry.messaging || [];
      for (const event of messaging) {
        await handleInstagramEvent(event);
      }
    }
  } catch (error) {
    console.error('處理 Instagram 事件失敗:', error);
  }
});

// LINE Callback
app.post('/callback', line.middleware(config), (req, res) => {
  Promise.all(req.body.events.map(handleEvent))
    .then((result) => res.json(result))
    .catch((err) => { 
      console.error(err); 
      res.status(500).end(); 
    });
});

// 測試 Instagram 訊息發送
app.post('/api/test-ig-message', authMiddleware, async (req, res) => {
  const { userId, text } = req.body;
  if (!userId || !text) {
    return res.status(400).json({ error: '需要 userId 和 text' });
  }
  
  await sendInstagramMessage(userId, text);
  res.json({ success: true, message: '已發送' });
});

// ... 其他原有的路由（靜態檔案、API 等）

// 啟動伺服器
const PORT = process.env.PORT || 10000;

connectMongo().then(() => {
  app.listen(PORT, () => {
    console.log(`🚀 Server running on port ${PORT}`);
    console.log(`🔑 IG_VERIFY_TOKEN 已設定: ${IG_VERIFY_TOKEN !== 'your_verify_token_here' ? '是' : '否（使用預設值）'}`);
  });
});
