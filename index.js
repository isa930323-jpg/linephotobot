const express = require('express');
const line = require('@line/bot-sdk');
const cloudinary = require('cloudinary').v2;
const path = require('path');
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

// 【關鍵修正】使用絕對路徑掛載靜態檔案
app.use(express.static(path.join(__dirname, 'public')));

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
      (error, result) => {
        if (error) return reject(error);
        resolve(result);
      }
    );
    stream.pipe(cloudinaryStream);
  });
}

// API 提供圖片清單
app.get('/api/images', async (req, res) => {
  try {
    const { resources } = await cloudinary.search
      .expression('folder:line_uploads')
      .sort_by('created_at', 'desc')
      .max_results(20)
      .execute();
    
    const data = resources.map(img => ({
      url: img.secure_url,
      time: img.created_at
    }));
    res.json(data);
  } catch (error) { res.status(500).send(error.message); }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
