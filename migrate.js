require('dotenv').config();
const cloudinary = require('cloudinary').v2;
const { MongoClient } = require('mongodb');

// Cloudinary 設定
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_NAME,
  api_key: process.env.CLOUDINARY_KEY,
  api_secret: process.env.CLOUDINARY_SECRET
});

// MongoDB 設定
const mongoUri = process.env.MONGODB_URI || 'mongodb://localhost:27017/line_bot';

async function migrate() {
  try {
    console.log('🚀 開始資料遷移...');
    
    // 連接 MongoDB
    const mongoClient = new MongoClient(mongoUri);
    await mongoClient.connect();
    const db = mongoClient.db('line_bot');
    const photosCollection = db.collection('photos');
    
    // 檢查現有照片數量
    const existingCount = await photosCollection.countDocuments();
    console.log(`📋 MongoDB 現有照片數量: ${existingCount}`);
    
    // 從 Cloudinary 讀取所有照片
    let allPhotos = [];
    let nextCursor = null;
    
    console.log('📸 從 Cloudinary 讀取照片...');
    
    do {
      const query = cloudinary.search
        .expression('folder:line_uploads')
        .sort_by('created_at', 'desc')
        .max_results(50);
      
      if (nextCursor) query.next_cursor(nextCursor);
      
      const result = await query.execute();
      allPhotos = allPhotos.concat(result.resources);
      nextCursor = result.next_cursor;
      
      console.log(`   已讀取 ${allPhotos.length} 張照片...`);
    } while (nextCursor);
    
    console.log(`\n📸 從 Cloudinary 總共找到 ${allPhotos.length} 張照片`);
    
    // 轉換格式並存入 MongoDB
    let migratedCount = 0;
    let skippedCount = 0;
    
    for (const photo of allPhotos) {
      const existing = await photosCollection.findOne({ id: photo.public_id });
      if (!existing) {
        await photosCollection.insertOne({
          id: photo.public_id,
          url: photo.secure_url,
          userId: 'migrated',
          displayName: 'FernBrom',
          timestamp: photo.created_at,
          type: 'photo'
        });
        migratedCount++;
        console.log(`✅ 遷移: ${photo.public_id} (${photo.created_at})`);
      } else {
        skippedCount++;
      }
    }
    
    console.log('\n🎉 遷移完成！');
    console.log(`   ✅ 新增: ${migratedCount} 筆`);
    console.log(`   ⏭️ 跳過: ${skippedCount} 筆 (已存在)`);
    console.log(`   📋 總計: ${await photosCollection.countDocuments()} 筆`);
    
    await mongoClient.close();
    
  } catch (error) {
    console.error('❌ 遷移失敗:', error);
  }
}

// 執行遷移
migrate();
