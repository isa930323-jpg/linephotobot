const express = require('express');
const line = require('@line/bot-sdk');
const cloudinary = require('cloudinary').v2;
const path = require('path');
const basicAuth = require('express-basic-auth'); // 記得 npm install express-basic-auth
const app = express();

// 設定環境變數
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

// 【登入防護】後端 Basic Auth
app.use(basicAuth({
    users: { [process.env.WEB_USER]: process.env.WEB_PASS },
    challenge: true,
    realm: 'MyLineAlbum'
}));

// 託管靜態網頁
app.use(express.static(path.join(__dirname, 'public')));

// LINE Webhook
app.post('/callback', line.middleware(config), (req, res) => {
  Promise.all(req.body.events.map(handleEvent))
    .then((result) => res.json(result))
    .catch((err) => { console.error(err); res.status(500).end(); });
});

async function handleEvent(event) {
  if (event.type !== 'message' || event.message.type !== 'image') return null;
  const stream = await client.getMessageContent(event.message.id);
  
  return new Promise((resolve, reject) => {
    const cloudinaryStream = cloudinary.uploader.upload_stream(
      { folder: 'line_uploads' },
      async (error, result) => {
        if (error) return reject(error);
        // 【即時回饋】傳送成功通知
        await client.replyMessage(event.replyToken, {
            type: 'text',
            text: `✅ 照片已上傳成功！\n👉 請至相簿網頁查看`
        });
        resolve(result);
      }
    );
    stream.pipe(cloudinaryStream);
  });
}

// API
app.get('/api/images', async (req, res) => {
  try {
    const { resources } = await cloudinary.search
      .expression('folder:line_uploads')
      .sort_by('created_at', 'desc')
      .max_results(20)
      .execute();
    res.json(resources.map(img => ({ url: img.secure_url, time: img.created_at })));
  } catch (error) { res.status(500).send(error.message); }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
