// /root/viewflix/viewflix-prod/queue-worker.js
require('dotenv').config(); // Carrega as variáveis de ambiente do .env
const mongoose = require('mongoose');
const bunnyCacheService = require('./src/services/bunny-cache.service');
const logger = require('./src/lib/logger');

// 1. Conexão estrita com o MongoDB para atualizar o status do HLS no banco
const mongoUri = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/viewflix';
mongoose.connect(mongoUri)
  .then(() => {
    logger.info('📦 [Queue Worker] Conexão com o MongoDB estabelecida com sucesso!');
    
    // 2. Liga a escuta da fila do BullMQ e o processador otimizado do FFmpeg (Remux)
    bunnyCacheService.startWorker();
    
    logger.info('⚙️ [Queue Worker] Motores ativados no Redis. Escutando a fila de downloads...');
  })
  .catch((err) => {
    logger.error('❌ [Queue Worker] Erro crítico de inicialização no MongoDB:', err.message);
    process.exit(1);
  });

// Escudos protetores para o processo nunca cair por erros de downloads de terceiros
process.on('unhandledRejection', (reason, promise) => {
  logger.error({ msg: '💥 Unhandled Rejection capturado no Queue Worker', reason: reason?.message || reason });
});

process.on('uncaughtException', (error) => {
  logger.error({ msg: '💥 Uncaught Exception capturado no Queue Worker', error: error.message });
});