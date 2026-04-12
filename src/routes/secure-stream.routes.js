const express = require('express');
const jwt = require('jsonwebtoken');
const { z } = require('zod');

const env = require('../config/env');
const logger = require('../lib/logger');
const asyncHandler = require('../middlewares/async-handler');
const detectSuspiciousClient = require('../middlewares/detect-suspicious-client');
const streamRateLimit = require('../middlewares/stream-rate-limit');
const { gerarUrlAssinada, SIGNED_URL_TTL } = require('../services/signed-url.service');

const router = express.Router();

const paramsSchema = z.object({
  token: z.string().min(20),
  sessionToken: z.string().min(10)
});

function validateParams(req, res) {
  const parsed = paramsSchema.safeParse(req.params);
  if (!parsed.success) {
    res.status(400).json({ error: 'Parâmetros inválidos' });
    return null;
  }
  return parsed.data;
}

function isExpired(expiresAt) {
  if (!expiresAt) return true;
  const d = new Date(expiresAt);
  if (Number.isNaN(d.getTime())) return true;
  return new Date() > d;
}

/**
 * Valida o vínculo entre o JWT e o documento de compra.
 * Tolerante: só bloqueia se o campo existir no purchase E for diferente do JWT.
 * Isso evita 403 por campos ausentes/renomeados no MongoDB (ex: mediaType vs contentType).
 */
function validatePurchaseMatch(purchase, userId, videoId, mediaType, requestId) {
  const purchaseUserId   = String(purchase.userId   || '');
  const purchaseVideoId  = String(purchase.videoId  || purchase.contentId   || '');
  const purchaseMediaType = String(purchase.mediaType || purchase.contentType || '');

  const userMatch      = !purchaseUserId    || purchaseUserId    === String(userId);
  const videoMatch     = !purchaseVideoId   || purchaseVideoId   === String(videoId);
  const mediaTypeMatch = !purchaseMediaType || purchaseMediaType === String(mediaType);

  if (!userMatch || !videoMatch || !mediaTypeMatch) {
    logger.warn({
      msg: 'stream-secure mismatch token/purchase',
      requestId,
      jwtUserId: userId,
      jwtVideoId: videoId,
      jwtMediaType: mediaType,
      purchaseUserId,
      purchaseVideoId,
      purchaseMediaType,
      userMatch,
      videoMatch,
      mediaTypeMatch
    });
    return false;
  }

  return true;
}

// ===== GET /api/stream-secure/:token/:sessionToken =====
router.get(
  '/api/stream-secure/:token/:sessionToken',
  detectSuspiciousClient,
  streamRateLimit,
  asyncHandler(async (req, res) => {
    const p = validateParams(req, res);
    if (!p) return;

    const token       = decodeURIComponent(p.token);
    const sessionToken = decodeURIComponent(p.sessionToken);

    const { User, PurchasedContent } = req.app.locals.models;

    let decoded;
    try {
      decoded = jwt.verify(token, env.JWT_SECRET);
    } catch (err) {
      logger.warn({ msg: 'stream-secure jwt inválido', requestId: req.requestId, err: err.message });
      return res.sendStatus(403);
    }

    const { videoId, mediaType, userId } = decoded || {};
    if (!videoId || !mediaType || !userId) {
      logger.warn({ msg: 'stream-secure jwt sem campos obrigatórios', requestId: req.requestId });
      return res.sendStatus(403);
    }

    const purchase = await PurchasedContent.findOne({ token, sessionToken });
    if (!purchase) {
      logger.warn({
        msg: 'stream-secure token nao encontrado',
        requestId: req.requestId,
        userId,
        videoId
      });
      return res.sendStatus(403);
    }

    if (!validatePurchaseMatch(purchase, userId, videoId, mediaType, req.requestId)) {
      return res.sendStatus(403);
    }

    if (isExpired(purchase.expiresAt)) {
      logger.info({
        msg: 'stream-secure conteudo expirado',
        requestId: req.requestId,
        userId,
        videoId,
        expiredAt: purchase.expiresAt ? new Date(purchase.expiresAt).toISOString() : null
      });
      return res.status(410).json({ error: 'Conteúdo expirado', expired: true });
    }

    const user = await User.findOne({ userId });
    if (!user || user.isBlocked) {
      logger.warn({
        msg: 'stream-secure usuario bloqueado/invalido',
        requestId: req.requestId,
        userId
      });
      return res.sendStatus(403);
    }

    const signedUrl = gerarUrlAssinada(videoId, userId, mediaType);

    logger.info({
      msg: 'signed url gerada',
      requestId: req.requestId,
      userId,
      videoId,
      mediaType,
      signedUrl,
      ttlSeconds: SIGNED_URL_TTL,
      signedExpAt: new Date(Date.now() + SIGNED_URL_TTL * 1000).toISOString(),
      purchaseExpiresAt: new Date(purchase.expiresAt).toISOString()
    });

    res.setHeader('Cache-Control', 'no-store, no-cache, private, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('X-Content-Type-Options', 'nosniff');

    return res.redirect(302, signedUrl);
  })
);

// ===== GET /api/refresh-stream/:token/:sessionToken =====
router.get(
  '/api/refresh-stream/:token/:sessionToken',
  detectSuspiciousClient,
  asyncHandler(async (req, res) => {
    const p = validateParams(req, res);
    if (!p) return;

    const token       = decodeURIComponent(p.token);
    const sessionToken = decodeURIComponent(p.sessionToken);

    const { User, PurchasedContent } = req.app.locals.models;

    let decoded;
    try {
      decoded = jwt.verify(token, env.JWT_SECRET);
    } catch (err) {
      logger.warn({ msg: 'refresh-stream jwt inválido', requestId: req.requestId, err: err.message });
      return res.status(403).json({ error: 'Inválido' });
    }

    const { videoId, mediaType, userId } = decoded || {};
    if (!videoId || !mediaType || !userId) {
      return res.status(403).json({ error: 'Inválido' });
    }

    const purchase = await PurchasedContent.findOne({ token, sessionToken });
    if (!purchase) {
      return res.status(403).json({ error: 'Token não encontrado' });
    }

    if (!validatePurchaseMatch(purchase, userId, videoId, mediaType, req.requestId)) {
      return res.status(403).json({ error: 'Inválido' });
    }

    if (isExpired(purchase.expiresAt)) {
      logger.info({
        msg: 'refresh-stream expirado',
        requestId: req.requestId,
        userId,
        videoId
      });
      return res.status(410).json({ error: 'Conteúdo expirado', expired: true });
    }

    const user = await User.findOne({ userId });
    if (!user || user.isBlocked) {
      return res.status(403).json({ error: 'Bloqueado' });
    }

    const signedUrl = gerarUrlAssinada(videoId, userId, mediaType);

    logger.info({
      msg: 'refresh stream ok',
      requestId: req.requestId,
      userId,
      videoId,
      mediaType,
      signedExpAt: new Date(Date.now() + SIGNED_URL_TTL * 1000).toISOString()
    });

    return res.json({ url: signedUrl });
  })
);

module.exports = router;