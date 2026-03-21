const express = require('express');
const line = require('@line/bot-sdk');
const cloudinary = require('cloudinary').v2;
const path = require('path');
const basicAuth = require('express-basic-auth');
const { MongoClient, ObjectId } = require('mongodb');
const cors = require('cors');

const app = express();

// ===== CORS 設定 =====
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));
app.options('*', cors());

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

// ===== MongoDB =====
const mongoUri = process.env.MONGODB_URI || 'mongodb://localhost:27017/line_bot';
const mongoClient = new MongoClient(mongoUri);
let db;
let messagesCollection;

async function connectMongo() {
  try {
    await mongoClient.connect();
    db = mongoClient.db('line_bot');
    messagesCollection = db.collection('messages');

    await messagesCollection.createIndex({ timestamp: -1 });
    await messagesCollection.createIndex({ userId: 1 });
    await messagesCollection.createIndex({ tags: 1 });

    console.log('✅ MongoDB 連接成功');
  } catch (error) {
    console.error('❌ MongoDB 連接失敗:', error);
    process.exit(1);
  }
}

// ===== Auth =====
const authMiddleware = basicAuth({
  users: { [process.env.WEB_USER]: process.env.WEB_PASS },
  challenge: true,
  realm: 'MyLineAlbum'
});

// ===== 工具：抓 tag =====
function extractTags(text) {
  const tagRegex = /#[\u4e00-\u9fa5a-zA-Z0-9]+/g;
  const matches = text.match(tagRegex);
  return matches ? [...new Set(matches.map(t => t.replace('#', '')))] : [];
}

// ===== ✅ 新增：判斷 POST =====
function isPostFormat(text) {
  return text.trim().startsWith('POST');
}

// ===== ✅ 新增：解析文章 =====
function parsePost(text) {
  const lines = text.split('\n');

  let title = '';
  let content = '';

  const titleLine = lines.find(l => l.startsWith('標題｜'));
  if (titleLine) {
    title = titleLine.replace('標題｜', '').trim();
  }

  const contentStart = lines.findIndex(l => l.startsWith('內文｜'));

  if (contentStart !== -1) {
    const contentLines = lines.slice(contentStart + 1);

    const cleanLines = contentLines.filter(l => !l.trim().startsWith('#'));

    content = cleanLines
      .join('\n')
      .split('\n\n')
      .map(p => `<p>${p.trim()}</p>`)
      .join('');
  }

  return { title, content };
}

// ===== DB 操作 =====
async function saveMessageToDB(message) {
  return await messagesCollection.insertOne(message);
}

async function getMessagesFromDB(limit = 100, tag = null) {
  let query = {};
  if (tag) query = { tags: tag };

  return await messagesCollection
    .find(query)
    .sort({ timestamp: -1 })
    .limit(limit)
    .toArray();
}

async function deleteMessageFromDB(messageId) {
  let query = { id: messageId };
  if (ObjectId.isValid(messageId)) {
    query = { $or: [{ id: messageId }, { _id: new ObjectId(messageId) }] };
  }
  const result = await messagesCollection.deleteOne(query);
  return result.deletedCount > 0;
}

async function clearAllMessagesFromDB() {
  const result = await messagesCollection.deleteMany({});
  return result.deletedCount;
}

// ===== Routes =====
app.get('/health', (req, res) => res.send('OK'));

app.post('/callback', line.middleware(config), (req, res) => {
  Promise.all(req.body.events.map(handleEvent))
    .then(result => res.json(result))
    .catch(err => {
      console.error(err);
      res.status(500).end();
    });
});

app.use(express.static(path.join(__dirname, 'public')));

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public/index.html')));
app.get('/messages', (req, res) => res.sendFile(path.join(__dirname, 'public/messages.html')));
app.get('/admin', authMiddleware, (req, res) => res.sendFile(path.join(__dirname, 'public/admin.html')));

// ===== API =====
app.get('/api/messages', async (req, res) => {
  const limit = parseInt(req.query.limit) || 100;
  const tag = req.query.tag;
  const messages = await getMessagesFromDB(limit, tag);
  res.json(messages);
});

// ===== LINE 處理 =====
async function handleEvent(event) {

  // ===== 圖片 =====
  if (event.type === 'message' && event.message.type === 'image') {
    const stream = await client.getMessageContent(event.message.id);

    return new Promise((resolve, reject) => {
      const cloudinaryStream = cloudinary.uploader.upload_stream(
        { folder: 'line_uploads' },
        async (error, result) => {
          if (error) return reject(error);

          await client.replyMessage(event.replyToken, {
            type: 'text',
            text: '✅ 照片已上傳'
          });

          resolve(result);
        }
      );
      stream.pipe(cloudinaryStream);
    });
  }

  // ===== 文字（升級版） =====
  if (event.type === 'message' && event.message.type === 'text') {

    const text = event.message.text;
    const tags = extractTags(text);

    let message;

    // 👉 POST文章
    if (isPostFormat(text)) {
      const { title, content } = parsePost(text);

      message = {
        id: event.message.id,
        type: 'post',
        title,
        content,
        raw: text,
        userId: event.source.userId,
        displayName: '',
        timestamp: new Date().toISOString(),
        tags
      };

    } else {
      // 👉 原本訊息
      message = {
        id: event.message.id,
        type: 'text',
        text,
        userId: event.source.userId,
        displayName: '',
        timestamp: new Date().toISOString(),
        tags
      };
    }

    // 抓使用者名稱
    try {
      const profile = await client.getProfile(event.source.userId);
      message.displayName = profile.displayName;
    } catch {
      message.displayName = 'FernBrom';
    }

    // 存DB
    await saveMessageToDB(message);

    // 回覆
    let reply = '✅ 已記錄';

    if (message.type === 'post') {
      reply = `📝 已發布\n${message.title}`;
    }

    if (tags.length > 0) {
      reply += `\n🏷️ ${tags.join('、')}`;
    }

    await client.replyMessage(event.replyToken, {
      type: 'text',
      text: reply
    });

    return null;
  }

  return null;
}

// ===== 啟動 =====
const PORT = process.env.PORT || 10000;

connectMongo().then(() => {
  app.listen(PORT, () => {
    console.log(`🚀 Server running on ${PORT}`);
  });
});

// ===== 關閉 =====
process.on('SIGINT', async () => {
  await mongoClient.close();
  process.exit(0);
});
