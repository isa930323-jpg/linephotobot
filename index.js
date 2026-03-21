const express = require('express');
const line = require('@line/bot-sdk');
const cloudinary = require('cloudinary').v2;
const path = require('path');
const basicAuth = require('express-basic-auth');
const { MongoClient, ObjectId } = require('mongodb');
const cors = require('cors');

const app = express();

// ===== CORS =====
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));
app.options('*', cors());

// ===== LINE =====
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
let messagesCollection;

async function connectMongo() {
  await mongoClient.connect();
  const db = mongoClient.db('line_bot');
  messagesCollection = db.collection('messages');

  await messagesCollection.createIndex({ timestamp: -1 });
  await messagesCollection.createIndex({ tags: 1 });

  console.log('✅ MongoDB connected');
}

// ===== Auth =====
const authMiddleware = basicAuth({
  users: { [process.env.WEB_USER]: process.env.WEB_PASS },
  challenge: true
});

// ===== 抓 tag =====
function extractTags(text) {
  const tagRegex = /#[\u4e00-\u9fa5a-zA-Z0-9]+/g;
  const matches = text.match(tagRegex);
  return matches ? [...new Set(matches.map(t => t.replace('#', '')))] : [];
}

// ===== 判斷 POST =====
function isPostFormat(text) {
  return text.trim().startsWith('POST');
}

// ===== ⭐ 超簡單解析（重點）=====
function parsePost(text) {
  const lines = text.trim().split('\n');

  // 移除 POST
  lines.shift();

  // 第一行當標題
  let title = lines.shift()?.trim() || '';

  // 找 tag
  const tagLine = lines.find(l => l.includes('#')) || '';

  // 移除 tag 行
  const contentLines = lines.filter(l => !l.includes('#'));

  // 如果沒標題 → 自動抓第一段
  if (!title && contentLines.length > 0) {
    title = contentLines[0].slice(0, 20);
  }

  // 轉段落
  const content = contentLines
    .join('\n')
    .split('\n\n')
    .map(p => `<p>${p.trim()}</p>`)
    .join('');

  return { title, content };
}

// ===== DB =====
async function saveMessage(message) {
  return await messagesCollection.insertOne(message);
}

async function getMessages(limit = 100, tag = null) {
  const query = tag ? { tags: tag } : {};
  return await messagesCollection.find(query)
    .sort({ timestamp: -1 })
    .limit(limit)
    .toArray();
}

// ===== Routes =====
app.get('/health', (req, res) => res.send('OK'));

app.post('/callback', line.middleware(config), (req, res) => {
  Promise.all(req.body.events.map(handleEvent))
    .then(r => res.json(r))
    .catch(e => res.status(500).end());
});

app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/messages', async (req, res) => {
  const data = await getMessages(
    parseInt(req.query.limit) || 100,
    req.query.tag
  );
  res.json(data);
});

// ===== LINE =====
async function handleEvent(event) {

  // ===== 圖片 =====
  if (event.type === 'message' && event.message.type === 'image') {
    const stream = await client.getMessageContent(event.message.id);

    return new Promise((resolve, reject) => {
      const upload = cloudinary.uploader.upload_stream(
        { folder: 'line_uploads' },
        async (err) => {
          if (err) return reject(err);

          await client.replyMessage(event.replyToken, {
            type: 'text',
            text: '✅ 照片已上傳'
          });

          resolve();
        }
      );
      stream.pipe(upload);
    });
  }

  // ===== 文字 =====
  if (event.type === 'message' && event.message.type === 'text') {

    const text = event.message.text;
    const tags = extractTags(text);

    let message;

    // ⭐ POST 發文
    if (isPostFormat(text)) {
      const { title, content } = parsePost(text);

      message = {
        id: event.message.id,
        type: 'post',
        title,
        content,
        raw: text,
        timestamp: new Date().toISOString(),
        tags
      };

    } else {
      // 一般訊息
      message = {
        id: event.message.id,
        type: 'text',
        text,
        timestamp: new Date().toISOString(),
        tags
      };
    }

    await saveMessage(message);

    // 回覆（簡化）
    let reply = '✅ 已記錄';

    if (message.type === 'post') {
      reply = `📝 已發布\n${message.title}`;
    }

    if (tags.length > 0) {
      reply += `\n#${tags.join(' #')}`;
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
    console.log('🚀 Server running on', PORT);
  });
});

// ===== 關閉 =====
process.on('SIGINT', async () => {
  await mongoClient.close();
  process.exit(0);
});
