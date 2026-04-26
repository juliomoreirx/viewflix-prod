// src/bot/actions/index.js
// Centraliza todos os actions (callbacks de botões)

const { handleMainMenuAction } = require('./menu.action');
const { handleCheckBalanceAction, handleAddCreditsAction } = require('./balance.action');

/**
 * Registra todos os callback handlers
 */
function registerAllActions(bot, deps) {
  bot.on('callback_query', async (query) => {
    const data = query.data;
    
    try {
      // Menu
      if (data === 'back_main') {
        return handleMainMenuAction(bot, query, deps);
      }
      
      // Saldo
      if (data === 'check_balance') {
        return handleCheckBalanceAction(bot, query, deps);
      }
      
      if (data.startsWith('add_')) {
        return handleAddCreditsAction(bot, query, deps);
      }
      
      // Outros actions serão adicionados aqui...
      // (search, my_content, watch, buy, etc)
      
    } catch (error) {
      console.error('[ActionsHandler] Erro:', error.message);
      bot.answerCallbackQuery(query.id, { text: '❌ Erro ao processar ação' });
    }
  });
}

module.exports = { registerAllActions };
