const express = require('express');
const jwt = require('jsonwebtoken');
const { z } = require('zod');
const asyncHandler = require('../middlewares/async-handler');
const adminAuth = require('../middlewares/admin-auth');
const logger = require('../lib/logger');
const { CACHE_CONTEUDO, atualizarCache, buscarDetalhes } = require('../services/content-cache.service');
const bunnyCacheService = require('../services/bunny-cache.service');
const bunnyStorage = require('../services/bunny-storage.service');
const env = require('../config/env');
const telegramBot = require('../../telegram-bot');

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

const broadcastSchema = z.object({
  message: z.string().trim().min(1).max(4000),
  bonusAmount: z.coerce.number().int().min(0).max(100000).default(0),
  bonusLimit: z.coerce.number().int().min(0).max(1000).default(0),
  adminLabel: z.string().trim().max(80).optional()
});

const contentSearchSchema = z.object({
  q: z.string().trim().optional(),
  type: z.enum(['all', 'movies', 'series', 'livetv']).optional().default('all'),
  limit: z.coerce.number().int().min(1).max(10000).optional().default(20)
});

const contentDetailsSchema = z.object({
  id: z.string().trim().min(1),
  type: z.enum(['movies', 'series'])
});

const contentLibrarySchema = z.object({
  type: z.enum(['all', 'movies', 'series', 'livetv']).optional().default('all')
});

const liveTvBufferCatalogSchema = z.object({
  q: z.string().trim().optional(),
  enabled: z.enum(['all', 'true', 'false']).optional().default('all'),
  status: z.enum(['all', 'disabled', 'idle', 'warming', 'ready', 'error']).optional().default('all'),
  page: z.coerce.number().int().min(1).optional().default(1),
  limit: z.coerce.number().int().min(1).max(200).optional().default(50)
});

const liveTvBufferProfileSchema = z.object({
  enabled: z.coerce.boolean().optional(),
  channelTitle: z.string().trim().max(180).optional(),
  segmentDurationSec: z.coerce.number().int().min(2).max(20).optional(),
  segmentCount: z.coerce.number().int().min(5).max(180).optional(),
  warmupMode: z.enum(['on-demand', 'always-on']).optional(),
  statusNote: z.string().trim().max(300).optional()
});

const liveTvChannelParamSchema = z.object({
  channelId: z.string().trim().min(1).max(200)
});

const createLinkSchema = z.object({
  userId: z.coerce.number().int().positive(),
  contentId: z.string().trim().min(1),
  sourceType: z.enum(['movies', 'series']).default('movies'),
  contentType: z.enum(['movie', 'episode', 'season', 'full-series']),
  season: z.string().trim().optional(),
  episodeId: z.string().trim().optional(),
  expiresAt: z.string().trim().min(1),
  prepareCache: z.coerce.boolean().optional().default(true)
});

const linkStatusSchema = z.object({
  token: z.string().trim().min(20)
});

const revokeLinkSchema = z.object({
  token: z.string().trim().min(20),
  revokeGroup: z.coerce.boolean().optional().default(true)
});

function formatSearchItem(item, sourceType) {
  return {
    id: String(item.id),
    title: String(item.name || item.title || item.originalTitle || item.label || ''),
    type: sourceType,
    cover: item.img || item.cover || null
  };
}

function getContentSearchLabel(item) {
  return String(item?.name || item?.title || item?.originalTitle || item?.label || '').trim();
}

function getLiveTvChannelLabel(item) {
  return String(item?.name || item?.title || item?.originalTitle || item?.label || item?.id || '').trim();
}

function formatLiveTvBufferProfile(profile = {}, fallback = {}) {
  const p = profile && typeof profile === 'object' ? profile : {};
  const f = fallback && typeof fallback === 'object' ? fallback : {};
  const segmentDurationSec = Number(p.segmentDurationSec || f.segmentDurationSec || 6);
  const segmentCount = Number(p.segmentCount || f.segmentCount || 30);
  const isEnabled = !!p.enabled || !!f.enabled;
  const status = String(p.status || f.status || (isEnabled ? 'idle' : 'disabled'));
  return {
    channelId: String(p.channelId || f.channelId || ''),
    channelTitle: String(p.channelTitle || f.channelTitle || ''),
    enabled: isEnabled,
    warmupMode: String(p.warmupMode || f.warmupMode || 'on-demand'),
    segmentDurationSec,
    segmentCount,
    targetBufferSec: segmentDurationSec * segmentCount,
    status,
    statusNote: p.statusNote || f.statusNote || null,
    lastWarmupAt: p.lastWarmupAt || f.lastWarmupAt || null,
    lastReadyAt: p.lastReadyAt || f.lastReadyAt || null,
    lastError: p.lastError || f.lastError || null,
    updatedAt: p.updatedAt || f.updatedAt || null,
    createdAt: p.createdAt || f.createdAt || null
  };
}

