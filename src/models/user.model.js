// src/models/user.model.js
const mongoose = require('mongoose');

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
  totalSpent: { type: Number, default: 0 },
  totalPurchases: { type: Number, default: 0 },
  language: { type: String, default: 'pt-BR' },
  notificationsEnabled: { type: Boolean, default: true },
  
  // Opcional: Metadata extra agrupada
  metadata: {
    telegramLanguageCode: String,
    isPremium: Boolean,
    lastIp: String,
    initialBonusGranted: { type: Boolean, default: false },
    initialBonusGrantedAt: Date,
    initialBonusAmount: Number
  }
}, { 
  // O Mongoose gere as datas de criação e atualização automaticamente
  timestamps: { createdAt: 'registeredAt', updatedAt: 'lastAccess' } 
});

module.exports = mongoose.models.User || mongoose.model('User', userSchema);