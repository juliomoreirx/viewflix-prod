// bot/handlers/callbacks.js
const bot = require('../instance');
const state = require('../state');
const catalogController = require('../controllers/catalog.controller');
const paymentController = require('../controllers/payment.controller');
const contentController = require('../controllers/content.controller');

module.exports = function registerCallbackHandlers() {
  bot.on('callback_query', async (query) => {
    const chatId = query.message.chat.id;
    const data = query.data;
    const msgId = query.message.message_id;

    try {
      if (data === 'noop') return bot.answerCallbackQuery(query.id);

      // Botão Padrão de Retorno ao Menu
      if (data === 'back_main') {
        bot.answerCallbackQuery(query.id);
        bot.deleteMessage(chatId, msgId).catch(() => {});
        state.clearUserState(chatId);
        return catalogController.showMainMenu(chatId);
      }

      // ==========================================
      // GESTÃO DE CATÁLOGO (A-Z)
      // ==========================================
      if (data.startsWith('alphabet_')) return catalogController.mostrarAlfabeto(chatId, data.split('_')[1]);
      if (data.startsWith('letter_')) {
        const [, tipo, letra, pagina] = data.split('_');
        bot.deleteMessage(chatId, msgId).catch(() => {});
        return catalogController.listarPorLetra(chatId, tipo, letra, parseInt(pagina, 10));
      }

      // ==========================================
      // PAGINAÇÃO E CONTROLE DAS BUSCAS TEXTUAIS
      // ==========================================
      if (data.startsWith('searchpage_')) {
        bot.answerCallbackQuery(query.id);
        const pagina = parseInt(data.split('_')[1], 10);
        const currentState = state.getUserState(chatId);
        if (currentState && currentState.searchTerm) {
          return catalogController.renderBuscaPaginada(chatId, currentState.searchTerm, currentState.searchType, pagina, msgId);
        }
      }
      if (data.startsWith('livesearchpage_')) {
        bot.answerCallbackQuery(query.id);
        const pagina = parseInt(data.split('_')[1], 10);
        const currentState = state.getUserState(chatId);
        if (currentState && currentState.searchTerm) {
          return catalogController.renderBuscaCanaisPaginada(chatId, currentState.searchTerm, pagina, msgId);
        }
      }
      
      // Paginação da Lista Geral de Canais
      if (data.startsWith('livepage_')) {
        bot.answerCallbackQuery(query.id);
        bot.deleteMessage(chatId, msgId).catch(() => {});
        return catalogController.listarCanaisAoVivo(chatId, parseInt(data.split('_')[1], 10));
      }
      
      // Botão "Lista Completa" nos resultados da busca de canais
      if (data === 'list_livetv') {
        bot.answerCallbackQuery(query.id);
        bot.deleteMessage(chatId, msgId).catch(() => {});
        return catalogController.listarCanaisAoVivo(chatId, 1);
      }

      if (data.startsWith('retry_search_')) {
        bot.answerCallbackQuery(query.id);
        bot.deleteMessage(chatId, msgId).catch(() => {});
        return catalogController.iniciarBusca(chatId, data.split('_')[2]);
      }

      // ==========================================
      // FLUXO DE DETALHES E INTERAÇÃO PRINCIPAL
      // ==========================================
      if (data.startsWith('details_')) return contentController.handleDetails(query);
      if (data.startsWith('season_')) return contentController.handleSeason(query);
      if (data.startsWith('episode_')) return contentController.handleEpisode(query);
      
      // Execuções de compras e playbacks
      if (data.startsWith('watch_movie_')) return contentController.handleWatchMovie(query);
      if (data.startsWith('watch_ep_')) return contentController.handleWatchEpisode(query);
      if (data.startsWith('buy_season_')) return contentController.handleBuySeason(query);
      if (data.startsWith('watch_live_')) return contentController.handleWatchLive(query);

      // ==========================================
      // INTERFACE DO "MEU CONTEÚDO"
      // ==========================================
      if (data === 'my_content') {
        bot.deleteMessage(chatId, msgId).catch(() => {});
        return contentController.mostrarMeuConteudo(chatId);
      }
      if (data === 'mycontent_movies') {
        bot.deleteMessage(chatId, msgId).catch(() => {});
        return contentController.mostrarMeuConteudoFilmes(chatId, 1);
      }
      if (data.startsWith('mycontent_movies_page_')) {
        bot.deleteMessage(chatId, msgId).catch(() => {});
        return contentController.mostrarMeuConteudoFilmes(chatId, parseInt(data.split('_').pop(), 10));
      }
      if (data === 'mycontent_series') {
        bot.deleteMessage(chatId, msgId).catch(() => {});
        return contentController.mostrarMeuConteudoSeries(chatId, 1);
      }
      if (data.startsWith('mycontent_series_page_')) {
        bot.deleteMessage(chatId, msgId).catch(() => {});
        return contentController.mostrarMeuConteudoSeries(chatId, parseInt(data.split('_').pop(), 10));
      }
      if (data === 'mycontent_live') {
        bot.deleteMessage(chatId, msgId).catch(() => {});
        return contentController.mostrarMeuConteudoLive(chatId, 1);
      }
      if (data.startsWith('mycontent_live_page_')) {
        bot.deleteMessage(chatId, msgId).catch(() => {});
        return contentController.mostrarMeuConteudoLive(chatId, parseInt(data.split('_').pop(), 10));
      }
      if (data.startsWith('myseries_')) {
        const parts = data.split('_');
        const index = parseInt(parts[1], 10);
        bot.deleteMessage(chatId, msgId).catch(() => {});
        if (parts.length >= 4 && parts[2] === 'page') {
          return contentController.mostrarMeuConteudoSerieDetalhes(chatId, index, parseInt(parts[3], 10));
        }
        return contentController.mostrarMeuConteudoSerieDetalhes(chatId, index, 1);
      }
      if (data.startsWith('mycontent_details_')) {
        bot.deleteMessage(chatId, msgId).catch(() => {});
        return contentController.mostrarDetalhesConteudo(chatId, data.split('_')[2]);
      }

      // ==========================================
      // FINANCEIRO (CRÉDITOS E SALDO)
      // ==========================================
      if (data === 'menu_add_credits') {
        bot.deleteMessage(chatId, msgId).catch(() => {});
        return paymentController.mostrarOpcoesCredito(chatId);
      }
      if (data.startsWith('add_')) {
        return paymentController.handleGeneratePix(chatId, parseInt(data.split('_')[1], 10), msgId, query.id);
      }
      if (data === 'check_balance') return paymentController.handleCheckBalance(chatId, query.id);

      // ==========================================
      // 🚀 FALLBACK SEGURO PARA AÇÕES EXPIRADAS OU INVÁLIDAS
      // ==========================================
      bot.answerCallbackQuery(query.id, { text: '⚠️ Ação inválida ou expirada. Retornando ao menu.', show_alert: true }).catch(() => {});
      bot.deleteMessage(chatId, msgId).catch(() => {});
      state.clearUserState(chatId);
      return catalogController.showMainMenu(chatId);

    } catch (error) {
      console.error('Erro crítico no interceptor de callbacks:', error);
      bot.answerCallbackQuery(query.id, { text: 'Erro ao processar ação inline. Tente novamente.' }).catch(() => {});
      catalogController.showMainMenu(chatId);
    }
  });
};