function getLiveTvBufferProfileModel(req) {
  return req.app.locals.models?.LiveTvBufferProfile || require('../models/livetv-buffer-profile.model');
}

function buildPurchaseQuery({ userId, includeBatch = true, activeOnly = false, expiredOnly = false } = {}) {
  const query = {
    mediaType: { $in: ['movie', 'series', 'livetv'] }
  };

  if (Number.isFinite(Number(userId))) {
    query.userId = Number(userId);
  }

  if (!includeBatch) {
    query.source = { $ne: 'batch' };
    query.token = { $not: /^batch-/ };
  }

  if (activeOnly) {
    query.expiresAt = { $gt: new Date() };
  } else if (expiredOnly) {
    query.expiresAt = { $lte: new Date() };
  }

  return query;
}

function formatAdminPurchaseItem(item) {
  const source = String(item.source || (String(item.token || '').startsWith('batch-') ? 'batch' : 'purchase'));
  return {
    id: String(item._id),
    userId: item.userId,
    videoId: String(item.videoId || ''),
    title: String(item.title || ''),
    episodeName: item.episodeName || null,
    mediaType: item.mediaType,
    season: item.season || null,
    token: item.token,
    price: Number(item.price || 0),
    purchaseDate: item.purchaseDate || null,
    expiresAt: item.expiresAt || null,
    expired: item.expiresAt ? new Date(item.expiresAt).getTime() <= Date.now() : false,
    cacheStatus: item.cacheStatus || null,
    cacheProgress: Number.isFinite(Number(item.cacheProgress)) ? Number(item.cacheProgress) : 0,
    storagePath: item.storagePath || null,
    source,
    sourceLabel: source === 'batch' ? 'Pré-carregado no painel' : 'Compra real',
    sourceBatchId: item.sourceBatchId || null,
    sourceBatchItemId: item.sourceBatchItemId || null
  };
}

