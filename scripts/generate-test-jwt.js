require('dotenv').config();
const jwt = require('jsonwebtoken');

const token = jwt.sign(
  {
    userId: 999999,
    videoId: 'testvideo123',
    mediaType: 'movie',
    exp: Math.floor(Date.now() / 1000) + 24 * 60 * 60
  },
  process.env.JWT_SECRET
);

console.log(token);