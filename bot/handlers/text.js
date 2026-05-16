// bot/handlers/text.js
const bot = require('../instance');
const state = require('../state');
const catalogController = require('../controllers/catalog.controller');
const paymentController = require('../controllers/payment.controller');
const contentController = require('../controllers/content.controller');

module.exports = function registerTextHandlers() {
  // Cliques nos Botões Fixos de Navegação do Teclado
  bot.onText(/🎬 Filmes A-Z/, (msg) => catalogController.mostrarAlfabeto(msg.chat.id, 'movies'));
  bot.onText(/📺 Séries A-Z/, (msg) => catalogController.mostrarAlfabeto(msg.chat.id, 'series'));
  bot.onText(/📡 Canais ao Vivo/, (msg) => catalogController.listarCanaisAoVivo(msg.chat.id, 1));
  bot.onText(/📦 Meu Conteúdo/, (msg) => contentController.mostrarMeuConteudo(msg.chat.id));
  bot.onText(/💳 Meu Saldo/, (msg) => paymentController.handleCheckBalance(msg.chat.id));
  bot.onText(/💰 Adicionar Créditos/, (msg) => paymentController.mostrarOpcoesCredito(msg.chat.id));

  // GATILHOS DE BUSCA: O que estava faltando para abrir o prompt!
  bot.onText(/🔍 Buscar Filmes/, (msg) => catalogController.iniciarBusca(msg.chat.id, 'movies'));
  bot.onText(/📺 Buscar Séries/, (msg) => catalogController.iniciarBusca(msg.chat.id, 'series'));
  bot.onText(/🔎 Buscar Canais/, (msg) => catalogController.iniciarBusca(msg.chat.id, 'livetv'));

  // Ouvinte Genérico para processar o texto digitado na busca
  bot.on('message', async (msg) => {
    const chatId = msg.chat.id;
    const text = msg.text;
    
    // Ignora se for um comando ou se for o clique em qualquer botão do menu
    if (!text || text.startsWith('/') || /🔍|🔎|📺|📡|🔞|💰|💳|🎬|📦/.test(text)) return;

    const currentState = state.getUserState(chatId);
    if (!currentState || !currentState.step) return;

    // Roteia o termo digitado para o buscador correto baseado no step da sessão
    if (currentState.step === 'search_movies') {
      return catalogController.renderBuscaPaginada(chatId, text, 'movies', 1);
    }
    if (currentState.step === 'search_series') {
      return catalogController.renderBuscaPaginada(chatId, text, 'series', 1);
    }
    if (currentState.step === 'search_livetv') {
      return catalogController.renderBuscaCanaisPaginada(chatId, text, 1);
    }
  });
};