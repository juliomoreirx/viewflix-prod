// src/services/session.service.js

class SessionService {
  constructor() {
    this.userStates = {};
    this.pendingPayments = {};
    this.paymentCheckIntervals = {};

    // Inicia o Garbage Collector automaticamente
    this.iniciarGarbageCollector();
  }

  // ==========================
  // ESTADOS DE USUÁRIO
  // ==========================
  getUserState(chatId) {
    return this.userStates[chatId] || null;
  }

  setUserState(chatId, stateData) {
    this.userStates[chatId] = { ...stateData, updatedAt: Date.now() };
  }

  clearUserState(chatId) {
    if (this.userStates[chatId]) {
      delete this.userStates[chatId];
    }
  }

  // ==========================
  // PAGAMENTOS PENDENTES
  // ==========================
  getPendingPayment(paymentId) {
    return this.pendingPayments[paymentId] || null;
  }

  setPendingPayment(paymentId, data) {
    this.pendingPayments[paymentId] = { ...data, timestamp: Date.now() };
  }

  deletePendingPayment(paymentId) {
    if (this.pendingPayments[paymentId]) {
      delete this.pendingPayments[paymentId];
    }
  }

  setPaymentInterval(paymentId, intervalId) {
    this.paymentCheckIntervals[paymentId] = intervalId;
  }

  clearIntervalAndPayment(paymentId) {
    if (this.paymentCheckIntervals[paymentId]) {
      clearInterval(this.paymentCheckIntervals[paymentId]);
      delete this.paymentCheckIntervals[paymentId];
    }
    this.deletePendingPayment(paymentId);
  }

  // ==========================
  // GARBAGE COLLECTOR
  // ==========================
  iniciarGarbageCollector() {
    // Limpa memória a cada 30 minutos
    setInterval(() => {
      const agora = Date.now();
      
      // Limpar estados inativos há mais de 1 hora (3600000 ms)
      for (const chatId in this.userStates) {
        if (this.userStates[chatId].updatedAt && (agora - this.userStates[chatId].updatedAt > 3600000)) {
          delete this.userStates[chatId];
        }
      }
      
      // Limpar pagamentos pendentes expirados há mais de 30 min (1800000 ms)
      for (const pixId in this.pendingPayments) {
        if (this.pendingPayments[pixId].timestamp && (agora - this.pendingPayments[pixId].timestamp > 1800000)) {
          this.clearIntervalAndPayment(pixId);
        }
      }
    }, 1800000);
  }
}

// Exporta uma instância única (Singleton) para toda a aplicação
module.exports = new SessionService();
