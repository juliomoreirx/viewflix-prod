const express = require('express');
const asyncHandler = require('../middlewares/async-handler');
const adminAuth = require('../middlewares/admin-auth');
const logger = require('../lib/logger');
const { CACHE_CONTEUDO, atualizarCache } = require('../services/content-cache.service');

const router = express.Router();

router.get('/api/admin/stats', adminAuth, asyncHandler(async (req, res) => {
  const { User, PurchasedContent } = req.app.locals.models;

  const stats = {
    users: {
      total: await User.countDocuments(),
      active: await User.countDocuments({ isActive: true, isBlocked: false }),
      blocked: await User.countDocuments({ isBlocked: true })
    },
    purchases: {
      total:
        (await User.aggregate([{ $group: { _id: null, total: { $sum: '$totalPurchases' } } }]))[0]?.total || 0,
      revenue:
        (await User.aggregate([{ $group: { _id: null, total: { $sum: '$totalSpent' } } }]))[0]?.total || 0
    },
    content: {
      active: await PurchasedContent.countDocuments({ expiresAt: { $gt: new Date() } }),
      expired: await PurchasedContent.countDocuments({ expiresAt: { $lte: new Date() } })
    },
    catalog: {
      movies: CACHE_CONTEUDO.movies.length,
      series: CACHE_CONTEUDO.series.length
    }
  };

  return res.json(stats);
}));

router.post('/api/admin/refresh-cache', adminAuth, asyncHandler(async (req, res) => {
  logger.info({ msg: 'Refresh manual de cache solicitado via admin API' });

  await atualizarCache(true);

  return res.json({
    success: true,
    movies: CACHE_CONTEUDO.movies.length,
    series: CACHE_CONTEUDO.series.length,
    lastUpdated: CACHE_CONTEUDO.lastUpdated
  });
}));

module.exports = router;