async function searchFromPurchasedContent(PurchasedContent, { term = '', limit = 20 } = {}) {
  if (!PurchasedContent) return [];

  const safeLimit = Math.min(50, Math.max(1, Number(limit) || 20));
  const escapedTerm = String(term || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const regex = escapedTerm ? new RegExp(escapedTerm, 'i') : null;

  const match = buildPurchaseQuery({ includeBatch: false });
  match.mediaType = { $in: ['movie', 'series'] };

  if (regex) {
    match.$or = [
      { title: regex },
      { episodeName: regex }
    ];
  }

  const rows = await PurchasedContent.find(match)
    .sort({ purchaseDate: -1 })
    .select('mediaType title videoId seriesId')
    .limit(safeLimit * 10)
    .lean();

  const unique = new Map();
  for (const row of rows) {
    const isSeries = row.mediaType === 'series' && row.seriesId;
    const id = String(isSeries ? row.seriesId : row.videoId || '').trim();
    if (!id) continue;

    const type = isSeries ? 'series' : 'movies';
    const key = `${type}:${id}`;
    if (unique.has(key)) continue;

    const title = String(row.title || '').trim();
    if (regex && !regex.test(title)) continue;

    unique.set(key, {
      id,
      title,
      type,
      cover: null
    });

    if (unique.size >= safeLimit) break;
  }

  return Array.from(unique.values());
}

function buildAccessToken({ userId, videoId, mediaType, expiresAt }) {
  const expDate = expiresAt instanceof Date ? expiresAt : new Date(expiresAt);
  return jwt.sign(
    {
      userId,
      videoId,
      mediaType,
      exp: Math.floor(expDate.getTime() / 1000)
    },
    env.JWT_SECRET
  );
}

function formatLinkStatus(purchase, { bunnyConfigured = false } = {}) {
  const now = Date.now();
  const isRevoked = purchase.expiresAt ? new Date(purchase.expiresAt).getTime() <= now : false;
    // Prefer explicit cacheStatus or cacheReadyAt to determine 'ready'.
    // Avoid inferring 'ready' solely from storagePath, which may be present
    // before upload completes and produces false positives in the UI.
    const cacheStatus = purchase.cacheStatus || (purchase.cacheReadyAt ? 'ready' : 'origin');
  const cacheProgress = Number.isFinite(purchase.cacheProgress) ? purchase.cacheProgress : 0;

  return {
    token: purchase.token,
    userId: purchase.userId,
    videoId: purchase.videoId,
    title: purchase.title,
    episodeName: purchase.episodeName || null,
    mediaType: purchase.mediaType,
    season: purchase.season || null,
    expiresAt: purchase.expiresAt ? new Date(purchase.expiresAt).toISOString() : null,
    cacheStatus,
    cacheProgress,
    storagePath: purchase.storagePath || null,
    accessGroupId: purchase.accessGroupId || null,
    playerUrl: `${String(env.DOMINIO_PUBLICO || '').replace(/\/$/, '')}/player/${purchase.token}`,
    ready: cacheStatus === 'ready',
    queued: cacheStatus === 'pending' || cacheStatus === 'uploading',
    revoked: isRevoked
  };
}

function summarizeGroupStatus(items = []) {
  const list = Array.isArray(items) ? items : [];
  if (!list.length) {
    return {
      cacheStatus: 'origin',
      cacheProgress: 0,
      revoked: false,
      totalItems: 0,
      readyItems: 0
    };
  }

  const progressAvg = Math.round(list.reduce((acc, item) => acc + (Number.isFinite(item.cacheProgress) ? item.cacheProgress : 0), 0) / list.length);
  const revokedCount = list.filter((item) => item.revoked).length;
  const failedCount = list.filter((item) => item.cacheStatus === 'failed').length;
  const queuedCount = list.filter((item) => item.cacheStatus === 'pending' || item.cacheStatus === 'uploading').length;
  const readyCount = list.filter((item) => item.cacheStatus === 'ready').length;

  let cacheStatus = 'origin';
  if (revokedCount === list.length) cacheStatus = 'revoked';
  else if (failedCount > 0) cacheStatus = 'failed';
  else if (queuedCount > 0) cacheStatus = 'pending';
  else if (readyCount === list.length) cacheStatus = 'ready';

  return {
    cacheStatus,
    cacheProgress: progressAvg,
    revoked: revokedCount > 0,
    totalItems: list.length,
    readyItems: readyCount
  };
}

async function ensureAdminTestUser(User, userId) {
  let user = await User.findOne({ userId });
  if (user) return user;

  user = await User.create({
    userId,
    firstName: `Teste ${userId}`,
    credits: 0,
    isActive: true,
    isBlocked: false,
    registeredAt: new Date(),
    lastAccess: new Date(),
    totalSpent: 0,
    totalPurchases: 0,
    notificationsEnabled: true,
    metadata: {
      initialBonusGranted: false
    }
  });

  return user;
}

async function ensureBunnyCacheForPurchase(purchase, { skipCache = false } = {}) {
  if (purchase.isNew) {
    await purchase.save();
  }

  if (skipCache) {
    return { cacheStatus: null, cacheStrategy: 'skipped', storagePath: null };
  }

  if (!bunnyStorage.isConfigured()) {
    return { cacheStatus: null, cacheStrategy: 'origin', storagePath: null };
  }

  const storagePath = bunnyCacheService.buildStoragePath(purchase);
    // do not set `purchase.storagePath` in-memory here to avoid a race where
    // the in-memory doc appears to have a storagePath before the DB persists
    // the actual cache status/progress. The DB is updated below when setting pending/ready.

  const exists = await bunnyStorage.exists(storagePath);
  if (exists) {
    await purchase.updateOne({
      $set: {
        storagePath,
        cacheStatus: 'ready',
        cacheProgress: 100,
        cacheReadyAt: new Date(),
        cacheUpdatedAt: new Date()
      }
    });

    return { cacheStatus: 'ready', cacheStrategy: 'cached', storagePath };
  }

  // Mark as queued/pending but do NOT persist storagePath yet to avoid
  // indicating a storage location before upload completes. `storagePath`
  // will be persisted once upload finishes successfully.
  await purchase.updateOne({
    $set: {
      cacheStatus: 'pending',
      cacheProgress: 0,
      cacheUpdatedAt: new Date()
    }
  });

  bunnyCacheService.enqueue(purchase, {
    onProgress: ({ percent }) => {
      // onProgress will update cacheProgress in DB
    },
    onReady: ({ storagePath }) => {
      // onReady will update cacheStatus and cacheReadyAt in DB
    },
    onError: (error) => {
      // onError will update cacheStatus and cacheError in DB
    }
  });
  return { cacheStatus: 'pending', cacheStrategy: 'queued', storagePath };
}

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
      { $match: buildPurchaseQuery({ includeBatch: false }) },
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
    const recentRows = await PurchasedContent.find({
      userId: { $in: userIds },
      ...buildPurchaseQuery({ includeBatch: false })
    })
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
      active: await PurchasedContent.countDocuments(buildPurchaseQuery({ includeBatch: false, activeOnly: true })),
      expired: await PurchasedContent.countDocuments(buildPurchaseQuery({ includeBatch: false, expiredOnly: true }))
    },
    catalog: {
      movies: CACHE_CONTEUDO.movies.length,
      series: CACHE_CONTEUDO.series.length
    }
  };

  return res.json(stats);
}));

