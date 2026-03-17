const express = require('express');
const line = require('@line/bot-sdk');
const cloudinary = require('cloudinary').v2;
const path = require('path');
const basicAuth = require('express-basic-auth');

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

// 3. 免密碼路由 (LINE Webhook & 健康檢查)
app.get('/health', (req, res) => res.status(200).send('I am alive!'));

app.post('/callback', line.middleware(config), (req, res) => {
  Promise.all(req.body.events.map(handleEvent))
    .then((result) => res.json(result))
    .catch((err) => { console.error(err); res.status(500).end(); });
});

// 4. 靜態檔案路由
// 首頁 (index.html) 免密碼
app.use(express.static(path.join(__dirname, 'public')));

// 管理頁 (admin.html) 需要密碼
app.get('/admin', authMiddleware, (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

// 5. API 路由
// [讀取] 免密碼，讓展示頁能顯示
app.get('/api/images', async (req, res) => {
  try {
    const { cursor } = req.query;
    const query = cloudinary.search
      .expression('folder:line_uploads')
      .sort_by('created_at', 'desc')
      .max_results(8); // 每頁 8 張

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
  } catch (error) { res.status(500).send(error.message); }
});

// [刪除] 需要密碼
app.delete('/api/images', authMiddleware, async (req, res) => {
    try {
        await cloudinary.uploader.destroy(req.query.id);
        res.json({ success: true });
    } catch (error) { res.status(500).send(error.message); }
});

// 6. LINE 事件邏輯 (保持不變)
async function handleEvent(event) {
  if (event.type !== 'message' || event.message.type !== 'image') return null;
  const stream = await client.getMessageContent(event.message.id);
  
  return new Promise((resolve, reject) => {
    const cloudinaryStream = cloudinary.uploader.upload_stream(
      { folder: 'line_uploads' },
      async (error, result) => {
        if (error) return reject(error);
        await client.replyMessage(event.replyToken, {
            type: 'text',
            text: `✅ 照片已上傳成功！`
        });
        resolve(result);
      }
    );
    stream.pipe(cloudinaryStream);
  });
}

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
