const mongoose = require('mongoose');

const ChannelOverrideSchema = new mongoose.Schema({
  key: { type: String, required: true, unique: true, index: true },
  title: { type: String },
  hidden: { type: Boolean, default: false },
  disabled: { type: Boolean, default: false },
  meta: { type: mongoose.Schema.Types.Mixed },
}, { timestamps: true });

module.exports = mongoose.model('ChannelOverride', ChannelOverrideSchema);
