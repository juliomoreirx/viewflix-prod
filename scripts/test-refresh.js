require('dotenv').config({ path: '../.env' }); // Isso sobe uma pasta para achar o .env
const axios = require('axios');
const { MongoClient, ObjectId } = require('mongodb');

(async () => {
  const client = new MongoClient(process.env.MONGO_URI);
  await client.connect();

  const db = client.db('fasttv');
  const doc = await db.collection('purchasedcontents').findOne(
    { _id: new ObjectId('69daddd24e2cb746123682d1') },
    { projection: { token: 1, sessionToken: 1 } }
  );

  const url = `http://localhost:3000/api/refresh-stream/${encodeURIComponent(doc.token)}/${encodeURIComponent(doc.sessionToken)}`;
  console.log('Calling:', url.slice(0, 120) + '...');

  try {
    const r = await axios.get(url);
    console.log('Status:', r.status);
    console.log('Body:', r.data);
  } catch (e) {
    console.log('Status:', e.response?.status);
    console.log('Body:', e.response?.data);
  } finally {
    await client.close();
  }
})();