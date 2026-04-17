const express = require('express');
const line = require('@line/bot-sdk');
// ===== Instagram 設定 =====
const IG_VERIFY_TOKEN = process.env.IG_VERIFY_TOKEN || 'your_verify_token_here';
const IG_ACCESS_TOKEN = process.env.IG_ACCESS_TOKEN;

// Instagram 使用者暫存照片（比照 LINE 的邏輯）
const igUserTempPhotos = new Map();
const cloudinary = require('cloudinary').v2;
const path = require('path');
const basicAuth = require('express-basic-auth');
const { MongoClient, ObjectId } = require('mongodb');
const cors = require('cors');

const app = express();

app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));
app.options('*', cors());

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

const mongoUri = process.env.MONGODB_URI || 'mongodb://localhost:27017/line_bot';
const mongoClient = new MongoClient(mongoUri);
let db;
let messagesCollection;
let photosCollection;

async function connectMongo() {
  try {
    await mongoClient.connect();
    db = mongoClient.db('line_bot');
    messagesCollection = db.collection('messages');
    photosCollection = db.collection('photos');
    
    await messagesCollection.createIndex({ timestamp: -1 });
    await messagesCollection.createIndex({ userId: 1 });
    await messagesCollection.createIndex({ tags: 1 });
    await photosCollection.createIndex({ timestamp: -1 });
    await photosCollection.createIndex({ userId: 1 });
    
    console.log('✅ MongoDB 連接成功');
  } catch (error) {
    console.error('❌ MongoDB 連接失敗:', error);
    process.exit(1);
  }
}

const authMiddleware = basicAuth({
    users: { [process.env.WEB_USER]: process.env.WEB_PASS },
    challenge: true,
    realm: 'MyLineAlbum'
});

const ALLOWED_TAGS = ['#碳盤查', '#永續', '#淨零', '#生活', '#鹿角蕨', '#積水鳳梨', '#植物'];

function extractAndFilterTags(text) {
  const tagRegex = /#[\u4e00-\u9fa5a-zA-Z0-9]+/g;
  const matches = text.match(tagRegex);
  if (!matches) return [];
  const filteredTags = matches.filter(tag => ALLOWED_TAGS.includes(tag));
  return [...new Set(filteredTags)];
}

async function saveMessageToDB(message) {
  try {
    const result = await messagesCollection.insertOne(message);
    return result;
  } catch (error) {
    console.error('儲存隨筆失敗:', error);
    throw error;
  }
}

async function getMessagesFromDB(limit = 100, tag = null) {
  try {
    let query = {};
    if (tag) {
      query = { tags: tag };
    }
    const messages = await messagesCollection
      .find(query)
      .sort({ timestamp: -1 })
      .limit(limit)
      .toArray();
    return messages;
  } catch (error) {
    console.error('讀取隨筆失敗:', error);
    return [];
  }
}

async function deleteMessageFromDB(messageId) {
  try {
    let query = { id: messageId };
    if (ObjectId.isValid(messageId)) {
      query = { $or: [{ id: messageId }, { _id: new ObjectId(messageId) }] };
    }
    const result = await messagesCollection.deleteOne(query);
    return result.deletedCount > 0;
  } catch (error) {
    console.error('刪除隨筆失敗:', error);
    return false;
  }
}

async function clearAllMessagesFromDB() {
  try {
    const result = await messagesCollection.deleteMany({});
    return result.deletedCount;
  } catch (error) {
    console.error('清除所有隨筆失敗:', error);
    throw error;
  }
}

async function savePhotoToDB(photo) {
  try {
    const result = await photosCollection.insertOne(photo);
    return result;
  } catch (error) {
    console.error('儲存照片失敗:', error);
    throw error;
  }
}

async function deletePhotoFromDB(photoId) {
  try {
    let query = { id: photoId };
    if (ObjectId.isValid(photoId)) {
      query = { $or: [{ id: photoId }, { _id: new ObjectId(photoId) }] };
    }
    const result = await photosCollection.deleteOne(query);
    return result.deletedCount > 0;
  } catch (error) {
    console.error('刪除照片失敗:', error);
    return false;
  }
}

async function clearAllPhotosFromDB() {
  try {
    const result = await photosCollection.deleteMany({});
    return result.deletedCount;
  } catch (error) {
    console.error('清除所有照片失敗:', error);
    throw error;
  }
}

