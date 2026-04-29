const redisClient = require('../lib/redis');

class StateManager {
  // TTL of 1 hour in seconds
  static STATE_TTL = 3600;

  static async getUserState(chatId) {
    if (!redisClient) return null;
    try {
      const data = await redisClient.get(`user_state:${chatId}`);
      return data ? JSON.parse(data) : null;
    } catch (err) {
      console.error(`Erro ao obter estado do Redis para ${chatId}:`, err.message);
      return null;
    }
  }

  static async setUserState(chatId, stateData) {
    if (!redisClient) return;
    try {
      const payload = JSON.stringify({ ...stateData, updatedAt: Date.now() });
      await redisClient.setex(`user_state:${chatId}`, this.STATE_TTL, payload);
    } catch (err) {
      console.error(`Erro ao salvar estado no Redis para ${chatId}:`, err.message);
    }
  }

  static async clearUserState(chatId) {
    if (!redisClient) return;
    try {
      await redisClient.del(`user_state:${chatId}`);
    } catch (err) {
      console.error(`Erro ao limpar estado no Redis para ${chatId}:`, err.message);
    }
  }

  // TTL of 30 minutes for pending payments
  static PENDING_TTL = 1800;

  static async getPendingPayment(paymentId) {
    if (!redisClient) return null;
    try {
      const data = await redisClient.get(`pending_payment:${paymentId}`);
      return data ? JSON.parse(data) : null;
    } catch (err) {
      console.error(`Erro ao obter pagamento do Redis ${paymentId}:`, err.message);
      return null;
    }
  }

  static async setPendingPayment(paymentId, paymentData) {
    if (!redisClient) return;
    try {
      const payload = JSON.stringify({ ...paymentData, timestamp: Date.now() });
      await redisClient.setex(`pending_payment:${paymentId}`, this.PENDING_TTL, payload);
    } catch (err) {
      console.error(`Erro ao salvar pagamento no Redis ${paymentId}:`, err.message);
    }
  }

  static async clearPendingPayment(paymentId) {
    if (!redisClient) return;
    try {
      await redisClient.del(`pending_payment:${paymentId}`);
    } catch (err) {
      console.error(`Erro ao limpar pagamento no Redis ${paymentId}:`, err.message);
    }
  }
}

module.exports = StateManager;
