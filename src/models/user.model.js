const { mongoose } = require('../db/mongoose');

const userSchema = new mongoose.Schema({
  userId: { type: Number, required: true, unique: true, index: true },
  firstName: { type: String, required: true },
  lastName: { type: String },
  username: { type: String },
  phoneNumber: { type: String },
  credits: { type: Number, default: 0 },
  isActive: { type: Boolean, default: true },
  isBlocked: { type: Boolean, default: false },
  blockedReason: { type: String },
  registeredAt: { type: Date, default: Date.now },
  lastAccess: { type: Date, default: Date.now },
  totalSpent: { type: Number, default: 0 },
  totalPurchases: { type: Number, default: 0 },
  language: { type: String, default: 'pt-BR' },
  notificationsEnabled: { type: Boolean, default: true },
  metadata: {
    telegramLanguageCode: String,
    isPremium: Boolean,
    lastIp: String
  }
});

module.exports = mongoose.models.User || mongoose.model('User', userSchema);