router.get('/api/admin/users/:userId/content', adminAuth, asyncHandler(async (req, res) => {
  const { User, PurchasedContent } = req.app.locals.models;
  const userId = Number(req.params.userId);

  if (!Number.isFinite(userId)) {
    return res.status(400).json({ error: 'Usuário inválido' });
  }

  const user = await User.findOne({ userId }).lean();
  if (!user) {
    return res.status(404).json({ error: 'Usuário não encontrado' });
  }

  const items = await PurchasedContent.find({ userId })
    .sort({ purchaseDate: -1, expiresAt: -1 })
    .lean();

  const formatted = items.map(formatAdminPurchaseItem);
  const grouped = formatted.reduce((acc, item) => {
    const sourceKey = item.source === 'batch' ? 'batch' : 'purchase';
    if (!acc[sourceKey]) acc[sourceKey] = [];
    if (!acc[item.mediaType]) acc[item.mediaType] = [];
    acc[sourceKey].push(item);
    acc[item.mediaType].push(item);
    return acc;
  }, { purchase: [], batch: [], movie: [], series: [], livetv: [] });

  return res.json({
    success: true,
    user: {
      userId: user.userId,
      firstName: user.firstName,
      lastName: user.lastName || null,
      username: user.username || null
    },
    summary: {
      total: formatted.length,
      purchases: grouped.purchase.length,
      batch: grouped.batch.length,
      movies: grouped.movie.length,
      series: grouped.series.length,
      livetv: grouped.livetv.length,
      active: formatted.filter((item) => !item.expired).length,
      expired: formatted.filter((item) => item.expired).length
    },
    data: {
      all: formatted,
      grouped
    }
  });
}));

router.delete('/api/admin/purchases/:id', adminAuth, asyncHandler(async (req, res) => {
  const { PurchasedContent, BatchDownload } = req.app.locals.models;
  const purchase = await PurchasedContent.findById(req.params.id);

  if (!purchase) {
    return res.status(404).json({ error: 'Conteúdo não encontrado' });
  }

  const deleted = await PurchasedContent.deleteOne({ _id: purchase._id });

  if (purchase.source === 'batch' && purchase.sourceBatchId) {
    await BatchDownload.updateOne(
      { _id: purchase.sourceBatchId },
      { $pull: { items: { _id: purchase.sourceBatchItemId || purchase._id } } }
    );
  }

  return res.json({
    success: true,
    deletedCount: deleted.deletedCount || 0,
    source: purchase.source || 'purchase'
  });
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

router.post('/api/admin/broadcast', adminAuth, asyncHandler(async (req, res) => {
  const parsed = broadcastSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({
      error: 'Dados inválidos',
      details: parsed.error.flatten()
    });
  }

  const { message, bonusAmount, bonusLimit, adminLabel } = parsed.data;

  if (!telegramBot || typeof telegramBot.dispararCampanhaTelegram !== 'function') {
    return res.status(500).json({ error: 'Serviço de Telegram indisponível' });
  }

  logger.info({
    msg: 'Campanha administrativa iniciada',
    bonusAmount,
    bonusLimit,
    adminLabel: adminLabel || null
  });

  const result = await telegramBot.dispararCampanhaTelegram({
    message,
    bonusAmount,
    bonusLimit,
    adminLabel: adminLabel || 'Admin'
  });

  return res.json({
    success: true,
    ...result
  });
}));

router.get('/api/admin/content/search', adminAuth, asyncHandler(async (req, res) => {
  const parsed = contentSearchSchema.safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Parâmetros inválidos', details: parsed.error.flatten() });
  }

  const { q = '', type = 'all', limit = 20 } = parsed.data;
  const term = q.toLowerCase().trim();

  if (!CACHE_CONTEUDO.movies.length && !CACHE_CONTEUDO.series.length && !(CACHE_CONTEUDO.livetv || []).length) {
    await atualizarCache(false);
  }

  if (!CACHE_CONTEUDO.movies.length && !CACHE_CONTEUDO.series.length && !(CACHE_CONTEUDO.livetv || []).length) {
    await atualizarCache(true);
  }

  const pools = [];
  if (type === 'all' || type === 'movies') pools.push({ sourceType: 'movies', items: CACHE_CONTEUDO.movies || [] });
  if (type === 'all' || type === 'series') pools.push({ sourceType: 'series', items: CACHE_CONTEUDO.series || [] });
  if (type === 'all' || type === 'livetv') pools.push({ sourceType: 'livetv', items: CACHE_CONTEUDO.livetv || [] });

  const matches = pools.flatMap(({ sourceType, items }) => {
    return items
      .filter((item) => {
        if (!term) return true;
        return getContentSearchLabel(item).toLowerCase().includes(term);
      })
      .slice(0, limit)
      .map((item) => formatSearchItem(item, sourceType));
  }).slice(0, limit);

  if (term && matches.length === 0) {
    await atualizarCache(false);

    if (!CACHE_CONTEUDO.movies.length && !CACHE_CONTEUDO.series.length && !(CACHE_CONTEUDO.livetv || []).length) {
      await atualizarCache(true);
    }

    const refreshedPools = [];
    if (type === 'all' || type === 'movies') refreshedPools.push({ sourceType: 'movies', items: CACHE_CONTEUDO.movies || [] });
    if (type === 'all' || type === 'series') refreshedPools.push({ sourceType: 'series', items: CACHE_CONTEUDO.series || [] });
    if (type === 'all' || type === 'livetv') refreshedPools.push({ sourceType: 'livetv', items: CACHE_CONTEUDO.livetv || [] });

    const refreshedMatches = refreshedPools.flatMap(({ sourceType, items }) => {
      return items
        .filter((item) => getContentSearchLabel(item).toLowerCase().includes(term))
        .slice(0, limit)
        .map((item) => formatSearchItem(item, sourceType));
    }).slice(0, limit);

    return res.json({
      success: true,
      total: refreshedMatches.length,
      refreshed: true,
      data: refreshedMatches
    });
  }

  if (matches.length === 0) {
    const { PurchasedContent } = req.app.locals.models || {};
    const fallbackMatches = await searchFromPurchasedContent(PurchasedContent, { term, limit });
    if (fallbackMatches.length > 0) {
      return res.json({
        success: true,
        total: fallbackMatches.length,
        refreshed: false,
        fallback: 'purchases',
        data: fallbackMatches
      });
    }
  }

  return res.json({
    success: true,
    total: matches.length,
    refreshed: false,
    data: matches
  });
}));

router.get('/api/admin/content/library', adminAuth, asyncHandler(async (req, res) => {
  const parsed = contentLibrarySchema.safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Parâmetros inválidos', details: parsed.error.flatten() });
  }

  const { type = 'all' } = parsed.data;

  if (!CACHE_CONTEUDO.movies.length && !CACHE_CONTEUDO.series.length && !(CACHE_CONTEUDO.livetv || []).length) {
    await atualizarCache(false);
  }

  if (!CACHE_CONTEUDO.movies.length && !CACHE_CONTEUDO.series.length && !(CACHE_CONTEUDO.livetv || []).length) {
    await atualizarCache(true);
  }

  const pools = [];
  if (type === 'all' || type === 'movies') pools.push({ sourceType: 'movies', items: CACHE_CONTEUDO.movies || [] });
  if (type === 'all' || type === 'series') pools.push({ sourceType: 'series', items: CACHE_CONTEUDO.series || [] });
  if (type === 'all' || type === 'livetv') pools.push({ sourceType: 'livetv', items: CACHE_CONTEUDO.livetv || [] });

  const data = pools.flatMap(({ sourceType, items }) => items.map((item) => formatSearchItem(item, sourceType)));

  return res.json({
    success: true,
    total: data.length,
    data
  });
}));

