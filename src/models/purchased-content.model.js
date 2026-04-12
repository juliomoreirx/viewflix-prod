const { mongoose } = require('../db/mongoose');

const purchasedContentSchema = new mongoose.Schema({
  userId: { type: Number, required: true, index: true },
  videoId: { type: String, required: true },
  mediaType: { type: String, enum: ['movie', 'series'], required: true },
  title: { type: String, required: true },
  episodeName: { type: String },
  season: { type: String },
  purchaseDate: { type: Date, default: Date.now, index: true },
  expiresAt: { type: Date, required: true, index: true },
  token: { type: String, required: true, unique: true },
  price: { type: Number, required: true },
  viewed: { type: Boolean, default: false },
  viewCount: { type: Number, default: 0 },
  notificationSent: { type: Boolean, default: false },
  sessionToken: { type: String, unique: true }
});

module.exports =
  mongoose.models.PurchasedContent ||
  mongoose.model('PurchasedContent', purchasedContentSchema);