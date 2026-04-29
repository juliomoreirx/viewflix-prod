const express = require('express');
const { z } = require('zod');
const fs = require('fs');
const path = require('path');
const asyncHandler = require('../middlewares/async-handler');
const adminAuth = require('../middlewares/admin-auth');
const logger = require('../lib/logger');
const { CACHE_CONTEUDO, atualizarCache, readCacheFromFile } = require('../services/content-cache.service');

const router = express.Router();

const crypto = require('crypto');

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

router.post('/api/admin/reload-content-json', adminAuth, asyncHandler(async (req, res) => {
  logger.info({ msg: 'Admin requested reload of content.json from disk' });
  const result = await readCacheFromFile();
  if (!result) {
    return res.status(500).json({ success: false, error: 'Falha ao ler content.json' });
  }

  return res.json({ success: true, movies: CACHE_CONTEUDO.movies.length, series: CACHE_CONTEUDO.series.length, livetv: CACHE_CONTEUDO.livetv.length });
}));

// List channels with admin overrides merged
router.get('/api/admin/channels', adminAuth, asyncHandler(async (req, res) => {
  const { ChannelOverride } = req.app.locals.models;

  // Prefer content.json on disk as the source of truth for admin listing (updated externally)
  let channels = [];
  try {
    const contentPath = path.join(process.cwd(), 'content.json');
    if (fs.existsSync(contentPath)) {
      const fileContent = fs.readFileSync(contentPath, 'utf8');
      const parsed = JSON.parse(fileContent || '{}');
      let rawLiveTv = [];
      if (parsed.data) {
        rawLiveTv = parsed.data.livetv || parsed.data.liveTv || parsed.data.live_tv || parsed.data.channels || [];
      } else {
        rawLiveTv = parsed.livetv || parsed.liveTv || parsed.live_tv || parsed.channels || [];
      }
      channels = Array.isArray(rawLiveTv) ? rawLiveTv : [];
    } else {
      channels = (CACHE_CONTEUDO.livetv || []).map((c) => c || {});
    }
  } catch (e) {
    logger.warn({ msg: 'Falha ao ler content.json para admin channels', err: e.message });
    channels = (CACHE_CONTEUDO.livetv || []).map((c) => c || {});
  }

  const overrides = await ChannelOverride.find({}).lean();
  const overrideMap = new Map(overrides.map(o => [o.key, o]));
  const { computeChannelKey } = require('../lib/keys');

  const data = channels.map((ch) => {
    const key = computeChannelKey(ch);
    const ov = overrideMap.get(key) || {};
    return {
      key,
      title: ch.name || ch.title || ch.label || ch.channel || null,
      url: ch.url || ch.hls || ch.stream || null,
      raw: ch,
      hidden: !!ov.hidden,
      disabled: !!ov.disabled,
      override: ov
    };
  });

  return res.json({ success: true, total: data.length, data });
}));

// Bulk update channels (hide/unhide/disable/enable)
router.post('/api/admin/channels/bulk-update', adminAuth, asyncHandler(async (req, res) => {
  const { ChannelOverride } = req.app.locals.models;
  const body = req.body || {};
  const keys = Array.isArray(body.keys) ? body.keys : [];
  // Support two modes: legacy { keys, action } and new { keys, updates }
  if (!keys || keys.length === 0) return res.status(400).json({ error: 'keys required' });

  if (body.updates && typeof body.updates === 'object') {
    // New idempotent bulk update using bulkWrite
    const updates = body.updates;
    const bulkOps = keys.map(k => ({
      updateOne: {
        filter: { key: k },
        update: { $set: { ...updates, updatedAt: new Date() } },
        upsert: true
      }
    }));
    await ChannelOverride.bulkWrite(bulkOps);
    return res.json({ success: true, modified: keys.length });
  }

  const action = body.action;
  if (!['hide','unhide','disable','enable'].includes(action)) return res.status(400).json({ error: 'invalid action' });

  let modified = 0;
  for (const key of keys) {
    if (!key) continue;
    const existing = await ChannelOverride.findOne({ key });
    if (action === 'hide') {
      if (existing) {
        if (!existing.hidden) { existing.hidden = true; await existing.save(); modified++; }
      } else {
        await ChannelOverride.create({ key, hidden: true }); modified++;
      }
    }
    if (action === 'unhide') {
      if (existing) {
        if (existing.hidden) { existing.hidden = false; await existing.save(); modified++; }
      }
    }
    if (action === 'disable') {
      if (existing) {
        if (!existing.disabled) { existing.disabled = true; await existing.save(); modified++; }
      } else {
        await ChannelOverride.create({ key, disabled: true }); modified++;
      }
    }
    if (action === 'enable') {
      if (existing) {
        if (existing.disabled) { existing.disabled = false; await existing.save(); modified++; }
      }
    }
  }

  return res.json({ success: true, modified });
}));

// Endpoint protegido para limpar/migrar (Documentar para equipe)
router.post('/api/admin/channels/clean-overrides', adminAuth, asyncHandler(async (req, res) => {
  try {
    if (req.body.confirm !== 'I_KNOW_WHAT_I_AM_DOING') return res.status(400).json({ error: 'Confirmação ausente.' });
    const result = await ChannelOverride.deleteMany({});
    return res.json({ success: true, deletedCount: result.deletedCount });
  } catch (err) {
    return res.status(500).json({ error: 'Erro ao limpar overrides.' });
  }
}));

module.exports = router;