// src/models/purchased-content.model.js
const mongoose = require('mongoose');

const purchasedContentSchema = new mongoose.Schema({
  userId: { type: Number, required: true, index: true },
  videoId: { type: String, required: true },
  mediaType: { type: String, enum: ['movie', 'series', 'livetv'], required: true },
  title: { type: String, required: true },
  episodeName: { type: String },
  season: { type: String },
  seriesId: { type: String },
  accessGroupId: { type: String, index: true },
  episodeIndex: { type: Number },
  totalEpisodes: { type: Number },
  
  // Datas baseadas na lógica de negócio
  purchaseDate: { type: Date, default: Date.now, index: true },
  expiresAt: { type: Date, required: true, index: true },
  
  token: { type: String, required: true, unique: true }, // unique já cria index
  price: { type: Number, required: true },
  
  viewed: { type: Boolean, default: false },
  viewCount: { type: Number, default: 0 },
  resumeSeconds: { type: Number, default: 0 },
  resumeUpdatedAt: { type: Date },
  notificationSent: { type: Boolean, default: false },
  sessionToken: { type: String, unique: true },
  
  source: { type: String, enum: ['purchase', 'batch'], default: 'purchase', index: true },
  sourceBatchId: { type: String, index: true },
  storagePath: { type: String },
  hlsManifestUrl: { type: String },
  
  // Estado de Cache/CDN
  cacheStatus: { type: String, enum: ['pending', 'uploading', 'ready', 'transcoding', 'failed'], default: 'pending' },
  cacheProgress: { type: Number, default: 0 },
  cacheReadyAt: { type: Date },
  cacheUpdatedAt: { type: Date },
  cacheError: { type: String }
}, {
  // Apenas gere a data de quando a row no banco é alterada no geral
  timestamps: { createdAt: false, updatedAt: true }
});

module.exports = mongoose.models.PurchasedContent || mongoose.model('PurchasedContent', purchasedContentSchema);