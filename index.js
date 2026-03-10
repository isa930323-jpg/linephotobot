const express = require('express');
const line = require('@line/bot-sdk');
const cloudinary = require('cloudinary').v2;

const app = express();

// 1. 環境變數設定 (稍後在 Render 後台設定)
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

// 2. LINE Webhook 端點
app.post('/callback', line.middleware(config), (req, res) => {
  Promise.all(req.body.events.map(handleEvent))
    .then((result) => res.json(result))
    .catch((err) => {
      console.error(err);
      res.status(500).end();
    });
});

async function handleEvent(event) {
  // 只處理「圖片訊息」
  if (event.type !== 'message' || event.message.type !== 'image') {
    return Promise.resolve(null);
  }

  const messageId = event.message.id;

  // 從 LINE 取得內容流 (Stream)
  const stream = await client.getMessageContent(messageId);

  // 透過 Promise 處理 Cloudinary 上傳
  return new Promise((resolve, reject) => {
    const cloudinaryStream = cloudinary.uploader.upload_stream(
      { 
        folder: 'line_uploads',
        tags: ['line_bot'] // 方便之後搜尋
      },
      (error, result) => {
        if (error) return reject(error);
        console.log('上傳成功！網址為:', result.secure_url);
        resolve(result);
      }
    );
    stream.pipe(cloudinaryStream);
  });
}

// 3. 提供給前端網頁的 API (取得最新的 10 張圖)
app.get('/api/images', async (req, res) => {
  try {
    const { resources } = await cloudinary.search
      .expression('folder:line_uploads')
      .sort_by('created_at', 'desc')
      .max_results(10)
      .execute();
    
    const imageUrls = resources.map(img => img.secure_url);
    res.json(imageUrls);
  } catch (error) {
    res.status(500).send(error.message);
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});