router.get('/api/admin/livetv-buffer/catalog', adminAuth, asyncHandler(async (req, res) => {
  const parsed = liveTvBufferCatalogSchema.safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Parâmetros inválidos', details: parsed.error.flatten() });
  }

  const { q = '', enabled = 'all', status = 'all', page = 1, limit = 50 } = parsed.data;
  const term = String(q || '').toLowerCase().trim();
  const LiveTvBufferProfile = getLiveTvBufferProfileModel(req);

  if (!CACHE_CONTEUDO.movies.length && !CACHE_CONTEUDO.series.length && !(CACHE_CONTEUDO.livetv || []).length) {
    await atualizarCache(false);
  }

  if (!CACHE_CONTEUDO.movies.length && !CACHE_CONTEUDO.series.length && !(CACHE_CONTEUDO.livetv || []).length) {
    await atualizarCache(true);
  }

  const catalogChannels = (CACHE_CONTEUDO.livetv || []).map((item) => ({
    channelId: String(item?.id || '').trim(),
    channelTitle: getLiveTvChannelLabel(item),
    cover: item?.img || item?.cover || null
  })).filter((item) => item.channelId);

  const profiles = await LiveTvBufferProfile.find({}).lean();
  const profileByChannelId = new Map(profiles.map((profile) => [String(profile.channelId), profile]));
  const catalogChannelIds = new Set(catalogChannels.map((row) => row.channelId));

  const merged = catalogChannels.map((row) => {
    const profile = profileByChannelId.get(row.channelId);
    return {
      channelId: row.channelId,
      channelTitle: row.channelTitle,
      cover: row.cover,
      inCatalog: true,
      profile: formatLiveTvBufferProfile(profile || { channelId: row.channelId, channelTitle: row.channelTitle, enabled: false })
    };
  });

  for (const profile of profiles) {
    const profileChannelId = String(profile.channelId || '');
    if (!profileChannelId || catalogChannelIds.has(profileChannelId)) continue;
    merged.push({
      channelId: profileChannelId,
      channelTitle: String(profile.channelTitle || profileChannelId),
      cover: null,
      inCatalog: false,
      profile: formatLiveTvBufferProfile(profile, { channelId: profileChannelId, channelTitle: String(profile.channelTitle || profileChannelId) })
    });
  }

  const filtered = merged.filter((item) => {
    if (enabled !== 'all') {
      const isEnabled = !!item.profile.enabled;
      if (enabled === 'true' && !isEnabled) return false;
      if (enabled === 'false' && isEnabled) return false;
    }

    if (status !== 'all' && String(item.profile.status) !== status) return false;

    if (!term) return true;
    const haystack = `${String(item.channelTitle || '')} ${String(item.channelId || '')}`.toLowerCase();
    return haystack.includes(term);
  });

  const total = filtered.length;
  const totalPages = Math.max(1, Math.ceil(total / limit));
  const safePage = Math.min(page, totalPages);
  const start = (safePage - 1) * limit;
  const data = filtered.slice(start, start + limit);

  const summary = {
    totalChannels: merged.length,
    enabledChannels: merged.filter((item) => item.profile.enabled).length,
    warmingChannels: merged.filter((item) => item.profile.status === 'warming').length,
    readyChannels: merged.filter((item) => item.profile.status === 'ready').length,
    errorChannels: merged.filter((item) => item.profile.status === 'error').length
  };

  return res.json({
    success: true,
    page: safePage,
    total,
    totalPages,
    limit,
    summary,
    data
  });
}));

