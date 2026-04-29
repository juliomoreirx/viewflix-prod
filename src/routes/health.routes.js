const express = require('express');
const { mongoose } = require('../db/mongoose');
const redisClient = require('../lib/redis');

const router = express.Router();

router.get('/health', async (_req, res) => {
  let dbStatus = 'ok';
  try {
    if (mongoose.connection.readyState !== 1) {
      dbStatus = 'disconnected';
    }
  } catch (err) {
    dbStatus = 'error';
  }

  let redisStatus = 'ok';
  if (redisClient) {
    try {
      await redisClient.ping();
    } catch (err) {
      redisStatus = 'error';
    }
  } else {
    redisStatus = 'disabled';
  }

  const isHealthy = dbStatus === 'ok' && (redisStatus === 'ok' || redisStatus === 'disabled');

  res.status(isHealthy ? 200 : 503).json({
    status: isHealthy ? 'ok' : 'error',
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
    db: dbStatus,
    redis: redisStatus
  });
});

module.exports = router;