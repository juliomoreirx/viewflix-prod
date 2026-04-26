// src/adapters/payment.adapter.js
// Adapter para integrar PaymentService ao bot (substitui funções antigas)

let paymentService = null;

function initPaymentAdapter(service) {
  paymentService = service;
}

// Wrappers para manter compatibilidade com código existente
async function getUserCredits(userId) {
  if (!paymentService) return 0;
  return await paymentService.getUserCredits(userId);
}

async function addCredits(userId, centavos) {
  if (!paymentService) return false;
  return await paymentService.addCredits(userId, centavos);
}

async function criarPagamentoPix(userId, valorCentavos) {
  if (!paymentService) return null;
  return await paymentService.createPixPayment(userId, valorCentavos);
}

async function checkPaymentStatus(paymentId) {
  if (!paymentService) return null;
  const result = await paymentService.checkPaymentStatus(paymentId);
  return result?.status || null;
}

async function processarPagamentoAprovado(paymentId, userId, amount) {
  if (!paymentService) return false;
  const result = await paymentService.processApprovedPayment(paymentId, userId, amount);
  return result?.success || false;
}

function gerarTokenAcesso(userId, contentId, expirationHours = 24) {
  if (!paymentService) return null;
  return paymentService.generateAccessToken(userId, contentId, expirationHours);
}

function verificarTokenAcesso(token) {
  if (!paymentService) return null;
  return paymentService.verifyAccessToken(token);
}

module.exports = {
  initPaymentAdapter,
  getUserCredits,
  addCredits,
  criarPagamentoPix,
  checkPaymentStatus,
  processarPagamentoAprovado,
  gerarTokenAcesso,
  verificarTokenAcesso
};
