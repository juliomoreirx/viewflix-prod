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

// 🚀 IMPORTAÇÕES DE INFRAESTRUTURA SEGUROS
const botModule = require('../../bot');
const bunnyCacheService = require('../services/bunny-cache.service');

const router = express.Router();

// 🚀 ETAPA 4: INTERCEPTADOR ANTI-FLOOD ATÓMICO COM REDIS
router.post(['/telegram-webhook', '/api/telegram-webhook'], async (req, res) => {
  const update = req.body;

  if (!update || Object.keys(update).length === 0) {
    return res.sendStatus(200);
  }

  // Identifica o Chat ID de forma cirúrgica (seja mensagem de texto ou clique inline callback)
  const chatId = update.message?.chat?.id || update.callback_query?.message?.chat?.id;

  if (chatId) {
    const blockKey = `flood:blocked:${chatId}`;
    const counterKey = `flood:counter:${chatId}`;

    try {
      // 1. Verifica se o utilizador está cumprindo castigo por spam
      const isBlocked = await bunnyCacheService.redisConnection.get(blockKey);
      if (isBlocked) {
        // Devolve 200 OK imediatamente para o Telegram não reenviar, mas ignora o processamento
        return res.sendStatus(200);
      }

      // 2. Incrementa o contador de cliques/mensagens na janela atual
      const hits = await bunnyCacheService.redisConnection.incr(counterKey);

      // Se for a primeira interação da janela de tempo, define expiração de 4 segundos
      if (hits === 1) {
        await bunnyCacheService.redisConnection.expire(counterKey, 4);
      }

      // 3. Gatilho de Proteção: Se ultrapassar 6 requisições em 4 segundos, aplica o bloqueio
      if (hits > 6) {
        // Tranca o utilizador no Redis por 30 segundos
        await bunnyCacheService.redisConnection.set(blockKey, '1', 'EX', 30);
        // Limpa o contador para reiniciar zerado após a punição
        await bunnyCacheService.redisConnection.del(counterKey);

        // Envia um aviso educacional para o utilizador no Telegram
        botModule.bot.sendMessage(chatId, "⚠️ *Aviso de Segurança FastTV* ⚠️\n\nEstás a enviar comandos ou cliques rápido demais! Por segurança do servidor, os teus acessos foram suspensos por *30 segundos*.\n\nVá com calma, parceiro!  popcorn", { parse_mode: 'Markdown' }).catch(() => {});
        
        return res.sendStatus(200);
      }
    } catch (redisErr) {
      console.error('❌ [Anti-Flood Redis] Falha ao validar rate limit, permitindo bypass por segurança:', redisErr.message);
    }
  }

  // Se passou pelo escudo anti-flood, injeta o sinal direto na inteligência do bot
  botModule.bot.processUpdate(update);
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