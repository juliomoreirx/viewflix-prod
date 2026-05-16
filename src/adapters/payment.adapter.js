// src/adapters/payment.adapter.js
let paymentServiceInstance = null;

module.exports = {
  initPaymentAdapter: (service) => {
    paymentServiceInstance = service;
  },
  
  getUserCredits: async (userId) => {
    if (!paymentServiceInstance) return 0;
    return await paymentServiceInstance.getUserCredits(userId);
  },
  
  addCredits: async (userId, centavos) => {
    if (!paymentServiceInstance) return false;
    return await paymentServiceInstance.addCredits(userId, centavos);
  },
  
  criarPagamentoPix: async (userId, valorCentavos) => {
    if (!paymentServiceInstance) return null;
    return await paymentServiceInstance.createPixPayment(userId, valorCentavos);
  },
  
  checkPaymentStatus: async (paymentId) => {
    if (!paymentServiceInstance) return null;
    const result = await paymentServiceInstance.checkPaymentStatus(paymentId);
    return result?.status || null;
  },
  
  processarPagamentoAprovado: async (paymentId, userId, amount) => {
    if (!paymentServiceInstance) return false;
    const result = await paymentServiceInstance.processApprovedPayment(paymentId, userId, amount);
    return result?.success || false;
  }
};