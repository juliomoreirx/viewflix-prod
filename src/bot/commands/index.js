// src/bot/commands/index.js
// Centraliza todos os comandos

const { handleStartCommand } = require('./start.command');
const { handleSearchMoviesCommand, handleSearchSeriesCommand, handleSearchAdultCommand } = require('./search.command');
const { handleBalanceCommand, handleAddCreditsCommand } = require('./balance.command');

/**
 * Registra todos os comandos do bot
 */
function registerAllCommands(bot, deps) {
  // /start
  bot.onText(/\/start/, (msg) => handleStartCommand(bot, msg, deps));

  // Busca
  bot.onText(/🎬 Buscar Filmes/, (msg) => handleSearchMoviesCommand(bot, msg, deps));
  bot.onText(/📺 Buscar Séries/, (msg) => handleSearchSeriesCommand(bot, msg, deps));
  bot.onText(/🔞 Conteúdo \+18/, (msg) => handleSearchAdultCommand(bot, msg, deps));

  // Saldo e Créditos
  bot.onText(/💰 Meu Saldo|💳 Meu Saldo/, async (msg) => handleBalanceCommand(bot, msg, deps));
  bot.onText(/💳 Adicionar Créditos/, (msg) => handleAddCreditsCommand(bot, msg));
}

module.exports = { registerAllCommands };
