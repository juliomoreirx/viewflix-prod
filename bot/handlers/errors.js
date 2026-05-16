const bot = require('../instance');

module.exports = function registerErrorHandlers() {
  bot.on('polling_error', (error) => {
    if (error.code === 'ETELEGRAM') {
      const errorCode = error.response?.body?.error_code;
      const errorMsg = error.response?.body?.description || error.message;
      
      // Ignorar erros normais do Telegram que não devem derrubar ou poluir o log da aplicação
      if (errorCode === 409) {
        // Conflito de polling (ocorre quando duas instâncias tentam rodar ao mesmo tempo)
        return;
      }
      
      if (errorCode === 400 && errorMsg?.includes('query')) {
        // Query de callback muito antiga — o Telegram descarta automaticamente
        return;
      }
      
      console.error(`❌ Erro de polling do bot (ETELEGRAM): [${errorCode}] ${errorMsg}`);
    } else {
      console.error('❌ Erro de polling genérico do bot:', error.message);
    }
  });
};