app.get('/health', (req, res) => res.status(200).send('I am alive!'));
// ===== Instagram Webhook 驗證（GET）=====
app.get('/instagram/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const challenge = req.query['hub.challenge'];
  const verifyToken = req.query['hub.verify_token'];

  if (mode === 'subscribe' && verifyToken === IG_VERIFY_TOKEN) {
    console.log('✅ Instagram Webhook 驗證成功');
    res.status(200).send(challenge);
  } else {
    console.log('❌ Instagram Webhook 驗證失敗');
    res.status(403).send('驗證失敗');
  }
});// ===== Instagram Webhook 接收事件（POST）=====
app.post('/instagram/webhook', async (req, res) => {
  console.log('📨 Instagram Webhook 收到:', JSON.stringify(req.body, null, 2));
  
  // 立即回傳 200，避免 IG 重送
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

app.post('/callback', line.middleware(config), (req, res) => {
  Promise.all(req.body.events.map(handleEvent))
    .then((result) => res.json(result))
    .catch((err) => { 
      console.error(err); 
      res.status(500).end(); 
    });
});

app.use(express.static(path.join(__dirname, 'public')));

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/messages', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'messages.html'));
});

app.get('/admin', authMiddleware, (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

// ===== 相簿 API - 直接從 Cloudinary 讀取所有照片（原來的邏輯）=====
app.get('/api/images', async (req, res) => {
  try {
    const { cursor } = req.query;
    const query = cloudinary.search
      .expression('folder:line_uploads')
      .sort_by('created_at', 'desc')
      .max_results(8);

    if (cursor) query.next_cursor(cursor);

    const result = await query.execute();
    res.json({
      images: result.resources.map(img => ({ 
        url: img.secure_url, 
        time: img.created_at, 
        public_id: img.public_id 
      })),
      nextCursor: result.next_cursor
    });
  } catch (error) { 
    console.error('讀取照片失敗:', error);
    res.status(500).send(error.message); 
  }
});

app.get('/api/messages', async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 100;
    const tag = req.query.tag;
    const messages = await getMessagesFromDB(limit, tag);
    res.json(messages);
  } catch (error) {
    console.error('讀取隨筆失敗:', error);
    res.status(500).send(error.message);
  }
});

app.delete('/api/images', authMiddleware, async (req, res) => {
    try {
        await cloudinary.uploader.destroy(req.query.id);
        await deletePhotoFromDB(req.query.id);
        res.json({ success: true });
    } catch (error) { 
        console.error('刪除照片失敗:', error);
        res.status(500).send(error.message); 
    }
});

app.delete('/api/messages/:id', authMiddleware, async (req, res) => {
    try {
        const success = await deleteMessageFromDB(req.params.id);
        if (success) {
            res.json({ success: true });
        } else {
            res.status(404).json({ success: false, message: '隨筆不存在' });
        }
    } catch (error) { 
        console.error('刪除隨筆失敗:', error);
        res.status(500).send(error.message); 
    }
});

app.delete('/api/messages', authMiddleware, async (req, res) => {
    try {
        const deletedCount = await clearAllMessagesFromDB();
        res.json({ success: true, deletedCount });
    } catch (error) { 
        console.error('清除所有隨筆失敗:', error);
        res.status(500).send(error.message); 
    }
});

app.delete('/api/all-photos', authMiddleware, async (req, res) => {
    try {
        const deletedCount = await clearAllPhotosFromDB();
        res.json({ success: true, deletedCount });
    } catch (error) { 
        console.error('清除所有照片失敗:', error);
        res.status(500).send(error.message); 
    }
});

// ===== 核心邏輯：暫存照片，超時自動存相簿 =====
const userTempPhotos = new Map();

