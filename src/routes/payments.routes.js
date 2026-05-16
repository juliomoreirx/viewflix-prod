// src/routes/payments.routes.js
const express = require('express');
const axios = require('axios');
const asyncHandler = require('../middlewares/async-handler');
const env = require('../config/env');
const logger = require('../lib/logger');
const telegramBot = require('../../bot'); // APONTA PARA A NOVA PASTA

const router = express.Router();

router.post('/webhook/mercadopago', asyncHandler(async (req, res) => {
  logger.info({ msg: 'Webhook Mercado Pago recebido' });

  try {
    let paymentId = null;
    const body = req.body || {};

    // Extrair ID do pagamento (Mercado Pago tem várias formas de enviar)
    if (body.type === 'payment' && body.data?.id) {
      paymentId = body.data.id;
    } else if (body.action === 'payment.updated' && body.data?.id) {
      paymentId = body.data.id;
    } else if (body.topic === 'payment' && body.resource) {
      const parts = String(body.resource).split('/');
      paymentId = parts[parts.length - 1];
    } else {
      return res.sendStatus(200); // Ignorar eventos que não são de pagamento
    }

    if (!env.MP_ACCESS_TOKEN) {
      logger.warn({ msg: 'MP_ACCESS_TOKEN ausente - ignorando webhook' });
      return res.sendStatus(200);
    }

    // Consultar o pagamento direto na API do Mercado Pago por segurança
    const response = await axios.get(
      `https://api.mercadopago.com/v1/payments/${paymentId}`,
      {
        headers: { Authorization: `Bearer ${env.MP_ACCESS_TOKEN}` },
        timeout: 10000
      }
    );

    const payment = response.data;

    if (payment?.status === 'approved') {
      const userId = parseInt(payment.external_reference, 10);
      const amount = Math.round(Number(payment.transaction_amount || 0) * 100);

      if (!userId || !amount) {
        logger.warn({ msg: 'Pagamento aprovado sem userId/amount válidos', paymentId });
        return res.sendStatus(200);
      }

      // Comunica o acréscimo de saldo ao nosso novo BOT
      const sucesso = await telegramBot.processarPagamentoAprovado(paymentId, userId, amount);

      if (sucesso) {
        logger.info({ msg: 'Créditos adicionados via webhook', paymentId, userId, amountCentavos: amount });
      } else {
        logger.warn({ msg: 'Falha ao processar pagamento aprovado', paymentId, userId });
      }
    }

    return res.sendStatus(200);
  } catch (error) {
    logger.error({ msg: 'Erro no webhook Mercado Pago', err: error.message });
    return res.sendStatus(200);
  }
}));

module.exports = router;