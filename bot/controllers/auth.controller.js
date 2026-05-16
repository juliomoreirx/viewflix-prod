const bot = require('../instance');
const state = require('../state');
const userService = require('../services/user.service');
const paymentService = require('../services/payment.service');
const contentService = require('../services/content.service');
const catalogController = require('./catalog.controller');
const { formatMoney } = require('../utils/formatters');
const { sanitizarTexto, escaparMarkdownSeguro } = require('../../src/services/text-utils.service');

async function handleStart(msg) {
  const chatId = msg.chat.id;

  try {
    await contentService.ensureCacheLoaded();

    const resultado = await userService.verificarOuCriarUsuario(msg);
    if (!resultado) {
      return bot.sendMessage(chatId, '❌ Erro ao acessar o sistema. Tente novamente em alguns instantes.');
    }

    const { isNew, user } = resultado;
    const bloqueio = await userService.verificarBloqueio(chatId);

    if (bloqueio.blocked) {
      return bot.sendMessage(chatId,
        `🚫 *Acesso Bloqueado*\n\n${escaparMarkdownSeguro(bloqueio.reason)}\n\nEntre em contato com o suporte.`,
        { parse_mode: 'Markdown' }
      );
    }

    state.clearUserState(chatId);
    state.setUserState(chatId, { step: 'menu' });

    const bonusInfo = await userService.concederBonusInicialSeElegivel(user, isNew, paymentService);

    const cache = contentService.getCacheSafe();
    const totalFilmes = (cache.movies || []).length;
    const totalSeries = (cache.series || []).length;
    const totalCanais = (cache.livetv || []).length;
    const totalConteudo = totalFilmes + totalSeries + totalCanais;
    
    const saldo = await paymentService.getUserCredits(chatId);
    const nomeSeguro = sanitizarTexto(user.firstName);

    const bonusMensagem = bonusInfo.granted
      ? `\n\n🎁 *Bônus de Boas-Vindas Liberado Hoje!*\nVocê recebeu ${formatMoney(bonusInfo.amount)} em créditos iniciais para começar agora.`
      : '';

    const welcome = isNew
      ? `🎉 *Bem-vindo ao FastTV, ${nomeSeguro}!*\n\n✅ Conta criada com sucesso!\n\n📊 Catálogo:\n🎥 ${totalFilmes.toLocaleString('pt-BR')} filmes\n📺 ${totalSeries.toLocaleString('pt-BR')} séries\n📡 ${totalCanais.toLocaleString('pt-BR')} canais ao vivo\n📦 ${totalConteudo.toLocaleString('pt-BR')} conteúdos\n\n💰 Saldo: ${formatMoney(saldo)}${bonusMensagem}`
      : `🎬 *Bem-vindo de volta, ${nomeSeguro}!*\n\n📊 Catálogo:\n🎥 ${totalFilmes.toLocaleString('pt-BR')} filmes\n📺 ${totalSeries.toLocaleString('pt-BR')} séries\n📡 ${totalCanais.toLocaleString('pt-BR')} canais ao vivo\n📦 ${totalConteudo.toLocaleString('pt-BR')} conteúdos\n\n💰 Saldo: ${formatMoney(saldo)}`;

    catalogController.showMainMenu(chatId, welcome);
  } catch (error) {
    console.error('Erro no controller de auth (start):', error);
    bot.sendMessage(chatId, '❌ Erro ao iniciar. Tente novamente com /start');
  }
}

module.exports = {
  handleStart
};