router.get('/api/admin/livetv-buffer/profiles/:channelId', adminAuth, asyncHandler(async (req, res) => {
  const parsed = liveTvChannelParamSchema.safeParse(req.params);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Parâmetros inválidos', details: parsed.error.flatten() });
  }

  const LiveTvBufferProfile = getLiveTvBufferProfileModel(req);
  const profile = await LiveTvBufferProfile.findOne({ channelId: parsed.data.channelId }).lean();
  if (!profile) {
    return res.status(404).json({ error: 'Perfil de buffering não encontrado' });
  }

  return res.json({
    success: true,
    data: formatLiveTvBufferProfile(profile, { channelId })
  });
}));

router.put('/api/admin/livetv-buffer/profiles/:channelId', adminAuth, asyncHandler(async (req, res) => {
  try {
    const parsedParams = liveTvChannelParamSchema.safeParse(req.params);
    if (!parsedParams.success) {
      return res.status(400).json({ error: 'Parâmetros inválidos', details: parsedParams.error.flatten() });
    }

    const parsedBody = liveTvBufferProfileSchema.safeParse(req.body || {});
    if (!parsedBody.success) {
      return res.status(400).json({ error: 'Dados inválidos', details: parsedBody.error.flatten() });
    }

    const { channelId } = parsedParams.data;
    const updates = parsedBody.data;
    const LiveTvBufferProfile = getLiveTvBufferProfileModel(req);

    const existing = await LiveTvBufferProfile.findOne({ channelId }).lean();
    const nextEnabled = typeof updates.enabled === 'boolean' ? updates.enabled : !!existing?.enabled;

    const payload = {
      ...updates,
      status: nextEnabled
        ? (existing?.status === 'disabled' || !existing?.status ? 'idle' : existing.status)
        : 'disabled',
      lastError: nextEnabled ? (existing?.lastError || null) : null
    };

    await LiveTvBufferProfile.updateOne(
      { channelId },
      { $set: payload, $setOnInsert: { channelId } },
      { upsert: true }
    );

    const profile = await LiveTvBufferProfile.findOne({ channelId }).lean();

    return res.json({
      success: true,
      data: formatLiveTvBufferProfile(profile || payload, { channelId })
    });
  } catch (error) {
    logger.error({ msg: 'erro ao salvar live tv buffer profile', error: error.stack || error.message });
    return res.status(500).json({ error: 'Falha ao salvar perfil de buffering', details: error.message });
  }
}));

router.post('/api/admin/livetv-buffer/profiles/:channelId/warmup', adminAuth, asyncHandler(async (req, res) => {
  try {
    const parsed = liveTvChannelParamSchema.safeParse(req.params);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Parâmetros inválidos', details: parsed.error.flatten() });
    }

    const channelId = parsed.data.channelId;
    const LiveTvBufferProfile = getLiveTvBufferProfileModel(req);
    const catalogItem = (CACHE_CONTEUDO.livetv || []).find((item) => String(item?.id || '') === channelId);
    const fallbackTitle = getLiveTvChannelLabel(catalogItem || { id: channelId });

    const profile = await LiveTvBufferProfile.findOneAndUpdate(
      { channelId },
      {
        enabled: true,
        status: 'warming',
        lastWarmupAt: new Date(),
        lastError: null,
        statusNote: 'Warmup solicitado manualmente pelo admin'
      },
      { upsert: true, new: true, lean: true, setDefaultsOnInsert: true }
    );

    if (!profile.channelTitle) {
      await LiveTvBufferProfile.updateOne({ channelId }, { $set: { channelTitle: fallbackTitle } });
    }

    const finalProfile = await LiveTvBufferProfile.findOne({ channelId }).lean();

    return res.json({
      success: true,
      message: 'Warmup solicitado. Integração do worker será conectada no próximo passo.',
      data: formatLiveTvBufferProfile(finalProfile, { channelId, enabled: true, status: 'warming', channelTitle: fallbackTitle })
    });
  } catch (error) {
    logger.error({ msg: 'erro ao solicitar warmup live tv buffer', error: error.stack || error.message });
    return res.status(500).json({ error: 'Falha ao solicitar warmup', details: error.message });
  }
}));

