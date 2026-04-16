const express = require('express');
const line = require('@line/bot-sdk');
const cloudinary = require('cloudinary').v2;
const path = require('path');
const basicAuth = require('express-basic-auth');
const { MongoClient, ObjectId } = require('mongodb');
const cors = require('cors');

const app = express();

// ===== CORS 設定 - 放在所有路由之前 =====
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));
app.options('*', cors());

// 1. 環境變數配置
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

// 2. MongoDB 連接設定
const mongoUri = process.env.MONGODB_URI || 'mongodb://localhost:27017/line_bot';
const mongoClient = new MongoClient(mongoUri);
let db;
let messagesCollection;  // 隨筆集合（文字+照片）
let photosCollection;    // 純相簿集合（只存照片）

// 連接 MongoDB
async function connectMongo() {
  try {
    await mongoClient.connect();
    db = mongoClient.db('line_bot');
    messagesCollection = db.collection('messages');  // 隨筆
    photosCollection = db.collection('photos');      // 純相簿
    
    // 建立索引以提升查詢效率
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

// 3. 權限驗證中間件定義
const authMiddleware = basicAuth({
    users: { [process.env.WEB_USER]: process.env.WEB_PASS },
    challenge: true,
    realm: 'MyLineAlbum'
});

// 4. 允許的標籤列表（只保留這些標籤）
const ALLOWED_TAGS = ['#碳盤查', '#永續', '#淨零', '#生活', '#鹿角蕨', '#積水鳳梨', '#植物'];

// 輔助函數：從文字中提取並過濾標籤
function extractAndFilterTags(text) {
  const tagRegex = /#[\u4e00-\u9fa5a-zA-Z0-9]+/g;
  const matches = text.match(tagRegex);
  if (!matches) return [];
  
  // 過濾出允許的標籤，並去重
  const filteredTags = matches.filter(tag => ALLOWED_TAGS.includes(tag));
  return [...new Set(filteredTags)];
}

// 5. 訊息操作函數（隨筆）
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

// 6. 照片操作函數（純相簿）
async function savePhotoToDB(photo) {
  try {
    const result = await photosCollection.insertOne(photo);
    return result;
  } catch (error) {
    console.error('儲存照片失敗:', error);
    throw error;
  }
}

async function getPhotosFromDB(limit = 100) {
  try {
    const photos = await photosCollection
      .find({})
      .sort({ timestamp: -1 })
      .limit(limit)
      .toArray();
    return photos;
  } catch (error) {
    console.error('讀取照片失敗:', error);
    return [];
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

// 7. 免密碼路由
app.get('/health', (req, res) => res.status(200).send('I am alive!'));

app.post('/callback', line.middleware(config), (req, res) => {
  Promise.all(req.body.events.map(handleEvent))
    .then((result) => res.json(result))
    .catch((err) => { 
      console.error(err); 
      res.status(500).end(); 
    });
});

// 8. 靜態檔案路由
app.use(express.static(path.join(__dirname, 'public')));

// 相簿首頁（純照片）
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// 隨筆留言板頁面（文字+照片）
app.get('/messages', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'messages.html'));
});

// 管理頁需要密碼
app.get('/admin', authMiddleware, (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

// 9. API 路由

// [讀取] 純相簿照片 - 從 Cloudinary
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

// [讀取] 隨筆（文字+照片）
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

// [刪除] 純相簿照片 - 從 Cloudinary
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

// [刪除] 隨筆 - 需要密碼
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

// [刪除] 所有隨筆 - 需要密碼
app.delete('/api/messages', authMiddleware, async (req, res) => {
    try {
        const deletedCount = await clearAllMessagesFromDB();
        res.json({ success: true, deletedCount });
    } catch (error) { 
        console.error('清除所有隨筆失敗:', error);
        res.status(500).send(error.message); 
    }
});

// 新增：[刪除] 所有純相簿照片
app.delete('/api/all-photos', authMiddleware, async (req, res) => {
    try {
        const deletedCount = await clearAllPhotosFromDB();
        res.json({ success: true, deletedCount });
    } catch (error) { 
        console.error('清除所有照片失敗:', error);
        res.status(500).send(error.message); 
    }
});

// 10. LINE 事件處理 - 核心邏輯
// 用來暫存使用者的照片，等待文字
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
          
          // 檢查是否有暫存的照片
          if (userTempPhotos.has(userId)) {
            // 已有暫存照片 → 當作純照片上傳到相簿
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
              text: '📸 照片已儲存到相簿！\n（如要加上文字，請在照片後輸入文字）'
            });
          } else {
            // 暫存照片，等待文字
            userTempPhotos.set(userId, {
              photoUrl: result.secure_url,
              publicId: result.public_id,
              timestamp: Date.now()
            });
            
            // 設定 5 分鐘過期
            setTimeout(() => {
              if (userTempPhotos.has(userId)) {
                userTempPhotos.delete(userId);
              }
            }, 300000);
            
            await client.replyMessage(event.replyToken, {
              type: 'text',
              text: '🖼️ 照片已接收！\n請接著輸入文字內容，將會儲存為隨筆（含照片）。\n若只想儲存照片到相簿，請忽略此訊息。'
            });
          }
          resolve(result);
        }
      );
      stream.pipe(cloudinaryStream);
    });
  }
  
  // 處理文字訊息
  if (event.type === 'message' && event.message.type === 'text') {
    const userId = event.source.userId;
    const text = event.message.text;
    
    const tags = extractAndFilterTags(text);
    
    // 檢查是否有暫存的照片
    if (userTempPhotos.has(userId)) {
      // 有暫存照片 → 儲存為隨筆（文字+照片），不會進相簿
      const tempPhoto = userTempPhotos.get(userId);
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
        
        let replyText = `📝 隨筆已儲存！\n👤 作者：FernBrom\n🖼️ 包含照片`;
        if (tags.length > 0) {
          replyText += `\n🏷️ 標籤：${tags.join('、')}`;
        } else {
          replyText += `\n🏷️ 無效標籤（僅支援：#碳盤查 #永續 #淨零 #生活 #鹿角蕨 #積水鳳梨 #植物）`;
        }
        
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
        
        let replyText = `📝 隨筆已儲存！\n👤 作者：FernBrom`;
        if (tags.length > 0) {
          replyText += `\n🏷️ 標籤：${tags.join('、')}`;
        } else {
          replyText += `\n🏷️ 無效標籤（僅支援：#碳盤查 #永續 #淨零 #生活 #鹿角蕨 #積水鳳梨 #植物）`;
        }
        
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
      text: '目前只支援圖片和文字訊息喔！'
    });
  }
  
  return null;
}

// 11. 啟動伺服器
const PORT = process.env.PORT || 10000;

connectMongo().then(() => {
  app.listen(PORT, () => {
    console.log(`🚀 Server running on port ${PORT}`);
    console.log(`📝 隨筆將儲存在 MongoDB: ${mongoUri}`);
    console.log(`📸 純相簿將儲存在 Cloudinary + MongoDB`);
    console.log(`🌐 CORS 已啟用，允許所有來源訪問`);
    console.log(`🏷️ 允許的標籤：${ALLOWED_TAGS.join(', ')}`);
    console.log(`👤 PO 文者顯示名稱統一為：FernBrom`);
    console.log(`✨ 新模式：先傳照片再傳文字 = 隨筆（含照片）→ 只出現在隨筆網頁`);
    console.log(`✨ 只傳照片 = 純相簿 → 只出現在相簿網頁`);
    console.log(`✨ 只傳文字 = 純文字隨筆 → 只出現在隨筆網頁`);
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
