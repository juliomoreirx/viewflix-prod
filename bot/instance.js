const TelegramBot = require('node-telegram-bot-api');
const config = require('./config');

if (!config.BOT_TOKEN) {
  console.error('❌ ERRO CRÍTICO: BOT_TOKEN não definido no .env');
  process.exit(1);
}

if (!config.JWT_SECRET) {
  console.error('❌ ERRO CRÍTICO: JWT_SECRET não definido no .env');
  process.exit(1);
}

// Instância Singleton do Bot
const bot = new TelegramBot(config.BOT_TOKEN, { polling: false });

module.exports = bot;