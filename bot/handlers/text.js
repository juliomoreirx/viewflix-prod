// bot/handlers/text.js
const bot = require('../instance');
const state = require('../state');
const catalogController = require('../controllers/catalog.controller');
const contentController = require('../controllers/content.controller');
const paymentController = require('../controllers/payment.controller');

module.exports = function registerTextHandlers() {
  bot.on('message', async (msg) => {
    // Ignora mensagens de sistema, sem texto ou que sejam comandos (iniciam com /)
    if (!msg.text || msg.text.startsWith('/')) return;

    const chatId = msg.chat.id;
    const text = msg.text.trim();

    try {
      // 🚀 ATUALIZADO: Leitura Assíncrona do Redis para varrer os passos de digitação livre
      const currentState = await state.getUserState(chatId);
      const step = currentState?.step;

      // ==========================================
      // GERENCIAMENTO DE BUSCAS TEXTUAIS ABERTAS
      // ==========================================
      if (step === 'search_movies') {
        return catalogController.renderBuscaPaginada(chatId, text, 'movies');
      } else if (step === 'search_series') {
        return catalogController.renderBuscaPaginada(chatId, text, 'series');
      } else if (step === 'search_livetv' || step === 'search_live') {
        return catalogController.renderBuscaCanaisPaginada(chatId, text);
      }

      // ==========================================
      // CAPTURA DOS BOTÕES DO TECLADO PRINCIPAL (KEYBOARD)
      // ==========================================
      if (text === '🔍 Buscar Filmes') return catalogController.iniciarBusca(chatId, 'movies');
      if (text === '📺 Buscar Séries') return catalogController.iniciarBusca(chatId, 'series');
      if (text === '📡 Canais ao Vivo') return catalogController.listarCanaisAoVivo(chatId, 1);
      if (text === '🔎 Buscar Canais') return catalogController.iniciarBusca(chatId, 'livetv');
      
      if (text === '🎬 Filmes A-Z') return catalogController.mostrarAlfabeto(chatId, 'movies');
      if (text === '📺 Séries A-Z') return catalogController.mostrarAlfabeto(chatId, 'series');
      
      if (text === '📦 Meu Conteúdo') {
         return contentController.mostrarMeuConteudo(chatId);
      }
      
      if (text === '🔞 Conteúdo +18') {
         return bot.sendMessage(chatId, '🔞 Categoria especial em desenvolvimento.');
      }
      
      if (text === '💰 Adicionar Créditos') {
         return paymentController.mostrarOpcoesCredito(chatId);
      }
      
      if (text === '💳 Meu Saldo') {
         return paymentController.handleCheckBalance(chatId);
      }

      // Se não combinar com nada, não fazemos eco para não sujar o chat

    } catch (error) {
      console.error('❌ Erro no handler de texto principal:', error.message);
    }
  });
};