const app = require('../app');
const env = require('../config/env');
const logger = require('../lib/logger');

const { connectMongo, mongoose } = require('../db/mongoose');
const models = require('../models');

const telegramBot = require('../../telegram-bot');
const contentService = require('../services/content-cache.service');

async function startServer() {
  try {
    logger.info({
      msg: 'Boot env check',
      hasSessionCookiesEnv: !!env.SESSION_COOKIES,
      sessionEnvLength: env.SESSION_COOKIES ? String(env.SESSION_COOKIES).length : 0
    });

    await connectMongo();
    app.locals.models = models;

    // Carrega cache antes de iniciar bot (importante)
    await contentService.atualizarCache(true);

    // Resolve nomes alternativos de funções do service
    const buscarDetalhesFn =
      contentService.buscarDetalhes ||
      contentService.getDetails ||
      contentService.fetchDetails ||
      null;

    const estimarDuracaoFn =
      contentService.estimarDuracao ||
      contentService.estimateDuration ||
      null;

    telegramBot.initBot(
      models,
      {
        CACHE_CONTEUDO: contentService.CACHE_CONTEUDO, // referência viva
        atualizarCache: contentService.atualizarCache,
        buscarDetalhes: buscarDetalhesFn,
        estimarDuracao: estimarDuracaoFn
      },
      env.DOMINIO_PUBLICO
    );

    app.locals.services = {
      content: contentService
    };

    const port = env.PORT || 3000;
    const server = app.listen(port, () => {
      logger.info({ msg: `Server iniciado na porta ${port}` });
    });

    // ============================
    // ENCERRAMENTO GRACIOSO (Graceful Shutdown)
    // ============================
    const gracefulShutdown = async (signal) => {
      logger.info({ msg: `Sinal ${signal} recebido. Encerrando servidor graciosamente...` });
      try {
        server.close(async () => {
          logger.info({ msg: 'Servidor HTTP fechado.' });
          
          // Se o bot estiver rodando online via polling
          if (telegramBot.bot && typeof telegramBot.bot.stopPolling === 'function') {
            await telegramBot.bot.stopPolling();
            logger.info({ msg: 'Telegram Bot polling encerrado.' });
          }

          // Desconexão do banco de dados
          if (mongoose.connection.readyState === 1) {
            await mongoose.disconnect();
            logger.info({ msg: 'Conexão com o MongoDB encerrada.' });
          }
          
          process.exit(0);
        });

        // Caso as conexões demorem muito a fechar
        setTimeout(() => {
          logger.error({ msg: 'Encerramento forçado do processo após 10 segundos.' });
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

    process.on('unhandledRejection', (reason, promise) => {
      logger.error({ msg: 'Unhandled Rejection não tratado!', promise, reason });
      gracefulShutdown('unhandledRejection');
    });

  } catch (error) {
    logger.error({
      msg: 'Falha ao iniciar servidor',
      err: error?.stack || error?.message || String(error)
    });
    process.exit(1);
  }
}

module.exports = { startServer };