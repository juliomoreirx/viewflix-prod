const app = require('../app');
const env = require('../config/env');
const logger = require('../lib/logger');

const { connectMongo } = require('../db/mongoose');
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
    app.listen(port, () => {
      logger.info({ msg: `Server iniciado na porta ${port}` });
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