router.get('/api/admin/content/details', adminAuth, asyncHandler(async (req, res) => {
  const parsed = contentDetailsSchema.safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Parâmetros inválidos', details: parsed.error.flatten() });
  }

  const { id, type } = parsed.data;
  const details = await buscarDetalhes(id, type);
  if (!details) return res.status(404).json({ error: 'Conteúdo não encontrado' });

  return res.json({ success: true, data: details });
}));

router.post('/api/admin/content-link', adminAuth, asyncHandler(async (req, res) => {
  const parsed = createLinkSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Dados inválidos', details: parsed.error.flatten() });
  }

  const { User, PurchasedContent } = req.app.locals.models;
  const { userId, contentId, sourceType, contentType, season, episodeId, expiresAt, prepareCache } = parsed.data;
  const expirationDate = new Date(expiresAt);
  if (Number.isNaN(expirationDate.getTime())) {
    return res.status(400).json({ error: 'Data de expiração inválida' });
  }

  const user = await ensureAdminTestUser(User, userId);
  const details = await buscarDetalhes(contentId, sourceType);
  if (!details || !details.title) {
    return res.status(404).json({ error: 'Conteúdo não encontrado' });
  }

  const seriesTitle = String(details.title || '').trim();
  const seasonKey = String(season || '').trim();
  const baseUrl = String(env.DOMINIO_PUBLICO || '').replace(/\/$/, '');
  const now = new Date();
  const responseItems = [];
  const accessGroupId = require('crypto').randomBytes(12).toString('hex');

  const createPurchase = async ({ videoId, episodeName = null, mediaType = contentType === 'movie' ? 'movie' : 'series', episodeIndex = null, totalEpisodes = null, seasonValue = null }) => {
    const token = buildAccessToken({ userId: user.userId, videoId, mediaType, expiresAt: expirationDate });
    const sessionToken = require('crypto').randomBytes(32).toString('hex');

    const purchase = new PurchasedContent({
      userId: user.userId,
      videoId: String(videoId),
      mediaType,
      title: seriesTitle,
      episodeName: episodeName || undefined,
      season: mediaType === 'series' ? String(seasonValue || seasonKey || '').trim() || undefined : undefined,
      seriesId: sourceType === 'series' ? String(contentId) : undefined,
      episodeIndex: Number.isFinite(episodeIndex) ? episodeIndex : undefined,
      totalEpisodes: Number.isFinite(totalEpisodes) ? totalEpisodes : undefined,
      accessGroupId,
      purchaseDate: now,
      expiresAt: expirationDate,
      token,
      price: 0,
      sessionToken,
      viewed: false,
      viewCount: 0
    });

    const cacheResult = await ensureBunnyCacheForPurchase(purchase, { skipCache: !prepareCache });
    const playerUrl = `${baseUrl}/player/${token}`;

    responseItems.push({
      token,
      playerUrl,
      videoId: String(videoId),
      mediaType,
      episodeName: episodeName || null,
      season: mediaType === 'series' ? String(seasonValue || seasonKey || '').trim() || null : null,
      cacheStatus: cacheResult.cacheStatus,
      cacheStrategy: cacheResult.cacheStrategy,
      storagePath: cacheResult.storagePath,
      accessGroupId,
      expiresAt: expirationDate.toISOString()
    });

    return purchase;
  };

  if (contentType === 'movie') {
    await createPurchase({ videoId: contentId, mediaType: 'movie' });
  } else {
    const seasonMap = details.seasons || {};
    const availableSeasons = Object.keys(seasonMap);
    if (contentType === 'full-series') {
      let addedEpisodes = 0;

      for (const currentSeason of availableSeasons) {
        const episodes = Array.isArray(seasonMap[currentSeason]) ? seasonMap[currentSeason] : [];
        for (let index = 0; index < episodes.length; index += 1) {
          const episode = episodes[index];
          await createPurchase({
            videoId: episode.id,
            episodeName: episode.name,
            mediaType: 'series',
            episodeIndex: index + 1,
            totalEpisodes: episodes.length,
            seasonValue: currentSeason
          });
          addedEpisodes += 1;
        }
      }

      if (addedEpisodes === 0) {
        return res.status(400).json({ error: 'Série sem episódios disponíveis' });
      }
    } else {
      const chosenSeason = seasonKey || availableSeasons[0];
      const episodes = Array.isArray(seasonMap[chosenSeason]) ? seasonMap[chosenSeason] : [];

      if (episodes.length === 0) {
        return res.status(400).json({ error: 'Temporada sem episódios disponíveis' });
      }

      if (contentType === 'episode') {
        const episode = episodes.find((ep) => String(ep.id) === String(episodeId)) || episodes[0];
        const episodeIndex = Math.max(1, episodes.findIndex((ep) => String(ep.id) === String(episode.id)) + 1);
        await createPurchase({
          videoId: episode.id,
          episodeName: episode.name,
          mediaType: 'series',
          episodeIndex,
          totalEpisodes: episodes.length,
          seasonValue: chosenSeason
        });
      } else {
        for (let index = 0; index < episodes.length; index += 1) {
          const episode = episodes[index];
          await createPurchase({
            videoId: episode.id,
            episodeName: episode.name,
            mediaType: 'series',
            episodeIndex: index + 1,
            totalEpisodes: episodes.length,
            seasonValue: chosenSeason
          });
        }
      }
    }
  }

  const visibleLinks = (contentType === 'season' || contentType === 'full-series') ? responseItems.slice(0, 1) : responseItems;

  return res.json({
    success: true,
    groupId: accessGroupId,
    userId: user.userId,
    contentTitle: seriesTitle,
    contentType,
    season: contentType === 'full-series' ? null : seasonKey || null,
    sourceType,
    expiresAt: expirationDate.toISOString(),
    prepareCache,
    links: visibleLinks,
    hiddenLinks: Math.max(0, responseItems.length - visibleLinks.length),
    totalItems: responseItems.length,
    primaryLink: responseItems[0]?.playerUrl || null,
    totalLinks: visibleLinks.length
  });
}));