async function handleEvent(event) {
  // 處理圖片訊息
  if (event.type === 'message' && event.message.type === 'image') {
    const stream = await client.getMessageContent(event.message.id);
    const userId = event.source.userId;
    
    return new Promise((resolve, reject) => {
      const cloudinaryStream = cloudinary.uploader.upload_stream(
        { folder: 'line_uploads' },
        async (error, result) => {
          if (error) {
            console.error('上傳圖片失敗:', error);
            return reject(error);
          }
          
          // 檢查是否有暫存的照片（連續傳多張）
          if (userTempPhotos.has(userId)) {
            // 已有暫存照片 → 直接存相簿（不等待文字）
            await savePhotoToDB({
              id: result.public_id,
              url: result.secure_url,
              userId: userId,
              displayName: 'FernBrom',
              timestamp: new Date().toISOString(),
              type: 'photo'
            });
            
            await client.replyMessage(event.replyToken, {
              type: 'text',
              text: '📸 照片已儲存到相簿！\n\n📌 因為你連續上傳照片，這張直接進相簿。\n如果要發圖文隨筆，請先傳一張照片，再輸入文字。'
            });
          } else {
            // 暫存照片，等待文字（5分鐘內）
            const timeoutId = setTimeout(async () => {
              // 超時後，如果還有這張照片，自動存到相簿
              if (userTempPhotos.has(userId)) {
                const tempPhoto = userTempPhotos.get(userId);
                console.log(`⏰ 照片超時，自動存入相簿: ${tempPhoto.publicId}`);
                
                await savePhotoToDB({
                  id: tempPhoto.publicId,
                  url: tempPhoto.photoUrl,
                  userId: userId,
                  displayName: 'FernBrom',
                  timestamp: new Date().toISOString(),
                  type: 'photo'
                });
                
                userTempPhotos.delete(userId);
              }
            }, 300000); // 5分鐘
            
            userTempPhotos.set(userId, {
              photoUrl: result.secure_url,
              publicId: result.public_id,
              timeoutId: timeoutId,
              timestamp: Date.now()
            });
            
            await client.replyMessage(event.replyToken, {
              type: 'text',
              text: '🖼️ 照片已接收！\n\n📌 【圖文隨筆】使用說明：\n━━━━━━━━━━━━━━━━\n✅ 5分鐘內輸入文字 → 變成「圖文隨筆」\n   （這張照片也會出現在相簿）\n\n⏰ 超過5分鐘沒打字 → 自動存入「相簿」\n\n📸 連續傳多張照片 → 全部進「相簿」\n\n💬 只傳文字 → 純文字隨筆\n━━━━━━━━━━━━━━━━\n\n✨ 現在輸入文字，就能完成圖文隨筆！'
            });
          }
          resolve(result);
        }
      );
      stream.pipe(cloudinaryStream);
    });
  }
  // ===== 處理 Instagram 事件 =====
async function handleInstagramEvent(event) {
  const senderId = event.sender.id;
  const message = event.message;
  
  if (!message) return;
  
  // 處理圖片訊息
  if (message.attachments && message.attachments.length > 0) {
    for (const attachment of message.attachments) {
      if (attachment.type === 'image') {
        const imageUrl = attachment.payload.url;
        await handleInstagramImage(senderId, imageUrl, event);
      }
    }
  }
  
  // 處理文字訊息
  if (message.text) {
    const text = message.text;
    const tags = extractAndFilterTags(text);
    
    // 檢查是否有暫存的照片
    if (igUserTempPhotos.has(senderId)) {
      // 有暫存照片 → 儲存為圖文隨筆（文字+照片）
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
      console.log(`📝 Instagram 圖文隨筆已儲存: ${text.substring(0, 50)}`);
      
      // 回覆確認（選用，IG 私訊回覆需要發送 API）
      await sendInstagramMessage(senderId, `📝 圖文隨筆已儲存！\n🏷️ 標籤：${tags.length > 0 ? tags.join('、') : '無效標籤'}`);
      
    } else {
      // 沒有暫存照片 → 純文字隨筆
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
      console.log(`📝 Instagram 純文字隨筆已儲存: ${text.substring(0, 50)}`);
      
      await sendInstagramMessage(senderId, `📝 純文字隨筆已儲存！\n💡 提示：先傳照片再傳文字，可以發圖文隨筆喔！\n🏷️ 有效標籤：#碳盤查 #永續 #淨零 #生活 #鹿角蕨 #積水鳳梨 #植物`);
    }
  }
}

// ===== 處理 Instagram 圖片 =====
async function handleInstagramImage(senderId, imageUrl, event) {
  try {
    // 下載圖片並上傳到 Cloudinary
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
    
    // 檢查是否有暫存的照片
    if (igUserTempPhotos.has(senderId)) {
      // 連續傳多張 → 直接存相簿
      await savePhotoToDB({
        id: uploadResult.public_id,
        url: uploadResult.secure_url,
        userId: senderId,
        displayName: 'Instagram',
        platform: 'instagram',
        timestamp: new Date().toISOString(),
        type: 'photo'
      });
      
      await sendInstagramMessage(senderId, '📸 照片已儲存到相簿！\n\n📌 因為你連續上傳照片，這張直接進相簿。\n如果要發圖文隨筆，請先傳一張照片，再輸入文字。');
      
    } else {
      // 暫存照片，等待文字（5分鐘）
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
      
      await sendInstagramMessage(senderId, '🖼️ 照片已接收！\n\n📌 【圖文隨筆】使用說明：\n✅ 5分鐘內輸入文字 → 變成「圖文隨筆」\n⏰ 超過5分鐘沒打字 → 自動存入「相簿」\n📸 連續傳多張照片 → 全部進「相簿」\n\n✨ 現在輸入文字，就能完成圖文隨筆！');
    }
    
  } catch (error) {
    console.error('處理 Instagram 圖片失敗:', error);
  }
}

// ===== 發送 Instagram 訊息（私密回覆）=====
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
  // 處理文字訊息
  if (event.type === 'message' && event.message.type === 'text') {
    const userId = event.source.userId;
    const text = event.message.text;
    const tags = extractAndFilterTags(text);
    
    // 檢查是否有暫存的照片
    if (userTempPhotos.has(userId)) {
      // 有暫存照片 → 儲存為隨筆（文字+照片）
      const tempPhoto = userTempPhotos.get(userId);
      
      // 清除超時定時器
      if (tempPhoto.timeoutId) {
        clearTimeout(tempPhoto.timeoutId);
      }
      userTempPhotos.delete(userId);
      
      const message = {
        id: event.message.id,
        text: text,
        imageUrl: tempPhoto.photoUrl,
        imagePublicId: tempPhoto.publicId,
        userId: userId,
        displayName: 'FernBrom',
        timestamp: new Date().toISOString(),
        type: 'message_with_photo',
        tags: tags
      };
      
      try {
        await saveMessageToDB(message);
        
        let replyText = `📝 圖文隨筆已儲存！\n━━━━━━━━━━━━━━━━\n👤 作者：FernBrom\n🖼️ 包含照片\n`;
        if (tags.length > 0) {
          replyText += `🏷️ 標籤：${tags.join('、')}\n`;
        } else {
          replyText += `🏷️ 無效標籤（僅支援：#碳盤查 #永續 #淨零 #生活 #鹿角蕨 #積水鳳梨 #植物）\n`;
        }
        replyText += `━━━━━━━━━━━━━━━━\n📸 這張照片也會出現在相簿網頁。`;
        
        await client.replyMessage(event.replyToken, {
          type: 'text',
          text: replyText
        });
      } catch (error) {
        console.error('儲存隨筆失敗:', error);
        await client.replyMessage(event.replyToken, {
          type: 'text',
          text: '抱歉，儲存失敗，請稍後再試。'
        });
      }
    } else {
      // 沒有暫存照片 → 純文字隨筆
      const message = {
        id: event.message.id,
        text: text,
        userId: userId,
        displayName: 'FernBrom',
        timestamp: new Date().toISOString(),
        type: 'text_only',
        tags: tags
      };
      
      try {
        await saveMessageToDB(message);
        
        let replyText = `📝 純文字隨筆已儲存！\n━━━━━━━━━━━━━━━━\n👤 作者：FernBrom\n`;
        if (tags.length > 0) {
          replyText += `🏷️ 標籤：${tags.join('、')}\n`;
        } else {
          replyText += `🏷️ 無效標籤（僅支援：#碳盤查 #永續 #淨零 #生活 #鹿角蕨 #積水鳳梨 #植物）\n`;
        }
        replyText += `━━━━━━━━━━━━━━━━\n💡 提示：先傳照片再傳文字，可以發圖文隨筆喔！`;
        
        await client.replyMessage(event.replyToken, {
          type: 'text',
          text: replyText
        });
      } catch (error) {
        console.error('儲存隨筆失敗:', error);
        await client.replyMessage(event.replyToken, {
          type: 'text',
          text: '抱歉，儲存失敗，請稍後再試。'
        });
      }
    }
    
    return null;
  }
  
  if (event.type === 'message') {
    await client.replyMessage(event.replyToken, {
      type: 'text',
      text: '目前只支援圖片和文字訊息喔！\n\n📌 支援功能：\n• 📸 純照片 → 相簿\n• 💬 純文字 → 隨筆\n• 🖼️ 照片+文字(5分鐘內) → 圖文隨筆（照片也會進相簿）'
    });
  }
  
  return null;
}

