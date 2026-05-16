const bot = require('../instance');
const config = require('../config');
const paymentService = require('../services/payment.service');
const { formatMoney } = require('../utils/formatters');

function mostrarOpcoesCredito(chatId) {
  const valores = [
    { label: 'R$ 5,00', value: 500 },
    { label: 'R$ 10,00', value: 1000 },
    { label: 'R$ 25,00', value: 2500 },
    { label: 'R$ 50,00', value: 5000 },
    { label: 'R$ 100,00', value: 10000 }
  ];
  
  const keyboard = valores.map(v => [{ 
    text: `${v.label} - ${Math.floor((v.value / config.PRECO_POR_HORA) * 10) / 10}h`, 
    callback_data: `add_${v.value}` 
  }]);
  
  keyboard.push([{ text: '⬅️ Voltar', callback_data: 'back_main' }]);

  bot.sendMessage(chatId, `💰 *Adicionar Créditos*\n\nEscolha o valor:`, {
    parse_mode: 'Markdown',
    reply_markup: { inline_keyboard: keyboard }
  }).catch(err => console.error('Erro ao mostrar opções de crédito:', err));
}

async function handleCheckBalance(chatId, queryId = null) {
  try {
    const saldo = await paymentService.getUserCredits(chatId);
    const text = `💰 *Seu Saldo*\n\nSaldo disponível: ${formatMoney(saldo)}`;
    
    if (queryId) {
      bot.answerCallbackQuery(queryId, { text: `Saldo atual: ${formatMoney(saldo)}`, show_alert: true });
    } else {
      bot.sendMessage(chatId, text, {
        parse_mode: 'Markdown',
        reply_markup: { 
          inline_keyboard: [
            [{ text: '💰 Adicionar Créditos', callback_data: 'menu_add_credits' }], 
            [{ text: '🏠 Menu Principal', callback_data: 'back_main' }]
          ] 
        }
      });
    }
  } catch (error) {
    bot.sendMessage(chatId, '❌ Erro ao consultar saldo.');
  }
}

async function handleGeneratePix(chatId, valor, msgId, queryId) {
  if (isNaN(valor) || valor <= 0) return;

  bot.answerCallbackQuery(queryId, { text: 'Gerando PIX...' }).catch(() => {});
  
  const pix = await paymentService.criarPagamentoPix(chatId, valor);

  if (!pix) {
    return bot.sendMessage(chatId, '❌ Erro ao gerar PIX. O sistema de pagamentos pode estar indisponível.', {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [
          [{ text: '🔄 Tentar novamente', callback_data: `add_${valor}` }],
          [{ text: '🏠 Menu Principal', callback_data: 'back_main' }]
        ]
      }
    });
  }

  if (msgId) bot.deleteMessage(chatId, msgId).catch(() => {});

  await bot.sendMessage(
    chatId,
    `💳 *PIX Gerado - ${formatMoney(valor)}*\n\n*Código Pix (Copia e Cola):*\n<code>${pix.pix_code}</code>`,
    { parse_mode: 'HTML' }
  );

  if (pix.pix_qr_base64) {
    await bot.sendPhoto(chatId, Buffer.from(pix.pix_qr_base64, 'base64'), {
      caption: '📱 QR Code PIX (Escaneie com o app do seu banco)'
    });
  }

  await bot.sendMessage(chatId, '⏳ *Aguardando confirmação do pagamento...*', {
    parse_mode: 'Markdown',
    reply_markup: {
      inline_keyboard: [
        [{ text: '💳 Ver Saldo', callback_data: 'check_balance' }],
        [{ text: '🏠 Menu Principal', callback_data: 'back_main' }]
      ]
    }
  });
}

module.exports = {
  mostrarOpcoesCredito,
  handleCheckBalance,
  handleGeneratePix
};