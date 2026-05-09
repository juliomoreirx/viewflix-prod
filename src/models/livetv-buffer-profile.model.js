const { mongoose } = require('../db/mongoose');

const livetvBufferProfileSchema = new mongoose.Schema({
  channelId: { type: String, required: true, unique: true, index: true },
  channelTitle: { type: String },
  enabled: { type: Boolean, default: false, index: true },
  segmentDurationSec: { type: Number, default: 6, min: 2, max: 20 },
  segmentCount: { type: Number, default: 30, min: 5, max: 180 },
  warmupMode: { type: String, enum: ['on-demand', 'always-on'], default: 'on-demand' },
  status: { type: String, enum: ['disabled', 'idle', 'warming', 'ready', 'error'], default: 'disabled', index: true },
  lastWarmupAt: { type: Date },
  lastReadyAt: { type: Date },
  lastError: { type: String },
  statusNote: { type: String },
  statusMeta: { type: mongoose.Schema.Types.Mixed }
}, { timestamps: true });

module.exports =
  mongoose.models.LiveTvBufferProfile ||
  mongoose.model('LiveTvBufferProfile', livetvBufferProfileSchema);
