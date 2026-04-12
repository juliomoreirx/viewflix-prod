const mongoose = require('mongoose');
const env = require('../config/env');
const logger = require('../lib/logger');

async function connectMongo() {
  await mongoose.connect(env.MONGO_URI, {
    dbName: 'fasttv'
  });
  logger.info({ msg: 'MongoDB conectado', dbName: mongoose.connection.name, host: mongoose.connection.host });
}

module.exports = { mongoose, connectMongo };