router.get('/api/admin/content-link/status', adminAuth, asyncHandler(async (req, res) => {
  const parsed = linkStatusSchema.safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Parâmetros inválidos', details: parsed.error.flatten() });
  }

  const { PurchasedContent } = req.app.locals.models;
  const bunnyConfigured = bunnyStorage.isConfigured?.() || false;
  const purchase = await PurchasedContent.findOne({ token: parsed.data.token });
  if (!purchase) {
    return res.status(404).json({ error: 'Link não encontrado' });
  }

  const groupFilter = purchase.accessGroupId
    ? { accessGroupId: purchase.accessGroupId, userId: purchase.userId }
    : { token: purchase.token, userId: purchase.userId };

  const groupPurchases = await PurchasedContent.find(groupFilter)
    .sort({ episodeIndex: 1, purchaseDate: 1 })
    .select('token userId videoId title episodeName mediaType season expiresAt cacheStatus cacheProgress storagePath accessGroupId')
    .lean();

  const formatted = groupPurchases.map((item) => formatLinkStatus(item, { bunnyConfigured }));
  const summary = summarizeGroupStatus(formatted);
  const primary = formatted.find((item) => String(item.token) === String(purchase.token)) || formatted[0] || formatLinkStatus(purchase, { bunnyConfigured });

  return res.json({
    success: true,
    data: {
      ...primary,
      ...summary,
      groupId: purchase.accessGroupId || null,
      links: formatted
    }
  });
}));

router.post('/api/admin/content-link/revoke', adminAuth, asyncHandler(async (req, res) => {
  const parsed = revokeLinkSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Dados inválidos', details: parsed.error.flatten() });
  }

  const { PurchasedContent } = req.app.locals.models;
  const { token, revokeGroup } = parsed.data;
  const purchase = await PurchasedContent.findOne({ token });

  if (!purchase) {
    return res.status(404).json({ error: 'Link não encontrado' });
  }

  const now = new Date();
  const filter = (revokeGroup && purchase.accessGroupId)
    ? { accessGroupId: purchase.accessGroupId, userId: purchase.userId }
    : { token: purchase.token, userId: purchase.userId };

  const updateResult = await PurchasedContent.updateMany(filter, {
    $set: {
      expiresAt: now,
      cacheUpdatedAt: now
    }
  });

  return res.json({
    success: true,
    token,
    groupId: purchase.accessGroupId || null,
    revokeGroup: !!(revokeGroup && purchase.accessGroupId),
    revokedCount: updateResult.modifiedCount || 0,
    revokedAt: now.toISOString()
  });
}));

router.post('/api/admin/content-link/requeue', adminAuth, asyncHandler(async (req, res) => {
  const { token, group } = req.body || {};
  if (!token && !group) {
    return res.status(400).json({ error: 'token or group required' });
  }

  const { PurchasedContent } = req.app.locals.models;
  let filter;
  if (group) {
    filter = { accessGroupId: group };
  } else {
    filter = { token };
  }

  const purchases = await PurchasedContent.find(filter).lean();
  if (!purchases || purchases.length === 0) {
    return res.status(404).json({ error: 'Purchases not found' });
  }

  // enqueue each purchase for retry
  const bunny = require('../services/bunny-cache.service');
  let queued = 0;
  for (const p of purchases) {
    // need a mongoose document; fetch full doc
    const doc = await PurchasedContent.findOne({ _id: p._id });
    if (doc) {
      await doc.updateOne({ $set: { cacheStatus: 'pending', cacheProgress: 0, cacheUpdatedAt: new Date(), cacheError: null } });
      bunny.enqueue(doc);
      queued += 1;
    }
  }

  return res.json({ success: true, queued });
}));

module.exports = router;