const bot = require('../instance');
const authController = require('../controllers/auth.controller');
const paymentController = require('../controllers/payment.controller');

module.exports = function registerCommands() {
  bot.onText(/\/start/, (msg) => authController.handleStart(msg));
  bot.onText(/\/saldo/, (msg) => paymentController.handleCheckBalance(msg.chat.id));
  
  // Exemplo para retentar cache (Você pode jogar isso pro ContentController depois)
  bot.onText(/\/requeue_(.+)/, async (msg, match) => {
    bot.sendMessage(msg.chat.id, '♻️ Comando de requeue recebido. O administrador foi notificado.');
  });
};