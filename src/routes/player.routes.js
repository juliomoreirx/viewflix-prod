const express = require('express');
const jwt = require('jsonwebtoken');
const { HttpProxyAgent } = require('http-proxy-agent');
const fs = require('fs-extra');
const path = require('path');
const he = require('he');

const router = express.Router();

const env = require('../config/env');
const User = require('../models/user.model');
const PurchasedContent = require('../models/purchased-content.model');

const JWT_SECRET = env.JWT_SECRET;

// Proxy residencial opcional
const RES_PROXY_ENABLED = String(env.RES_PROXY_ENABLED || 'false')
  .replace(/['"]/g, '')
  .trim()
  .toLowerCase() === 'true';

const RES_PROXY_HOST = (env.RES_PROXY_HOST || '').trim();
const RES_PROXY_PORT = parseInt(String(env.RES_PROXY_PORT || '0').trim(), 10);
const RES_PROXY_USER = env.RES_PROXY_USER || '';
const RES_PROXY_PASS = env.RES_PROXY_PASS || '';

let residentialProxyAgent = null;
if (RES_PROXY_ENABLED && RES_PROXY_HOST && RES_PROXY_PORT && RES_PROXY_USER && RES_PROXY_PASS) {
  const proxyUrl = `http://${encodeURIComponent(RES_PROXY_USER)}:${encodeURIComponent(RES_PROXY_PASS)}@${RES_PROXY_HOST}:${RES_PROXY_PORT}`;
  residentialProxyAgent = new HttpProxyAgent(proxyUrl);
}

// ===== PLAYER =====
// ===== PLAYER =====
router.get('/player/:token', async (req, res) => {
  try {
    const decoded = jwt.verify(req.params.token, JWT_SECRET);
    const { videoId, mediaType, userId } = decoded;

    const purchase = await PurchasedContent.findOne({ token: req.params.token });
    if (!purchase) throw new Error('Conteúdo não encontrado');
    if (new Date() > purchase.expiresAt) throw new Error('Link expirado');

    const user = await User.findOne({ userId });
    if (!user || user.isBlocked) throw new Error('Usuário bloqueado');

    purchase.viewed = true;
    purchase.viewCount = (purchase.viewCount || 0) + 1;
    await purchase.save();

    const streamPath = `/api/stream-secure/${req.params.token}/${purchase.sessionToken}`;
    const expirationTimestamp = purchase.expiresAt.getTime();

    // ==========================================
    // NOVO FRONT-END VIEWFLIX SPACE (Extract to view file)
    // ==========================================
    const playerHtmlPath = path.join(__dirname, '..', 'views', 'player.html');
    let html = await fs.readFile(playerHtmlPath, 'utf8');
    
    // Encode variables to prevent XSS
    const safeTitle = he.encode(purchase.title || '');
    const safeEpisodeName = purchase.episodeName ? `<div class="meta"><span><i class="fas fa-satellite-dish"></i> ${he.encode(purchase.episodeName)}</span></div>` : '';
    const safePurchaseDate = new Date(purchase.purchaseDate).toLocaleDateString('pt-BR');
    
    html = html.replace(/\{\{title\}\}/g, safeTitle)
               .replace(/\{\{episodeNameHtml\}\}/g, safeEpisodeName)
               .replace(/\{\{purchaseDate\}\}/g, safePurchaseDate)
               .replace(/\{\{viewCount\}\}/g, purchase.viewCount)
               .replace(/\{\{viewCountSuffix\}\}/g, purchase.viewCount === 1 ? 'ão' : 'ões')
               .replace(/\{\{userId\}\}/g, he.encode(String(userId)))
               .replace(/\{\{videoId\}\}/g, he.encode(String(videoId)))
               .replace(/\{\{token\}\}/g, he.encode(req.params.token))
               .replace(/\{\{sessionToken\}\}/g, he.encode(purchase.sessionToken))
               .replace(/\{\{expirationTimestamp\}\}/g, expirationTimestamp)
               .replace(/\{\{streamPath\}\}/g, streamPath);

    res.send(html);
  } catch (error) {
    console.error('Erro no player:', error.message);
    
    // TELA DE ERRO (ACESSO NEGADO) TEMA ESPACIAL
    const errorHtmlPath = path.join(__dirname, '..', '..', 'public', '403.html');
    try {
      const html = await fs.readFile(errorHtmlPath, 'utf8');
      res.status(403).send(html);
    } catch(e) {
      res.status(403).send('Acesso Negado');
    }
  }
});

// ===== LOG PLAY =====
router.post('/api/log-view', async (req, res) => {
  try {
    const { userId, videoId } = req.body;
    console.log(`📊 Play: User ${userId} | Vídeo ${videoId}`);
    res.sendStatus(200);
  } catch {
    res.sendStatus(500);
  }
});

module.exports = router;