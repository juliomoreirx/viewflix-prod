// src/db/mongoose.js
const mongoose = require('mongoose');
const env = require('../config/env');
const logger = require('../lib/logger');

async function connectMongo() {
  // Configurações hardcore para Produção
  const options = {
    maxPoolSize: 20, // Mantém até 20 conexões abertas (ideal para alta concorrência)
    serverSelectionTimeoutMS: 5000, // Se não encontrar o DB em 5 seg, desiste logo e não trava o event loop
    socketTimeoutMS: 45000, // Fecha sockets inativos
    family: 4 // Força o uso de IPv4 (evita bugs esquisitos de resolução de DNS em alguns hosts)
  };

  try {
    // O nome da base de dados (fasttv) deve estar embutido no env.MONGO_URI
    await mongoose.connect(env.MONGO_URI, options);
    
    logger.info({ 
      msg: '🚀 MongoDB conectado com sucesso', 
      dbName: mongoose.connection.name, 
      host: mongoose.connection.host 
    });
  } catch (error) {
    logger.error({ 
      msg: '❌ Falha CRÍTICA ao conectar no MongoDB', 
      error: error.message 
    });
    throw error; // Lança o erro para que o server-bootstrap o apanhe e mate o processo
  }
}

// ==========================================
// MONITORIZAÇÃO DE EVENTOS DE CONEXÃO
// ==========================================
mongoose.connection.on('disconnected', () => {
  logger.warn({ msg: '⚠️ MongoDB desconectado! O Mongoose tentará reconectar automaticamente...' });
});

mongoose.connection.on('reconnected', () => {
  logger.info({ msg: '✅ MongoDB reconectado com sucesso!' });
});

mongoose.connection.on('error', (err) => {
  logger.error({ msg: '❌ Erro de conexão no MongoDB detetado em background', error: err.message });
});

module.exports = { mongoose, connectMongo };