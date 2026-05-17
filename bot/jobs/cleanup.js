// bot/jobs/cleanup.js
const bot = require('../instance');
const config = require('../config');
const state = require('../state');
const db = require('../services/db.service');
const { formatTimeRemaining } = require('../utils/formatters');
const { escaparMarkdownSeguro } = require('../../src/services/text-utils.service');
const { getPurchaseVisibilityFilter } = require('../services/user.service');

/**
 * Executa a varredura e notificação de conteúdos que vão expirar em breve
 */
async function verificarConteudosExpirando() {
  try {
    const PurchasedContentModel = db.getPurchasedContentModel();
    const UserModel = db.getUserModel();
    
    if (!PurchasedContentModel || !UserModel) return;

    const agora = new Date();
    const daquiA2Horas = new Date(agora.getTime() + (2 * 60 * 60 * 1000));
    const daquiA24Horas = new Date(agora.getTime() + (24 * 60 * 60 * 1000));

    // Buscar filmes prestes a expirar (próximas 2 horas)
    const filmesExpirando = await PurchasedContentModel.find({
      mediaType: 'movie',
      ...getPurchaseVisibilityFilter({ expiresAt: { $gt: agora, $lte: daquiA2Horas } }),
      notificationSent: false
    });

    // Buscar séries prestes a expirar (próximas 24 horas)
    const seriesExpirando = await PurchasedContentModel.find({
      mediaType: 'series',
      ...getPurchaseVisibilityFilter({ expiresAt: { $gt: agora, $lte: daquiA24Horas } }),
      notificationSent: false
    });

    // Buscar canais ao vivo prestes a expirar (próximas 2 horas)
    const canaisExpirando = await PurchasedContentModel.find({
      mediaType: 'livetv',
      ...getPurchaseVisibilityFilter({ expiresAt: { $gt: agora, $lte: daquiA2Horas } }),
      notificationSent: false
    });

    const todosExpirando = [...filmesExpirando, ...seriesExpirando, ...canaisExpirando];

    for (const content of todosExpirando) {
      try {
        const user = await UserModel.findOne({ userId: content.userId });

        // Se o utilizador não existir ou tiver notificações desativadas, apenas marca como enviado e pula
        if (!user || !user.notificationsEnabled) {
          content.notificationSent = true;
          await content.save();
          continue;
        }

        const timeRemaining = formatTimeRemaining(content.expiresAt);
        const playerUrl = `${config.dynamic.DOMINIO_PUBLICO}/player/${content.token}`;
        const nomeCompleto = content.episodeName ? `${content.title} - ${content.episodeName}` : content.title;
        const emoji = content.mediaType === 'movie' ? '🎬' : (content.mediaType === 'livetv' ? '📡' : '📺');
        const tipo = content.mediaType === 'movie' ? 'Filme' : (content.mediaType === 'livetv' ? 'Canal' : 'Episódio');

        await bot.sendMessage(
          content.userId,
          `⏰ *${tipo} Expirando em Breve!*\n\n${emoji} *${escaparMarkdownSeguro(nomeCompleto)}*\n\n${timeRemaining}\n\n⚠️ Assista agora antes que expire!`,
          {
            parse_mode: 'Markdown',
            reply_markup: {
              inline_keyboard: [
                [{ text: '▶️ Assistir Agora', url: playerUrl }],
                [{ text: '📦 Meu Conteúdo', callback_data: 'my_content' }]
              ]
            }
          }
        );

        content.notificationSent = true;
        await content.save();
      } catch (error) {
        // Se o utilizador bloqueou o bot (403), ignoramos para não travar o loop
        if (error.response?.body?.error_code === 403) {
          content.notificationSent = true;
          await content.save();
        } else {
          console.error(`❌ Erro ao enviar notificação de expiração para ${content.userId}:`, error.message);
        }
      }
    }
  } catch (error) {
    console.error('❌ Erro no job de verificação de conteúdos expirando:', error);
  }
}

module.exports = function startJobs() {
  // 🚀 NOTA DE EVOLUÇÃO: O Intervalo 1 (Limpeza de RAM de userStates) foi totalmente removido
  // porque a Etapa 2 agora usa TTL nativo do Redis, economizando loops de CPU na VPS!

  // 1. Verificação periódica de expiração de pagamentos em intervalos finos (a cada 5 minutos)
  setInterval(() => {
    const agora = Date.now();
    const TEMPO_EXPIRACAO = 15 * 60 * 1000; // 15 minutos
    
    // 🚀 FIX DE SEGURANÇA SENIOR: Adicionado o fallback || {} para evitar crash por undefined
    const pendentes = state.pendingPayments || {};
    
    for (const [paymentId, payment] of Object.entries(pendentes)) {
      if (payment && payment.timestamp && (agora - payment.timestamp > TEMPO_EXPIRACAO)) {
        delete pendentes[paymentId];
        if (state.paymentCheckIntervals && state.paymentCheckIntervals[paymentId]) {
          clearInterval(state.paymentCheckIntervals[paymentId]);
          delete state.paymentCheckIntervals[paymentId];
        }
      }
    }
  }, 300000);

  // 2. Limpeza física de registos expirados no MongoDB a cada 1 hora
  setInterval(async () => {
    try {
      const PurchasedContentModel = db.getPurchasedContentModel();
      if (!PurchasedContentModel || typeof PurchasedContentModel.deleteMany !== 'function') return;
      
      const resultado = await PurchasedContentModel.deleteMany({ expiresAt: { $lt: new Date() } });
      console.log(`🧹 [Job] Conteúdos expirados limpos do banco de dados. Total removido: ${resultado.deletedCount}`);
    } catch (error) {
      console.error('❌ Erro ao limpar conteúdos expirados do banco:', error);
    }
  }, 3600000);

  // 3. Agendamento das notificações de expiração (A cada 1 hora, com gatilho inicial de 30 segundos)
  setInterval(verificarConteudosExpirando, 3600000);
  setTimeout(verificarConteudosExpirando, 30000);
};