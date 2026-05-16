// Memória global da aplicação
const userStates = {};
const pendingPayments = {};
const paymentCheckIntervals = {};
const cacheProgressByToken = new Map();

module.exports = {
  userStates,
  pendingPayments,
  paymentCheckIntervals,
  cacheProgressByToken,

  getUserState: (chatId) => userStates[chatId],
  
  setUserState: (chatId, stateData) => {
    userStates[chatId] = { ...(userStates[chatId] || {}), ...stateData, updatedAt: Date.now() };
  },
  
  clearUserState: (chatId) => {
    if (userStates[chatId]) {
      delete userStates[chatId];
    }
  }
};