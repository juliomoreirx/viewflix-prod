// src/bot/commands/start.command.js
// Comando /start - inicializa usuário e mostra menu principal

async function handleStartCommand(bot, msg, { userService, paymentAdapter, sessionService, escaparMarkdownSeguro, sanitizarTexto }) {
  const chatId = msg.chat.id;
  const userId = msg.from.id;

  try {
    const { isNew, user } = await userService.verificarOuCriarUsuario(msg);
    
    await sessionService.clearUserState(chatId);
    sessionService.setUserState(chatId, { step: 'menu' });

    const saldo = await paymentAdapter.getUserCredits(userId);
    const nomeSeguro = sanitizarTexto(user?.firstName || 'Usuário');

    const welcome = isNew
      ? `🎉 *Bem-vindo ao FastTV, ${nomeSeguro}!*\n\n✅ Conta criada com sucesso!\n\n🍿 Use os botões abaixo para explorar.`
      : `👋 *Bem-vindo de volta, ${nomeSeguro}!*`;

    const keyboard = [
      [{ text: '🎬 Buscar Filmes', callback_data: 'search_movies' }],
      [{ text: '📺 Buscar Séries', callback_data: 'search_series' }],
      [{ text: '📦 Meu Conteúdo', callback_data: 'my_content' }],
      [{ text: '💰 Meu Saldo', callback_data: 'check_balance' }],
      [{ text: '💳 Adicionar Créditos', callback_data: 'menu_add_credits' }]
    ];

    await bot.sendMessage(chatId, welcome, {
      parse_mode: 'Markdown',
      reply_markup: { inline_keyboard: keyboard }
    });
  } catch (error) {
    console.error('[StartCommand] Erro:', error.message);
    await bot.sendMessage(chatId, '❌ Erro ao inicializar. Tente novamente com /start');
  }
}

module.exports = { handleStartCommand };
