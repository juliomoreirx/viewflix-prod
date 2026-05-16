// Fallbacks caso não sejam injetados via initBot
const UserLocal = require('../../src/models/user.model.js');
const PurchasedContentLocal = require('../../src/models/purchased-content.model.js');

let UserModel = UserLocal;
let PurchasedContentModel = PurchasedContentLocal;

module.exports = {
  setModels: (models) => {
    if (!models) return;
    UserModel = models.User || models.user || models['user.model'] || UserLocal;
    PurchasedContentModel = models.PurchasedContent || models.purchasedContent || models['purchased-content.model'] || PurchasedContentLocal;
  },
  getUserModel: () => UserModel,
  getPurchasedContentModel: () => PurchasedContentModel
};