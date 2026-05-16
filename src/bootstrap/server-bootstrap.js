const app = require('../app');
const env = require('../config/env');
const logger = require('../lib/logger');

const { connectMongo, mongoose } = require('../db/mongoose');
const models = require('../models');

// ======================
// NOVA IMPORTAÇÃO DO BOT (estrutura modular)
// ======================
const botModule = require('../../bot');                    // ← ALTERADO AQUI

const contentService = require('../services/content-cache.service');
const PaymentService = require('../services/payment.service');
const paymentAdapter = require('../adapters/payment.adapter');
const CookieManagerService = require('../services/cookie-manager.service');
const bunnyStorageService = require('../services/bunny-storage.service');
const bunnyCacheService = require('../services/bunny-cache.service');
const liveTvBufferProvisioner = require('../services/livetv-buffer-provisioner.service');

async function startServer() {
  try {
    logger.info({
      msg: 'Boot env check',
      hasSessionCookiesEnv: !!env.SESSION_COOKIES,
      sessionEnvLength: env.SESSION_COOKIES ? String(env.SESSION_COOKIES).length : 0
    });

    await connectMongo();
    app.locals.models = models;

    // Inicializa Payment Service
    const paymentService = new PaymentService(models, {
      MP_ACCESS_TOKEN: env.MP_ACCESS_TOKEN,
      JWT_SECRET: env.JWT_SECRET,
      DOMINIO_PUBLICO: env.DOMINIO_PUBLICO,
      logger
    });
    paymentAdapter.initPaymentAdapter(paymentService);

    // Inicializa Cookie Manager
    const cookieManager = new CookieManagerService({
      targetUrl: env.VOUVER_BASE_URL || 'http://vouver.me',
      checkInterval: 300000,
      requireCfClearance: true,
      logger
    });

    let cookiesReady = false;
    try {
      cookiesReady = await cookieManager.checkAndRefreshCookies();
    } catch (err) {
      logger.warn({
        msg: 'Erro ao verificar cookies no boot, continuando com fallback',
        error: err.message
      });
    }
    
    cookieManager.startMonitoring();

    if (cookiesReady) {
      await contentService.atualizarCache(true);
    } else {
      logger.warn({
        msg: 'Cookies incompletos no boot; cache inicial adiado',
        hasSessionCookies: !!cookieManager.sessionCookies,
        hasCfClearance: !!cookieManager.cfClearance
      });
    }

    // Resolve funções do content service
    const buscarDetalhesFn = contentService.buscarDetalhes || contentService.getDetails || contentService.fetchDetails || null;
    const estimarDuracaoFn = contentService.estimarDuracao || contentService.estimateDuration || null;

    // ======================
    // INICIALIZAÇÃO DO BOT (nova estrutura)
    // ======================
    botModule.initBot(
      models,
      {
        CACHE_CONTEUDO: contentService.CACHE_CONTEUDO,
        atualizarCache: contentService.atualizarCache,
        buscarDetalhes: buscarDetalhesFn,
        estimarDuracao: estimarDuracaoFn
      },
      env.DOMINIO_PUBLICO
    );

    // ============================
    // LiveTV Buffer Provisioning
    // ============================
    (async () => {
      try {
        const catalogLiveTV = contentService.CACHE_CONTEUDO?.livetv || [];
        if (catalogLiveTV.length > 0) {
          logger.info({ msg: `Iniciando provisioning de ${catalogLiveTV.length} canais LiveTV` });
          await liveTvBufferProvisioner.provisionAllChannels(catalogLiveTV, models.LiveTvBufferProfile);
          await liveTvBufferProvisioner.startAutoWarmup(models.LiveTvBufferProfile);
        }
      } catch (err) {
        logger.warn({ msg: 'Erro ao provisionar LiveTV buffer', error: err.message });
      }
    })();

    app.locals.services = {
      content: contentService,
      payment: paymentService,
      cookieManager: cookieManager,
      bunnyStorage: bunnyStorageService,
      bunnyCacheService,
      liveTvBufferProvisioner
    };

    const port = env.PORT || 3000;
    const server = app.listen(port, () => {
      logger.info({ msg: `Server iniciado na porta ${port}` });
    });

    // ============================
    // ENCERRAMENTO GRACIOSO
    // ============================
    const gracefulShutdown = async (signal) => {
      logger.info({ msg: `Sinal ${signal} recebido. Encerrando servidor graciosamente...` });
      try {
        server.close(async () => {
          logger.info({ msg: 'Servidor HTTP fechado.' });
          
          // Encerramento do bot (nova referência)
          if (botModule.bot && typeof botModule.bot.stopPolling === 'function') {
            await botModule.bot.stopPolling();
            logger.info({ msg: 'Telegram Bot polling encerrado.' });
          }

          if (mongoose.connection.readyState === 1) {
            await mongoose.disconnect();
            logger.info({ msg: 'Conexão com o MongoDB encerrada.' });
          }
          
          process.exit(0);
        });

        setTimeout(() => {
          logger.error({ msg: 'Encerramento forçado após 10 segundos.' });
          process.exit(1);
        }, 10000);
      } catch (err) {
        logger.error({ msg: 'Erro durante o encerramento gracioso', err });
        process.exit(1);
      }
    };

    process.on('SIGINT', () => gracefulShutdown('SIGINT'));
    process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));

    process.on('uncaughtException', (err) => {
      logger.error({ msg: 'Uncaught Exception detectada!', error: err.stack || err.message });
      gracefulShutdown('uncaughtException');
    });

    process.on('unhandledRejection', (reason) => {
      logger.error({ msg: 'Unhandled Rejection não tratado!', reason: reason?.message });
      const isCritical = reason && (reason.message?.includes('ECONNREFUSED') || reason.code === 'EADDRINUSE');
      if (isCritical) gracefulShutdown('unhandledRejection-critical');
    });

  } catch (error) {
    logger.error({ msg: 'Falha ao iniciar servidor', err: error?.stack || error?.message });
    process.exit(1);
  }
}

module.exports = { startServer };