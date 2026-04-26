// src/bot/commands/search.command.js
// Comandos para buscar filmes, séries e conteúdo adulto

function handleSearchMoviesCommand(bot, msg, { sessionService }) {
  const chatId = msg.chat.id;
  sessionService.setUserState(chatId, { step: 'search_movies' });
  
  bot.sendMessage(chatId, '🎬 *Buscar Filmes*\n\nDigite o nome do filme:', {
    parse_mode: 'Markdown',
    reply_markup: { inline_keyboard: [[{ text: '⬅️ Voltar', callback_data: 'back_main' }]] }
  });
}

function handleSearchSeriesCommand(bot, msg, { sessionService }) {
  const chatId = msg.chat.id;
  sessionService.setUserState(chatId, { step: 'search_series' });
  
  bot.sendMessage(chatId, '📺 *Buscar Séries*\n\nDigite o nome da série:', {
    parse_mode: 'Markdown',
    reply_markup: { inline_keyboard: [[{ text: '⬅️ Voltar', callback_data: 'back_main' }]] }
  });
}

function handleSearchAdultCommand(bot, msg, { sessionService }) {
  const chatId = msg.chat.id;
  sessionService.setUserState(chatId, { step: 'search_adult' });
  
  bot.sendMessage(chatId, '🔞 *Conteúdo Adulto*\n\nDigite o termo de busca:', {
    parse_mode: 'Markdown',
    reply_markup: { inline_keyboard: [[{ text: '⬅️ Voltar', callback_data: 'back_main' }]] }
  });
}

module.exports = {
  handleSearchMoviesCommand,
  handleSearchSeriesCommand,
  handleSearchAdultCommand
};
