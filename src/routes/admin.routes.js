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
  limit: z.coerce.number().int().min(1).max(50).optional().default(20)
});

const contentDetailsSchema = z.object({
  id: z.string().trim().min(1),
  type: z.enum(['movies', 'series'])
});

const createLinkSchema = z.object({
  userId: z.coerce.number().int().positive(),
  contentId: z.string().trim().min(1),
  sourceType: z.enum(['movies', 'series']).default('movies'),
  contentType: z.enum(['movie', 'episode', 'season']),
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
  const cacheStatus = purchase.cacheStatus || (purchase.storagePath && bunnyConfigured ? 'ready' : 'origin');
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
  purchase.storagePath = storagePath;

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

  await purchase.updateOne({
    $set: {
      storagePath,
      cacheStatus: 'pending',
      cacheProgress: 0,
      cacheUpdatedAt: new Date()
    }
  });

  bunnyCacheService.enqueue(purchase);
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
    await atualizarCache(true);

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

  return res.json({
    success: true,
    total: matches.length,
    refreshed: false,
    data: matches
  });
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

  const createPurchase = async ({ videoId, episodeName = null, mediaType = contentType === 'movie' ? 'movie' : 'series', episodeIndex = null, totalEpisodes = null }) => {
    const token = buildAccessToken({ userId: user.userId, videoId, mediaType, expiresAt: expirationDate });
    const sessionToken = require('crypto').randomBytes(32).toString('hex');

    const purchase = new PurchasedContent({
      userId: user.userId,
      videoId: String(videoId),
      mediaType,
      title: seriesTitle,
      episodeName: episodeName || undefined,
      season: mediaType === 'series' ? seasonKey || undefined : undefined,
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
        totalEpisodes: episodes.length
      });
    } else {
      for (let index = 0; index < episodes.length; index += 1) {
        const episode = episodes[index];
        await createPurchase({
          videoId: episode.id,
          episodeName: episode.name,
          mediaType: 'series',
          episodeIndex: index + 1,
          totalEpisodes: episodes.length
        });
      }
    }
  }

  const visibleLinks = contentType === 'season' ? responseItems.slice(0, 1) : responseItems;

  return res.json({
    success: true,
    groupId: accessGroupId,
    userId: user.userId,
    contentTitle: seriesTitle,
    contentType,
    season: seasonKey || null,
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

module.exports = router;