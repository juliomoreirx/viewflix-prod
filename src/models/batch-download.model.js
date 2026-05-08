const mongoose = require('mongoose');

const batchItemSchema = new mongoose.Schema(
  {
    videoId: { type: String, required: true },
    title: { type: String },
    mediaType: { type: String, enum: ['movie', 'series'], default: 'movie' },
    season: String, // Para series
    episodeName: String, // Para series
    episodeIndex: Number, // Para series
    
    // Status individual do item
    status: { type: String, enum: ['pending', 'downloading', 'uploading', 'ready', 'failed'], default: 'pending' },
    progress: { type: Number, default: 0 }, // 0-100
    error: String,
    
    // Resultado
    storagePath: String,
    cacheReadyAt: Date,
    
    createdAt: { type: Date, default: Date.now },
    updatedAt: { type: Date, default: Date.now }
  },
  { _id: true }
);

const batchDownloadSchema = new mongoose.Schema(
  {
    userId: { type: Number, required: true }, // Telegram user ID
    name: { type: String, required: true }, // Ex: "Marvel Collection", "Breaking Bad S1"
    description: String,
    
    // Itens do lote
    items: [batchItemSchema],
    
    // Status geral
    status: { 
      type: String, 
      enum: ['draft', 'queued', 'processing', 'completed', 'paused', 'failed'],
      default: 'draft'
    },
    
    // Progresso agregado
    totalItems: { type: Number, default: 0 },
    completedItems: { type: Number, default: 0 },
    failedItems: { type: Number, default: 0 },
    overallProgress: { type: Number, default: 0 }, // 0-100
    
    // Configurações
    concurrency: { type: Number, default: 2 }, // Máximo de downloads paralelos
    autoStart: { type: Boolean, default: false }, // Iniciar automaticamente?
    
    // Organização no Bunny
    bunnyFolder: String, // Ex: "collections/marvel"
    
    // Timestamps
    createdAt: { type: Date, default: Date.now },
    startedAt: Date,
    completedAt: Date,
    updatedAt: { type: Date, default: Date.now }
  },
  { timestamps: true }
);

// Índices para queries rápidas
batchDownloadSchema.index({ userId: 1, status: 1 });
batchDownloadSchema.index({ createdAt: -1 });
batchDownloadSchema.index({ 'items.status': 1 });

module.exports = mongoose.model('BatchDownload', batchDownloadSchema);