// 啟動伺服器
const PORT = process.env.PORT || 10000;

connectMongo().then(() => {
  app.listen(PORT, () => {
    console.log(`🚀 Server running on port ${PORT}`);
    console.log(`📝 隨筆儲存在 MongoDB: messages 集合`);
    console.log(`📸 相簿直接從 Cloudinary 讀取所有照片`);
    console.log(`🏷️ 允許的標籤：${ALLOWED_TAGS.join(', ')}`);
    console.log(`✨ 照片+文字(5分鐘內) → 圖文隨筆（照片也會出現在相簿）`);
    console.log(`✨ 只傳照片或超過5分鐘 → 純相簿`);
    console.log(`✨ 只傳文字 → 純文字隨筆`);
  });
}).catch(error => {
  console.error('無法啟動伺服器:', error);
  process.exit(1);
});

process.on('SIGINT', async () => {
  console.log('正在關閉伺服器...');
  await mongoClient.close();
  process.exit(0);
});
// ===== 測試 Instagram 訊息發送（需 authMiddleware）=====
app.post('/api/test-ig-message', authMiddleware, async (req, res) => {
  const { userId, text } = req.body;
  if (!userId || !text) {
    return res.status(400).json({ error: '需要 userId 和 text' });
  }
  
  await sendInstagramMessage(userId, text);
  res.json({ success: true, message: '已發送' });
});
