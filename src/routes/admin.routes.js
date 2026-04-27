const express = require('express');
const { z } = require('zod');
const asyncHandler = require('../middlewares/async-handler');
const adminAuth = require('../middlewares/admin-auth');
const logger = require('../lib/logger');
const { CACHE_CONTEUDO, atualizarCache } = require('../services/content-cache.service');

const router = express.Router();

const usersQuerySchema = z.object({
  page: z.string().optional(),
  limit: z.string().optional(),
  q: z.string().optional(),
  sortBy: z.enum(['registeredAt', 'lastAccess', 'credits', 'totalSpent', 'totalPurchases', 'userId']).optional(),
  sortOrder: z.enum(['asc', 'desc']).optional(),
  blocked: z.enum(['true', 'false']).optional(),
  isActive: z.enum(['true', 'false']).optional(),
  includePurchases: z.enum(['true', 'false']).optional(),
  purchasesLimit: z.string().optional()
});

router.get('/api/admin/users', adminAuth, asyncHandler(async (req, res) => {
  const parsed = usersQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json({
      error: 'Parâmetros inválidos',
      details: parsed.error.flatten()
    });
  }

  const {
    page = '1',
    limit = '50',
    q,
    sortBy = 'registeredAt',
    sortOrder = 'desc',
    blocked,
    isActive,
    includePurchases = 'false',
    purchasesLimit = '5'
  } = parsed.data;

  const pageNum = Math.max(1, parseInt(page, 10) || 1);
  const perPage = Math.min(200, Math.max(1, parseInt(limit, 10) || 50));
  const purchasesPerUser = Math.min(20, Math.max(1, parseInt(purchasesLimit, 10) || 5));
  const skip = (pageNum - 1) * perPage;

  const { User, PurchasedContent } = req.app.locals.models;

  const filter = {};

  if (blocked === 'true') filter.isBlocked = true;
  if (blocked === 'false') filter.isBlocked = false;
  if (isActive === 'true') filter.isActive = true;
  if (isActive === 'false') filter.isActive = false;

  if (q && q.trim()) {
    const term = q.trim();
    const regex = new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    const maybeUserId = parseInt(term, 10);

    filter.$or = [
      { firstName: regex },
      { lastName: regex },
      { username: regex }
    ];

    if (Number.isFinite(maybeUserId)) {
      filter.$or.push({ userId: maybeUserId });
    }
  }

  const sortDirection = sortOrder === 'asc' ? 1 : -1;
  const sort = { [sortBy]: sortDirection, userId: -1 };

  const [totalUsers, users] = await Promise.all([
    User.countDocuments(filter),
    User.find(filter)
      .sort(sort)
      .skip(skip)
      .limit(perPage)
      .lean()
  ]);

  const userIds = users.map((u) => u.userId);
  const now = new Date();

  const purchaseStats = userIds.length > 0
    ? await PurchasedContent.aggregate([
      { $match: { userId: { $in: userIds } } },
      {
        $group: {
          _id: '$userId',
          totalPurchasedItems: { $sum: 1 },
          activeItems: {
            $sum: {
              $cond: [{ $gt: ['$expiresAt', now] }, 1, 0]
            }
          },
          expiredItems: {
            $sum: {
              $cond: [{ $lte: ['$expiresAt', now] }, 1, 0]
            }
          },
          totalSpentOnPurchases: { $sum: '$price' },
          lastPurchaseAt: { $max: '$purchaseDate' }
        }
      }
    ])
    : [];

  const purchaseStatsMap = new Map(purchaseStats.map((item) => [item._id, item]));

  let recentPurchasesMap = new Map();
  if (includePurchases === 'true' && userIds.length > 0) {
    const recentRows = await PurchasedContent.find({ userId: { $in: userIds } })
      .sort({ purchaseDate: -1 })
      .select('userId videoId mediaType title episodeName season price purchaseDate expiresAt viewed viewCount')
      .lean();

    recentPurchasesMap = recentRows.reduce((acc, row) => {
      const list = acc.get(row.userId) || [];
      if (list.length < purchasesPerUser) {
        list.push(row);
        acc.set(row.userId, list);
      }
      return acc;
    }, new Map());
  }

  const data = users.map((user) => {
    const stats = purchaseStatsMap.get(user.userId) || {};
    const metadata = user.metadata || {};

    return {
      userId: user.userId,
      firstName: user.firstName,
      lastName: user.lastName || null,
      username: user.username || null,
      phoneNumber: user.phoneNumber || null,
      credits: user.credits || 0,
      isActive: !!user.isActive,
      isBlocked: !!user.isBlocked,
      blockedReason: user.blockedReason || null,
      notificationsEnabled: user.notificationsEnabled !== false,
      language: user.language || 'pt-BR',
      registeredAt: user.registeredAt || null,
      lastAccess: user.lastAccess || null,
      totalSpent: user.totalSpent || 0,
      totalPurchases: user.totalPurchases || 0,
      metadata: {
        telegramLanguageCode: metadata.telegramLanguageCode || null,
        isPremium: !!metadata.isPremium,
        lastIp: metadata.lastIp || null,
        initialBonusGranted: !!metadata.initialBonusGranted,
        initialBonusGrantedAt: metadata.initialBonusGrantedAt || null,
        initialBonusAmount: metadata.initialBonusAmount || 0
      },
      purchaseSummary: {
        totalPurchasedItems: stats.totalPurchasedItems || 0,
        activeItems: stats.activeItems || 0,
        expiredItems: stats.expiredItems || 0,
        totalSpentOnPurchases: stats.totalSpentOnPurchases || 0,
        lastPurchaseAt: stats.lastPurchaseAt || null
      },
      recentPurchases: includePurchases === 'true' ? (recentPurchasesMap.get(user.userId) || []) : undefined
    };
  });

  return res.json({
    page: pageNum,
    limit: perPage,
    totalUsers,
    totalPages: Math.max(1, Math.ceil(totalUsers / perPage)),
    hasNextPage: skip + users.length < totalUsers,
    hasPrevPage: pageNum > 1,
    filters: {
      q: q || null,
      blocked: blocked || null,
      isActive: isActive || null,
      sortBy,
      sortOrder,
      includePurchases: includePurchases === 'true',
      purchasesLimit: includePurchases === 'true' ? purchasesPerUser : 0
    },
    data
  });
}));

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