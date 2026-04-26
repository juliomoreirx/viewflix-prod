// src/bot/commands/balance.command.js
// Comandos de saldo e créditos

async function handleBalanceCommand(bot, msg, { paymentAdapter, sessionService }) {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  
  try {
    const saldo = await paymentAdapter.getUserCredits(userId);
    const formatMoney = (centavos) => `R$ ${(centavos / 100).toFixed(2)}`;
    
    await bot.sendMessage(chatId, `💰 *Seu Saldo*\n\nSaldo disponível: ${formatMoney(saldo)}`, {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [
          [{ text: '💳 Adicionar Créditos', callback_data: 'menu_add_credits' }],
          [{ text: '🏠 Voltar', callback_data: 'back_main' }]
        ]
      }
    });
  } catch (error) {
    console.error('[BalanceCommand] Erro:', error.message);
    await bot.sendMessage(chatId, '❌ Erro ao obter saldo.');
  }
}

function handleAddCreditsCommand(bot, msg) {
  const chatId = msg.chat.id;
  
  const valores = [
    { label: 'R$ 5,00', value: 500 },
    { label: 'R$ 10,00', value: 1000 },
    { label: 'R$ 25,00', value: 2500 },
    { label: 'R$ 50,00', value: 5000 },
    { label: 'R$ 100,00', value: 10000 }
  ];
  
  const keyboard = valores.map(v => 
    [{ text: `${v.label}`, callback_data: `add_${v.value}` }]
  );
  keyboard.push([{ text: '⬅️ Voltar', callback_data: 'back_main' }]);
  
  bot.sendMessage(chatId, '💳 *Adicionar Créditos*\n\nEscolha o valor:', {
    parse_mode: 'Markdown',
    reply_markup: { inline_keyboard: keyboard }
  });
}

module.exports = {
  handleBalanceCommand,
  handleAddCreditsCommand
};
