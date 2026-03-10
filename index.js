const express = require('express');
const line = require('@line/bot-sdk');
const cloudinary = require('cloudinary').v2;
const path = require('path');
const basicAuth = require('express-basic-auth');
const app = express();

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

// LINE Webhook
app.post('/callback', line.middleware(config), (req, res) => {
  Promise.all(req.body.events.map(handleEvent))
    .then((result) => res.json(result))
    .catch((err) => { console.error(err); res.status(500).end(); });
});

// 安全防護
app.use(basicAuth({
    users: { [process.env.WEB_USER]: process.env.WEB_PASS },
    challenge: true,
    realm: 'MyLineAlbum'
}));

app.use(express.static(path.join(__dirname, 'public')));

// 取得圖片列表
app.get('/api/images', async (req, res) => {
  try {
    const { resources } = await cloudinary.search
      .expression('folder:line_uploads')
      .sort_by('created_at', 'desc')
      .max_results(20)
      .execute();
    res.json(resources.map(img => ({ url: img.secure_url, time: img.created_at, public_id: img.public_id })));
  } catch (error) { res.status(500).send(error.message); }
});

// 【最終修正】刪除路由：使用查詢參數 (Query String)
app.delete('/api/images', async (req, res) => {
    try {
        await cloudinary.uploader.destroy(req.query.id);
        res.json({ success: true });
    } catch (error) { res.status(500).send(error.message); }
});

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
            text: `✅ 照片已上傳成功！\n👉 網址: https://linephotobot.onrender.com`
        });
        resolve(result);
      }
    );
    stream.pipe(cloudinaryStream);
  });
}

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
