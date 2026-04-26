// src/bot/bot.setup.js
// Inicializa o bot e registra todos os comandos e actions

const { registerAllCommands } = require('./commands');
const { registerAllActions } = require('./actions');

/**
 * Configura o bot com todos os comandos e handlers
 */
function setupBot(bot, models, services, envVars, textUtils) {
  // Preparar dependências que serão passadas aos handlers
  const deps = {
    userService: {
      verificarOuCriarUsuario: services.verificarOuCriarUsuario || (() => ({}))
    },
    paymentAdapter: services.paymentAdapter,
    sessionService: services.sessionService,
    contentService: services.content,
    escaparMarkdownSeguro: textUtils.escaparMarkdownSeguro,
    sanitizarTexto: textUtils.sanitizarTexto,
    removerAcentos: textUtils.removerAcentos,
    formatMoney: (centavos) => `R$ ${(centavos / 100).toFixed(2)}`
  };

  // Registra todos os comandos (/start, /search, etc)
  registerAllCommands(bot, deps);

  // Registra todos os actions (callback_query)
  registerAllActions(bot, deps);

  console.log('✅ [Bot] Todos os comandos e actions registrados com sucesso');
  
  return bot;
}

module.exports = { setupBot };
