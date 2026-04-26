// src/bot/actions/menu.action.js
// Actions para navegação de menu

function handleMainMenuAction(bot, query, { sessionService }) {
  const chatId = query.message.chat.id;
  
  sessionService.clearUserState(chatId);
  sessionService.setUserState(chatId, { step: 'menu' });
  
  const keyboard = [
    [{ text: '🎬 Buscar Filmes', callback_data: 'search_movies' }],
    [{ text: '📺 Buscar Séries', callback_data: 'search_series' }],
    [{ text: '📦 Meu Conteúdo', callback_data: 'my_content' }],
    [{ text: '💰 Meu Saldo', callback_data: 'check_balance' }],
    [{ text: '💳 Adicionar Créditos', callback_data: 'menu_add_credits' }]
  ];
  
  bot.editMessageText('🏠 *Menu Principal*', {
    chat_id: chatId,
    message_id: query.message.message_id,
    parse_mode: 'Markdown',
    reply_markup: { inline_keyboard: keyboard }
  }).catch(() => {});
  
  bot.answerCallbackQuery(query.id);
}

module.exports = {
  handleMainMenuAction
};
