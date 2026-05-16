const db = require('./db.service');
const paymentAdapter = require('../../src/adapters/payment.adapter');

async function getUserCredits(userId) {
  return await paymentAdapter.getUserCredits(userId);
}

async function addCredits(userId, centavos) {
  return await paymentAdapter.addCredits(userId, centavos);
}

async function deductCredits(userId, centavos) {
  try {
    const UserModel = db.getUserModel();
    const user = await UserModel.findOne({ userId });
    if (!user || user.credits < centavos) return false;

    user.credits -= centavos;
    user.totalSpent += centavos;
    user.totalPurchases += 1;
    await user.save();
    return true;
  } catch (error) {
    console.error('Erro ao deduzir créditos:', error);
    return false;
  }
}

async function criarPagamentoPix(userId, valorCentavos) {
  return await paymentAdapter.criarPagamentoPix(userId, valorCentavos);
}

async function checkPaymentStatus(paymentId) {
  return await paymentAdapter.checkPaymentStatus(paymentId);
}

async function processarPagamentoAprovado(paymentId, userId, amount) {
  return await paymentAdapter.processarPagamentoAprovado(paymentId, userId, amount);
}

module.exports = {
  getUserCredits,
  addCredits,
  deductCredits,
  criarPagamentoPix,
  checkPaymentStatus,
  processarPagamentoAprovado,
  adapter: paymentAdapter
};