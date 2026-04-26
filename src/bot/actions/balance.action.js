// src/bot/actions/balance.action.js
// Actions para operações de saldo

async function handleCheckBalanceAction(bot, query, { paymentAdapter }) {
  const userId = query.from.id;
  const chatId = query.message.chat.id;
  
  try {
    const saldo = await paymentAdapter.getUserCredits(userId);
    const formatMoney = (centavos) => `R$ ${(centavos / 100).toFixed(2)}`;
    
    bot.answerCallbackQuery(query.id, {
      text: `Saldo: ${formatMoney(saldo)}`,
      show_alert: true
    });
  } catch (error) {
    bot.answerCallbackQuery(query.id, { text: 'Erro ao obter saldo' });
  }
}

async function handleAddCreditsAction(bot, query, { paymentAdapter, sessionService, formatMoney }) {
  const chatId = query.message.chat.id;
  const userId = query.from.id;
  const valor = parseInt(query.data.split('_')[1], 10);
  
  if (isNaN(valor) || valor <= 0) return;
  
  bot.answerCallbackQuery(query.id, { text: '⏳ Gerando PIX...' });
  
  try {
    const pix = await paymentAdapter.criarPagamentoPix(userId, valor);
    
    if (!pix) {
      await bot.sendMessage(chatId, '❌ Erro ao gerar PIX.', {
        parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: [[{ text: '🔄 Tentar Novamente', callback_data: `add_${valor}` }]] }
      });
      return;
    }
    
    const mensagem = `💳 *PIX Gerado - ${formatMoney(valor)}*\n\n*Código Pix:*\n<code>${pix.pix_code}</code>\n\n⏳ *Aguardando confirmação do pagamento...*`;
    
    await bot.sendMessage(chatId, mensagem, { parse_mode: 'HTML' });
    await bot.sendMessage(chatId, `[QR Code - Escaneie para pagar]\n\n⏱️ Este PIX expira em 15 minutos.`);
    
  } catch (error) {
    console.error('[AddCreditsAction] Erro:', error.message);
    await bot.sendMessage(chatId, '❌ Erro ao processar pagamento.');
  }
}

module.exports = {
  handleCheckBalanceAction,
  handleAddCreditsAction
};
