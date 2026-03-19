const express = require('express');
const line = require('@line/bot-sdk');
const cloudinary = require('cloudinary').v2;
const path = require('path');
const basicAuth = require('express-basic-auth');
const fs = require('fs').promises;

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

// 2. 權限驗證中間件定義
const authMiddleware = basicAuth({
    users: { [process.env.WEB_USER]: process.env.WEB_PASS },
    challenge: true,
    realm: 'MyLineAlbum'
});

// 3. 訊息檔案路徑
const MESSAGES_FILE = path.join(__dirname, 'messages.json');

// 初始化訊息檔案
async function initMessagesFile() {
  try {
    await fs.access(MESSAGES_FILE);
  } catch (error) {
    // 檔案不存在，建立新檔案
    await fs.writeFile(MESSAGES_FILE, JSON.stringify([]));
  }
}
initMessagesFile();

// 4. 讀取/寫入訊息的輔助函數
async function getMessages() {
  try {
    const data = await fs.readFile(MESSAGES_FILE, 'utf8');
    return JSON.parse(data);
  } catch (error) {
    return [];
  }
}

async function saveMessage(message) {
  const messages = await getMessages();
  messages.unshift(message); // 新訊息放前面
  // 只保留最近 100 則訊息
  if (messages.length > 100) {
    messages.pop();
  }
  await fs.writeFile(MESSAGES_FILE, JSON.stringify(messages, null, 2));
}

// 5. 免密碼路由
app.get('/health', (req, res) => res.status(200).send('I am alive!'));

app.post('/callback', line.middleware(config), (req, res) => {
  Promise.all(req.body.events.map(handleEvent))
    .then((result) => res.json(result))
    .catch((err) => { console.error(err); res.status(500).end(); });
});

// 6. 靜態檔案路由
app.use(express.static(path.join(__dirname, 'public')));

// 原本的相簿首頁 (保留原來的 index.html)
// 留言板頁面 - 新增路由
app.get('/note', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'note.html'));
});

// 管理頁需要密碼
app.get('/admin', authMiddleware, (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});// 7. API 路由
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
    res.status(500).send(error.message); 
  }
});

// [讀取] 訊息 - 免密碼
app.get('/api/messages', async (req, res) => {
  try {
    const messages = await getMessages();
    res.json(messages);
  } catch (error) {
    res.status(500).send(error.message);
  }
});

// [刪除] 照片 - 需要密碼
app.delete('/api/images', authMiddleware, async (req, res) => {
    try {
        await cloudinary.uploader.destroy(req.query.id);
        res.json({ success: true });
    } catch (error) { 
        res.status(500).send(error.message); 
    }
});

// [刪除] 訊息 - 需要密碼
app.delete('/api/messages/:id', authMiddleware, async (req, res) => {
    try {
        const messages = await getMessages();
        const filteredMessages = messages.filter(msg => msg.id !== req.params.id);
        await fs.writeFile(MESSAGES_FILE, JSON.stringify(filteredMessages, null, 2));
        res.json({ success: true });
    } catch (error) { 
        res.status(500).send(error.message); 
    }
});

// [刪除] 所有訊息 - 需要密碼
app.delete('/api/messages', authMiddleware, async (req, res) => {
    try {
        await fs.writeFile(MESSAGES_FILE, JSON.stringify([]));
        res.json({ success: true });
    } catch (error) { 
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
          if (error) return reject(error);
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
      displayName: '', // 可以透過 LINE API 取得使用者名稱
      timestamp: new Date().toISOString(),
      type: 'text'
    };
    
    try {
      // 可以嘗試取得使用者名稱
      if (event.source.userId) {
        const profile = await client.getProfile(event.source.userId);
        message.displayName = profile.displayName;
      }
    } catch (error) {
      console.error('Failed to get user profile:', error);
    }
    
    await saveMessage(message);
    
    // 回覆確認訊息
    await client.replyMessage(event.replyToken, {
      type: 'text',
      text: `📝 訊息已記錄：\n"${event.message.text.substring(0, 50)}${event.message.text.length > 50 ? '...' : ''}"`
    });
    
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

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
