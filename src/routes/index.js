// src/routes/index.js
const express = require('express');
const healthRoutes = require('./health.routes');
const streamRoutes = require('./stream.routes');
const secureStreamRoutes = require('./secure-stream.routes');
const catalogRoutes = require('./catalog.routes');
const authRoutes = require('./auth.routes');
const adminRoutes = require('./admin.routes');
const paymentsRoutes = require('./payments.routes');
const playerRoutes = require('./player.routes');
const cookiesRoutes = require('./cookies.routes');
const batchRoutes = require('./batch.routes');

// 🚀 IMPORTAÇÃO DO BOT NA CAMADA OFICIAL DE ROTAS
const botModule = require('../../bot');

const router = express.Router();

// 🚀 ROTA DO WEBHOOK OFICIAL DO TELEGRAM (Injetada no roteador nativo)
// O array com duas strings garante que a rota seja capturada independentemente 
// de como o app.js monta o prefixo (/api ou /)
router.post(['/telegram-webhook', '/api/telegram-webhook'], (req, res) => {
  if (req.body && Object.keys(req.body).length > 0) {
    botModule.bot.processUpdate(req.body);
    console.log('✅ [Express Router] Webhook recebido e injetado direto na veia do Bot!');
  } else {
    console.warn('⚠️ [Express Router] Webhook recebido, mas o payload (req.body) está vazio.');
  }
  // Responde com 200 OK para o Telegram parar de tentar reenviar
  res.sendStatus(200);
});

router.use(healthRoutes);
router.use(streamRoutes);
router.use(secureStreamRoutes);
router.use(catalogRoutes);
router.use(authRoutes);
router.use(adminRoutes);
router.use(paymentsRoutes);
router.use(playerRoutes);
router.use('/cookies', cookiesRoutes);
router.use(batchRoutes);

module.exports = router;