const express = require('express');
const line = require('@line/bot-sdk');
const cloudinary = require('cloudinary').v2;
const path = require('path');
const basicAuth = require('express-basic-auth');
const { MongoClient, ObjectId } = require('mongodb');

const app = express();

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
let messagesCollection;

// 連接 MongoDB
async function connectMongo() {
  try {
    await mongoClient.connect();
    db = mongoClient.db('line_bot'); // 資料庫名稱
    messagesCollection = db.collection('messages');
    
    // 建立索引以提升查詢效率
    await messagesCollection.createIndex({ timestamp: -1 });
    await messagesCollection.createIndex({ userId: 1 });
    
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

// 4. 訊息操作函數
async function saveMessageToDB(message) {
  try {
    const result = await messagesCollection.insertOne(message);
    return result;
  } catch (error) {
    console.error('儲存訊息失敗:', error);
    throw error;
  }
}

async function getMessagesFromDB(limit = 100) {
  try {
    const messages = await messagesCollection
      .find({})
      .sort({ timestamp: -1 })
      .limit(limit)
      .toArray();
    return messages;
  } catch (error) {
    console.error('讀取訊息失敗:', error);
    return [];
  }
}

async function deleteMessageFromDB(messageId) {
  try {
    // 嘗試用 ObjectId 或字串 ID 刪除
    let query = { id: messageId };
    
    // 如果 ID 看起來像 ObjectId，也嘗試用 _id 查詢
    if (ObjectId.isValid(messageId)) {
      query = { $or: [{ id: messageId }, { _id: new ObjectId(messageId) }] };
    }
    
    const result = await messagesCollection.deleteOne(query);
    return result.deletedCount > 0;
  } catch (error) {
    console.error('刪除訊息失敗:', error);
    return false;
  }
}

async function clearAllMessagesFromDB() {
  try {
    const result = await messagesCollection.deleteMany({});
    return result.deletedCount;
  } catch (error) {
    console.error('清除所有訊息失敗:', error);
    throw error;
  }
}

// 5. 免密碼路由
app.get('/health', (req, res) => res.status(200).send('I am alive!'));

app.post('/callback', line.middleware(config), (req, res) => {
  Promise.all(req.body.events.map(handleEvent))
    .then((result) => res.json(result))
    .catch((err) => { 
      console.error(err); 
      res.status(500).end(); 
    });
});

// 6. 靜態檔案路由
app.use(express.static(path.join(__dirname, 'public')));

// 相簿首頁
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// 簡單留言板頁面
app.get('/messages', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'messages.html'));
});

// 原來的留言板頁面（如果需要）
app.get('/note', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'note.html'));
});

// 管理頁需要密碼
app.get('/admin', authMiddleware, (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

// 7. API 路由
// [讀取] 照片 - 免密碼
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

// [讀取] 訊息 - 免密碼
app.get('/api/messages', async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 100;
    const messages = await getMessagesFromDB(limit);
    res.json(messages);
  } catch (error) {
    console.error('讀取訊息失敗:', error);
    res.status(500).send(error.message);
  }
});

// [刪除] 照片 - 需要密碼
app.delete('/api/images', authMiddleware, async (req, res) => {
    try {
        await cloudinary.uploader.destroy(req.query.id);
        res.json({ success: true });
    } catch (error) { 
        console.error('刪除照片失敗:', error);
        res.status(500).send(error.message); 
    }
});

// [刪除] 訊息 - 需要密碼
app.delete('/api/messages/:id', authMiddleware, async (req, res) => {
    try {
        const success = await deleteMessageFromDB(req.params.id);
        if (success) {
            res.json({ success: true });
        } else {
            res.status(404).json({ success: false, message: '訊息不存在' });
        }
    } catch (error) { 
        console.error('刪除訊息失敗:', error);
        res.status(500).send(error.message); 
    }
});

// [刪除] 所有訊息 - 需要密碼
app.delete('/api/messages', authMiddleware, async (req, res) => {
    try {
        const deletedCount = await clearAllMessagesFromDB();
        res.json({ success: true, deletedCount });
    } catch (error) { 
        console.error('清除所有訊息失敗:', error);
        res.status(500).send(error.message); 
    }
});

// 8. LINE 事件處理
async function handleEvent(event) {
  // 處理圖片訊息
  if (event.type === 'message' && event.message.type === 'image') {
    const stream = await client.getMessageContent(event.message.id);
    
    return new Promise((resolve, reject) => {
      const cloudinaryStream = cloudinary.uploader.upload_stream(
        { folder: 'line_uploads' },
        async (error, result) => {
          if (error) {
            console.error('上傳圖片失敗:', error);
            return reject(error);
          }
          await client.replyMessage(event.replyToken, {
              type: 'text',
              text: '✅ 照片已上傳成功！'
          });
          resolve(result);
        }
      );
      stream.pipe(cloudinaryStream);
    });
  }
  
  // 處理文字訊息
  if (event.type === 'message' && event.message.type === 'text') {
    const message = {
      id: event.message.id,
      text: event.message.text,
      userId: event.source.userId,
      displayName: '', // 預設值
      timestamp: new Date().toISOString(),
      type: 'text'
    };
    
    // 嘗試取得使用者名稱
    try {
      if (event.source.userId) {
        const profile = await client.getProfile(event.source.userId);
        message.displayName = profile.displayName;
      }
    } catch (error) {
      console.error('取得使用者資料失敗:', error);
      message.displayName = 'LINE 用戶';
    }
    
    // 儲存到 MongoDB
    try {
      await saveMessageToDB(message);
      
      // 回覆確認訊息
      await client.replyMessage(event.replyToken, {
        type: 'text',
        text: `📝 訊息已記錄：\n"${event.message.text.substring(0, 50)}${event.message.text.length > 50 ? '...' : ''}"`
      });
    } catch (error) {
      console.error('儲存訊息失敗:', error);
      await client.replyMessage(event.replyToken, {
        type: 'text',
        text: '抱歉，訊息儲存失敗，請稍後再試。'
      });
    }
    
    return null;
  }
  
  // 處理其他類型的訊息（可選）
  if (event.type === 'message') {
    await client.replyMessage(event.replyToken, {
      type: 'text',
      text: '目前只支援圖片和文字訊息喔！'
    });
  }
  
  return null;
}

// 9. 啟動伺服器
const PORT = process.env.PORT || 10000;

// 先連接資料庫，再啟動伺服器
connectMongo().then(() => {
  app.listen(PORT, () => {
    console.log(`🚀 Server running on port ${PORT}`);
    console.log(`📝 留言將儲存在 MongoDB: ${mongoUri}`);
  });
}).catch(error => {
  console.error('無法啟動伺服器:', error);
  process.exit(1);
});

// 優雅關閉
process.on('SIGINT', async () => {
  console.log('正在關閉伺服器...');
  await mongoClient.close();
  process.exit(0);
});
