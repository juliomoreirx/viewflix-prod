// src/models/batch-download.model.js
const mongoose = require('mongoose');

const batchItemSchema = new mongoose.Schema({
  videoId: { type: String, required: true },
  title: { type: String },
  mediaType: { type: String, enum: ['movie', 'series'], default: 'movie' },
  season: String,
  episodeName: String,
  episodeIndex: Number,
  
  status: { type: String, enum: ['pending', 'downloading', 'uploading', 'ready', 'failed'], default: 'pending' },
  progress: { type: Number, default: 0 },
  error: String,
  
  storagePath: String,
  cacheReadyAt: Date
}, { 
  _id: true,
  timestamps: true // Delega para o Mongoose
});

const batchDownloadSchema = new mongoose.Schema({
  userId: { type: Number, required: true, index: true }, 
  name: { type: String, required: true }, 
  description: String,
  
  items: [batchItemSchema],
  
  status: { 
    type: String, 
    enum: ['draft', 'queued', 'processing', 'completed', 'paused', 'failed'],
    default: 'draft'
  },
  
  totalItems: { type: Number, default: 0 },
  completedItems: { type: Number, default: 0 },
  failedItems: { type: Number, default: 0 },
  overallProgress: { type: Number, default: 0 },
  
  concurrency: { type: Number, default: 2 },
  autoStart: { type: Boolean, default: false },
  bunnyFolder: String, 
  
  startedAt: Date,
  completedAt: Date
}, { 
  timestamps: true // O Mongoose cria os campos `createdAt` e `updatedAt` automaticamente
});

// Índices Compostos e Simples
batchDownloadSchema.index({ userId: 1, status: 1 });
batchDownloadSchema.index({ 'items.status': 1 });

module.exports = mongoose.models.BatchDownload || mongoose.model('BatchDownload', batchDownloadSchema);