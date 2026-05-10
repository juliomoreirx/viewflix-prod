const express = require('express');
const jwt = require('jsonwebtoken');
const { HttpProxyAgent } = require('http-proxy-agent');

const router = express.Router();

const env = require('../config/env');
const User = require('../models/user.model');
const PurchasedContent = require('../models/purchased-content.model');

const JWT_SECRET = env.JWT_SECRET;

router.get('/api/progress/:token', async (req, res) => {
  try {
    const decoded = jwt.verify(req.params.token, JWT_SECRET);
    const { userId } = decoded;
    const purchase = await PurchasedContent.findOne({ token: req.params.token, userId });
    if (!purchase) return res.status(404).json({ resumeSeconds: 0 });
    if (new Date() > purchase.expiresAt) return res.status(410).json({ resumeSeconds: 0 });
    return res.json({ resumeSeconds: Number(purchase.resumeSeconds || 0) });
  } catch (error) {
    return res.status(401).json({ resumeSeconds: 0 });
  }
});

router.post('/api/progress', async (req, res) => {
  try {
    const { token, position, duration, ended } = req.body || {};
    if (!token) return res.sendStatus(400);
    const decoded = jwt.verify(token, JWT_SECRET);
    const { userId } = decoded;
    const purchase = await PurchasedContent.findOne({ token, userId });
    if (!purchase) return res.sendStatus(404);
    if (new Date() > purchase.expiresAt) return res.sendStatus(410);

    const safeDuration = Number.isFinite(duration) ? Math.max(0, duration) : 0;
    const safePosition = Number.isFinite(position) ? Math.max(0, position) : 0;
    const shouldReset = ended || (safeDuration > 0 && safePosition >= Math.max(0, safeDuration - 5));

    purchase.resumeSeconds = shouldReset ? 0 : Math.floor(safePosition);
    purchase.resumeUpdatedAt = new Date();
    await purchase.save();
    return res.sendStatus(200);
  } catch (error) {
    return res.sendStatus(401);
  }
});

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

    // Determine stream URL: use HLS manifest if available, otherwise use MP4
    let streamPath = `/api/stream-secure/${req.params.token}/${purchase.sessionToken}`;
    if (purchase.hlsManifestUrl) {
      // If HLS manifest was generated during transcode, use it directly
      streamPath = purchase.hlsManifestUrl;
    }
    
    const expirationTimestamp = purchase.expiresAt.getTime();
    let nextEpisode = null;
    let prevEpisode = null;

    if (purchase.mediaType === 'series') {
      const seasonKey = String(purchase.season || '');
      const sameSeason = await PurchasedContent.find({
        userId,
        mediaType: 'series',
        title: purchase.title,
        season: seasonKey,
        expiresAt: { $gt: new Date() }
      }).select('token episodeName episodeIndex purchaseDate videoId');

      const parseEpisodeIndex = (item) => {
        if (Number.isFinite(item.episodeIndex)) return item.episodeIndex;
        const name = String(item.episodeName || '');
        const match = name.match(/\b(\d{1,3})\b/);
        if (match) return parseInt(match[1], 10);
        return null;
      };

      const ordered = (sameSeason || []).slice().sort((a, b) => {
        const idxA = parseEpisodeIndex(a);
        const idxB = parseEpisodeIndex(b);
        if (Number.isFinite(idxA) && Number.isFinite(idxB) && idxA !== idxB) return idxA - idxB;
        const dateA = new Date(a.purchaseDate || 0).getTime();
        const dateB = new Date(b.purchaseDate || 0).getTime();
        if (dateA !== dateB) return dateA - dateB;
        return String(a.episodeName || '').localeCompare(String(b.episodeName || ''), 'pt-BR', { sensitivity: 'base' });
      });

      const currentIndex = ordered.findIndex((item) => String(item.token) === String(purchase.token));
      if (currentIndex >= 0) {
        const prev = ordered[currentIndex - 1];
        const next = ordered[currentIndex + 1];
        if (prev?.token) prevEpisode = { token: prev.token, episodeName: prev.episodeName || null };
        if (next?.token) nextEpisode = { token: next.token, episodeName: next.episodeName || null };
      }
    }

    // ==========================================
    // NOVO FRONT-END VIEWFLIX SPACE
    // ==========================================
 res.send(`
<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${purchase.title} - ViewFlix Space</title>
  
  <link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90' fill='%234facfe'>👨‍🚀</text></svg>">
  
  <link rel="stylesheet" href="https://cdn.plyr.io/3.7.8/plyr.css" />
  <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css">
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      background: linear-gradient(135deg, #050505 0%, #0b0c1b 50%, #1a1025 100%);
      display: flex; flex-direction: column; justify-content: center; align-items: center;
      min-height: 100vh; font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; color: #e2e8f0; user-select: none;
    }
    
    body::before {
      content: ''; position: absolute; top: 0; left: 0; width: 100%; height: 100%;
      background-image: radial-gradient(#ffffff 1px, transparent 1px), radial-gradient(#ffffff 1px, transparent 1px);
      background-size: 50px 50px; background-position: 0 0, 25px 25px;
      opacity: 0.04; pointer-events: none; z-index: 0;
    }

    .container { width: 100%; max-width: 1400px; padding: 20px; position: relative; z-index: 1; }
    
    .logo { 
      font-size: 34px; font-weight: 800; text-align: center; margin-bottom: 30px; 
      color: #fff; letter-spacing: 1.5px; text-transform: uppercase;
    }
    .logo span {
      background: linear-gradient(90deg, #00f2fe 0%, #4facfe 100%);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
      text-shadow: 0 0 25px rgba(79, 172, 254, 0.4);
    }
    .logo i { color: #4facfe; margin-right: 12px; font-size: 32px; filter: drop-shadow(0 0 10px rgba(79, 172, 254, 0.5)); }

    .video-wrapper { 
      position: relative; width: 100%; background: #000; border-radius: 16px; 
      overflow: hidden; box-shadow: 0 20px 80px rgba(0, 0, 0, 0.9), 0 0 30px rgba(79, 172, 254, 0.15); 
      border: 1px solid rgba(79, 172, 254, 0.2);
    }
    .player-shell { width: 100%; height: 80vh; }
    #player { width: 100%; height: 100%; }
    
    :root {
      --plyr-color-main: #4facfe;
      --plyr-video-control-color: #e2e8f0;
      --plyr-video-control-color-hover: #ffffff;
      --plyr-tooltip-background: rgba(11, 12, 27, 0.95);
      --plyr-tooltip-color: #e2e8f0;
      --plyr-range-fill-background: linear-gradient(90deg, #00f2fe 0%, #4facfe 100%);
      --plyr-video-progress-buffered-background: rgba(255,255,255,0.15);
      --plyr-video-controls-background: linear-gradient(to top, rgba(5,5,5,0.95) 0%, rgba(11,12,27,0.8) 50%, transparent 100%);
      --plyr-control-radius: 8px;
    }

    .plyr,
    .plyr__video-wrapper,
    .plyr video {
      width: 100%;
      height: 100%;
      font-family: 'Segoe UI', Arial, sans-serif;
      background: #000;
    }

    .plyr__control--overlaid {
      background: var(--plyr-video-control-background-hover, var(--plyr-color-main, #00b2ff)) !important;
      border: 0 !important;
      border-radius: 100% !important;
      color: var(--plyr-video-control-color, #fff) !important;
      opacity: .9;
      padding: 15px !important;
      top: 45% !important;
      box-shadow: 0 0 24px rgba(79, 172, 254, 0.45);
    }

    .plyr__control--overlaid:hover {
      opacity: 1;
      box-shadow: 0 0 28px rgba(79, 172, 254, 0.6);
      transform: translate(-50%, -50%) scale(1.01) !important;
    }

    .plyr--video .plyr__controls {
      padding: 12px;
      backdrop-filter: blur(8px);
    }

    .plyr__menu__container,
    .plyr__tooltip {
      backdrop-filter: blur(8px);
      border: 1px solid rgba(79, 172, 254, 0.2);
    }

    .audio-track-wrap {
      display: none;
      align-items: center;
      gap: 8px;
      margin-top: 12px;
      color: #94a3b8;
      font-size: 13px;
    }

    .audio-track-wrap label { color: #4facfe; font-weight: 600; }

    .audio-track-wrap select {
      background: rgba(11, 12, 27, 0.8);
      color: #e2e8f0;
      border: 1px solid rgba(79, 172, 254, 0.3);
      border-radius: 8px;
      padding: 6px 10px;
      outline: none;
    }

    .quality-track-wrap {
      display: none;
      align-items: center;
      gap: 8px;
      margin-top: 12px;
      margin-left: 14px;
      color: #94a3b8;
      font-size: 13px;
    }

    .quality-track-wrap label { color: #4facfe; font-weight: 600; }

    .quality-track-wrap select {
      background: rgba(11, 12, 27, 0.8);
      color: #e2e8f0;
      border: 1px solid rgba(79, 172, 254, 0.3);
      border-radius: 8px;
      padding: 6px 10px;
      outline: none;
    }

    .info-bar { 
      background: rgba(11, 12, 27, 0.7); backdrop-filter: blur(20px); padding: 25px; 
      border-radius: 16px; margin-top: 25px; border: 1px solid rgba(255,255,255,0.08); 
      box-shadow: 0 10px 40px rgba(0,0,0,0.6);
    }
    .title { font-size: 26px; font-weight: 700; margin-bottom: 15px; color: #fff; text-shadow: 0 2px 5px rgba(0,0,0,0.5); }
    .meta { display: flex; gap: 20px; flex-wrap: wrap; font-size: 14.5px; color: #94a3b8; margin-bottom: 15px; }
    .meta span { display: flex; align-items: center; gap: 8px; background: rgba(255,255,255,0.03); padding: 8px 16px; border-radius: 10px; border: 1px solid rgba(255,255,255,0.02); }
    .meta i { color: #4facfe; }
    
    .warning { 
      text-align: center; margin-top: 25px; padding: 15px; background: rgba(79, 172, 254, 0.05); 
      border-radius: 12px; font-size: 13px; color: #64748b; border: 1px solid rgba(79, 172, 254, 0.15); 
    }
    .warning i { color: #4facfe; margin-right: 8px; }
    .timer { display: inline-block; background: rgba(79, 172, 254, 0.15); padding: 4px 10px; border-radius: 6px; font-weight: 700; font-family: 'Courier New', monospace; color: #4facfe; border: 1px solid rgba(79, 172, 254, 0.3); }

    .stream-status {
      display: none;
      margin-top: 15px;
      padding: 12px 14px;
      border-radius: 12px;
      font-size: 13px;
      line-height: 1.5;
      border: 1px solid rgba(245, 158, 11, 0.28);
      background: rgba(245, 158, 11, 0.08);
      color: #fde68a;
    }
    .stream-status.show { display: block; }
    .stream-status strong { color: #fbbf24; }

    .resume-prompt {
      margin-top: 16px;
      padding: 14px 16px;
      border-radius: 12px;
      border: 1px solid rgba(79, 172, 254, 0.25);
      background: rgba(79, 172, 254, 0.08);
      display: none;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      flex-wrap: wrap;
    }
    .resume-prompt button {
      border: 0;
      background: linear-gradient(90deg, #00f2fe 0%, #4facfe 100%);
      color: #000;
      font-weight: 700;
      padding: 10px 16px;
      border-radius: 999px;
      cursor: pointer;
      transition: transform 0.2s ease, box-shadow 0.2s ease;
      box-shadow: 0 10px 30px rgba(79, 172, 254, 0.25);
    }
    .resume-prompt button:hover { transform: translateY(-1px); }

    .episode-actions {
      margin-top: 18px;
      display: none;
      gap: 10px;
      flex-wrap: wrap;
    }
    .episode-actions button {
      border: 1px solid rgba(255,255,255,0.12);
      background: rgba(11, 12, 27, 0.7);
      color: #e2e8f0;
      font-weight: 600;
      padding: 10px 16px;
      border-radius: 999px;
      cursor: pointer;
      transition: transform 0.2s ease, box-shadow 0.2s ease, background 0.2s ease;
      min-height: 44px;
    }
    .episode-actions button.primary {
      background: linear-gradient(90deg, #00f2fe 0%, #4facfe 100%);
      color: #000;
      border: 0;
      box-shadow: 0 10px 30px rgba(79, 172, 254, 0.25);
    }
    .episode-actions button:hover { transform: translateY(-1px); }

    .confirm-overlay {
      position: fixed;
      inset: 0;
      background: rgba(0,0,0,0.65);
      display: none;
      align-items: center;
      justify-content: center;
      z-index: 5;
      padding: 20px;
    }
    .confirm-box {
      background: rgba(11, 12, 27, 0.9);
      border: 1px solid rgba(79, 172, 254, 0.25);
      border-radius: 16px;
      padding: 22px;
      max-width: 420px;
      width: 100%;
      box-shadow: 0 20px 60px rgba(0,0,0,0.6);
    }
    .confirm-box h4 { margin-bottom: 10px; font-size: 18px; color: #fff; }
    .confirm-box p { font-size: 14px; color: #94a3b8; margin-bottom: 16px; }
    .confirm-actions { display: flex; gap: 10px; flex-wrap: wrap; }
    .confirm-actions button { flex: 1 1 140px; }

    .next-episode {
      margin-top: 18px;
      padding: 14px 16px;
      border-radius: 12px;
      border: 1px solid rgba(79, 172, 254, 0.25);
      background: rgba(79, 172, 254, 0.08);
      display: none;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      flex-wrap: wrap;
    }
    .next-episode strong { color: #e2e8f0; }
    .next-episode button {
      border: 0;
      background: linear-gradient(90deg, #00f2fe 0%, #4facfe 100%);
      color: #000;
      font-weight: 700;
      padding: 10px 16px;
      border-radius: 999px;
      cursor: pointer;
      transition: transform 0.2s ease, box-shadow 0.2s ease;
      box-shadow: 0 10px 30px rgba(79, 172, 254, 0.25);
    }
    .next-episode button:hover { transform: translateY(-1px); }
    .next-episode small { color: #94a3b8; }

    @media (max-width: 768px) {
      .player-shell { height: 50vh; }
      .next-episode { flex-direction: column; align-items: flex-start; }
      .next-episode button { width: 100%; }
      .episode-actions { width: 100%; }
      .episode-actions button { width: 100%; }
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="logo"><i class="fa-solid fa-user-astronaut"></i>VIEWFLIX <span>SPACE</span></div>
    <div class="video-wrapper">
      <div class="player-shell">
        <video id="player" playsinline controls preload="auto" crossorigin="anonymous"></video>
      </div>
    </div>
    <div class="resume-prompt" id="resumePrompt">
      <div>
        <strong>Continuar de onde parou:</strong>
        <span id="resumeTime">00:00</span>
      </div>
      <button id="resumeBtn">Continuar</button>
    </div>
    <div class="info-bar">
      <div class="title">${purchase.title}</div>
      ${purchase.episodeName ? `<div class="meta"><span><i class="fas fa-satellite-dish"></i> ${purchase.episodeName}</span></div>` : ''}
      <div class="meta">
        <span><i class="fas fa-calendar-alt"></i> Comprado em ${new Date(purchase.purchaseDate).toLocaleDateString('pt-BR')}</span>
        <span><i class="fas fa-hourglass-half"></i> Expira em: <span class="timer" id="countdown">Calculando...</span></span>
        <span><i class="fas fa-eye"></i> ${purchase.viewCount} visualizaç${purchase.viewCount === 1 ? 'ão' : 'ões'}</span>
      </div>
      <div style="display:flex; flex-wrap:wrap; align-items:center;">
        <div class="audio-track-wrap" id="audioTrackWrap">
          <label for="audioTrackSelect"><i class="fas fa-volume-up"></i> Áudio</label>
          <select id="audioTrackSelect"></select>
        </div>
        <div class="quality-track-wrap" id="qualityTrackWrap">
          <label for="qualityTrackSelect"><i class="fas fa-tv"></i> Qualidade</label>
          <select id="qualityTrackSelect"></select>
        </div>
      </div>
      <div class="episode-actions" id="episodeActions">
        <button id="prevEpisodeBtn">Episódio anterior</button>
        <button class="primary" id="nextEpisodeBtnInline">Próximo episódio</button>
      </div>
    </div>
    <div class="warning">
      <i class="fas fa-user-shield"></i>
      Missão Pessoal e Intransferível • Conexão Criptografada HMAC • ID do Cadete: ${userId}
    </div>
    <div class="stream-status" id="streamStatus" role="status" aria-live="polite"></div>
  </div>
  <div class="confirm-overlay" id="confirmOverlay" aria-hidden="true">
    <div class="confirm-box">
      <h4>Retomar reprodução?</h4>
      <p>Você parou em <strong id="confirmResumeTime">00:00</strong>. Deseja continuar desse ponto?</p>
      <div class="confirm-actions">
        <button id="confirmResumeBtn" class="primary">Continuar</button>
        <button id="cancelResumeBtn">Começar do início</button>
      </div>
    </div>
  </div>
  <script src="https://cdn.jsdelivr.net/npm/hls.js@1.5.15/dist/hls.min.js"></script>
  <script src="https://cdn.plyr.io/3.7.8/plyr.polyfilled.js"></script>
  <script>
    const expirationTime = ${expirationTimestamp};
    const countdownEl = document.getElementById('countdown');
    const streamPath = ${JSON.stringify(streamPath)};
    const streamStatusEl = document.getElementById('streamStatus');
    const progressToken = ${JSON.stringify(req.params.token)};
    let resumeSeconds = ${Number(purchase.resumeSeconds || 0)};
    const nextEpisode = ${JSON.stringify(nextEpisode)};
    const prevEpisode = ${JSON.stringify(prevEpisode)};
    const resumePrompt = document.getElementById('resumePrompt');
    const resumeBtn = document.getElementById('resumeBtn');
    const resumeTime = document.getElementById('resumeTime');
    const confirmOverlay = document.getElementById('confirmOverlay');
    const confirmResumeTime = document.getElementById('confirmResumeTime');
    const confirmResumeBtn = document.getElementById('confirmResumeBtn');
    const cancelResumeBtn = document.getElementById('cancelResumeBtn');
    const episodeActions = document.getElementById('episodeActions');
    const prevEpisodeBtn = document.getElementById('prevEpisodeBtn');
    const nextEpisodeBtnInline = document.getElementById('nextEpisodeBtnInline');
    const isLiveTvContent = ${JSON.stringify(String(purchase.mediaType || '') === 'livetv')};
    const liveTvChannelId = ${JSON.stringify(String(videoId || ''))};
    const liveTvBufferStatusEndpoint = isLiveTvContent ? '/api/livetv-buffer/' + encodeURIComponent(liveTvChannelId) + '/status' : '';
    const isVodContent = !isLiveTvContent;

    const LIVE_DELAY_SECONDS = 8;
    const LIVE_DELAY_WARNING_THRESHOLD = 1;
    const LIVE_TV_WARMUP_POLL_MS = 3000;
    const LIVE_TV_WARMUP_MAX_ATTEMPTS = 12;

    function setStreamStatus(message, tone = 'warn') {
      if (!streamStatusEl) return;
      streamStatusEl.innerHTML = message;
      streamStatusEl.classList.add('show');

      if (tone === 'error') {
        streamStatusEl.style.borderColor = 'rgba(239, 68, 68, 0.3)';
        streamStatusEl.style.background = 'rgba(239, 68, 68, 0.08)';
        streamStatusEl.style.color = '#fecaca';
      } else {
        streamStatusEl.style.borderColor = 'rgba(245, 158, 11, 0.28)';
        streamStatusEl.style.background = 'rgba(245, 158, 11, 0.08)';
        streamStatusEl.style.color = '#fde68a';
      }
    }

    function clearStreamStatus() {
      if (!streamStatusEl) return;
      streamStatusEl.classList.remove('show');
      streamStatusEl.innerHTML = '';
    }

    function updateCountdown() {
      const now = Date.now();
      const diff = expirationTime - now;

      if (diff <= 0) {
        countdownEl.innerText = 'SINAL PERDIDO';
        countdownEl.style.color = '#ef4444';
        countdownEl.style.borderColor = 'rgba(239, 68, 68, 0.3)';
        countdownEl.style.background = 'rgba(239, 68, 68, 0.1)';
        
        if (typeof player !== 'undefined' && player) { 
          try { player.pause(); } catch (e) {}
        }
        if (typeof hls !== 'undefined' && hls) {
          try { hls.destroy(); } catch (e) {}
        }
          document.querySelector('.video-wrapper').innerHTML = '<div style="padding: 50px; text-align: center; color: #4facfe; background: #000; height: 100%; display: flex; align-items: center; justify-content: center; flex-direction: column;"><h3><i class="fa-solid fa-meteor" style="font-size:40px; margin-bottom:15px;"></i><br>Transmissão Expirada</h3><p style="color:#94a3b8; margin-top:10px;">O seu tempo de acesso a este conteúdo chegou ao fim.</p></div>';
        clearInterval(timerInterval);
        return;
      }

      const days = Math.floor(diff / (1000 * 60 * 60 * 24));
      const hours = Math.floor((diff % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));
      const minutes = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60));
      const seconds = Math.floor((diff % (1000 * 60)) / 1000);

      const d = days > 0 ? days + 'd ' : '';
      const h = (hours > 0 || days > 0) ? hours.toString().padStart(2, '0') + 'h ' : '';
      const m = minutes.toString().padStart(2, '0') + 'm ';
      const s = seconds.toString().padStart(2, '0') + 's';

      countdownEl.innerText = d + h + m + s;
    }

    updateCountdown();
    const timerInterval = setInterval(updateCountdown, 1000);

    let player;
    let hls;
    let retryCount = 0;
    let playLogged = false;
    let lastProgressSaveAt = 0;
    let lastProgressSecond = 0;
    let nextEpisodeTimer = null;
    let liveTvWarmupTimer = null;
    let liveTvWarmupAttempts = 0;
    let liveTvPlaybackStarted = false;
    let vodUserSeeking = false;
    const audioTrackWrap = document.getElementById('audioTrackWrap');
    const audioTrackSelect = document.getElementById('audioTrackSelect');
    const qualityTrackWrap = document.getElementById('qualityTrackWrap');
    const qualityTrackSelect = document.getElementById('qualityTrackSelect');

    function escapeHtml(value = '') {
      return String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
    }

    function stopLiveTvWarmupPolling() {
      if (liveTvWarmupTimer) {
        clearTimeout(liveTvWarmupTimer);
        liveTvWarmupTimer = null;
      }
    }

    function startLiveTvPlayback(message = '', tone = 'warn') {
      stopLiveTvWarmupPolling();
      liveTvPlaybackStarted = true;
      if (message) {
        setStreamStatus(message, tone);
      }
      loadSource(streamPath, 0);
    }

    function scheduleLiveTvStatusCheck() {
      stopLiveTvWarmupPolling();
      liveTvWarmupTimer = setTimeout(() => {
        checkLiveTvBufferStatus();
      }, LIVE_TV_WARMUP_POLL_MS);
    }

    function checkLiveTvBufferStatus() {
      if (!isLiveTvContent || liveTvPlaybackStarted) return;

      if (!liveTvBufferStatusEndpoint) {
        startLiveTvPlayback('<strong>✓ Conectando ao canal ao vivo...</strong>', 'info');
        return;
      }

      liveTvWarmupAttempts++;
      const progressDots = '.'.repeat((liveTvWarmupAttempts % 3) + 1);
      const progressMsg = liveTvWarmupAttempts <= 2 ? 'Carregando' : liveTvWarmupAttempts <= 4 ? 'Otimizando qualidade' : 'Finalizando';

      fetch(liveTvBufferStatusEndpoint, { cache: 'no-store' })
        .then((response) => response.json())
        .then((payload) => {
          const data = payload && payload.data ? payload.data : payload;

          if (!data || !data.status) {
            startLiveTvPlayback('<strong>✓ Conectando ao canal ao vivo...</strong><br><small>Iniciando transmissão agora.</small>', 'info');
            return;
          }

          const note = escapeHtml(data.statusNote || 'Este canal está sendo preparado para melhor qualidade.');

          if (data.enabled && data.status === 'warming') {
            setStreamStatus('<strong>🔄 ' + progressMsg + progressDots + '</strong><br><small>Por favor aguarde, já estamos quase lá!</small>', 'warn');

            if (liveTvWarmupAttempts >= LIVE_TV_WARMUP_MAX_ATTEMPTS) {
              startLiveTvPlayback('<strong>✓ Iniciando canal ao vivo...</strong><br><small>Carregamento concluído.</small>', 'info');
              return;
            }

            scheduleLiveTvStatusCheck();
            return;
          }

          if (data.enabled && data.status === 'error') {
            startLiveTvPlayback('<strong>⚠ Conectando ao canal com qualidade reduzida...</strong><br><small>Alguns travamentos podem ocorrer.</small>', 'warn');
            return;
          }

          if (data.enabled && data.status === 'ready') {
            startLiveTvPlayback('<strong>✓ Canal pronto! Iniciando transmissão...</strong><br><small>Aproveite a melhor qualidade.</small>', 'info');
            return;
          }

          startLiveTvPlayback('<strong>✓ Conectando ao canal ao vivo...</strong>', 'info');
        })
        .catch(() => {
          startLiveTvPlayback('<strong>✓ Conectando ao canal ao vivo...</strong><br><small>Iniciando transmissão agora.</small>', 'info');
        });
    }

    function logPlayOnce() {
      if (playLogged) return;
      fetch('/api/log-view', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: ${userId}, videoId: '${videoId}', token: '${req.params.token}', timestamp: Date.now() })
      }).catch(() => {});
      playLogged = true;
    }

    function renderAudioTracks(tracks, onChange) {
      if (!tracks || tracks.length <= 1) {
        audioTrackWrap.style.display = 'none';
        return;
      }

      audioTrackSelect.innerHTML = '';

      tracks.forEach((track, index) => {
        const option = document.createElement('option');
        const label = track.name || track.lang || 'Faixa ' + (index + 1);
        option.value = String(index);
        option.textContent = label;
        option.selected = !!track.default;
        audioTrackSelect.appendChild(option);
      });

      audioTrackWrap.style.display = 'inline-flex';
      audioTrackSelect.onchange = (event) => onChange(Number(event.target.value));
    }

    function renderQualityLevels(levels, onChange) {
      if (!levels || levels.length === 0) {
        qualityTrackWrap.style.display = 'none';
        qualityTrackSelect.innerHTML = '';
        return;
      }

      const uniqueHeights = Array.from(new Set(levels.map((level) => Number(level.height || 0)).filter(Boolean))).sort((a, b) => b - a);

      qualityTrackSelect.innerHTML = '';

      const autoOption = document.createElement('option');
      autoOption.value = '-1';
      autoOption.textContent = 'Auto';
      autoOption.selected = true;
      qualityTrackSelect.appendChild(autoOption);

      uniqueHeights.forEach((height) => {
        const option = document.createElement('option');
        option.value = String(height);
        option.textContent = height + 'p';
        qualityTrackSelect.appendChild(option);
      });

      qualityTrackWrap.style.display = 'inline-flex';
      qualityTrackSelect.onchange = (event) => onChange(Number(event.target.value));
    }

    function loadWithNativeHls(videoEl, url) {
      videoEl.src = url;
      videoEl.addEventListener('loadedmetadata', () => {
        const nativeTracks = videoEl.audioTracks ? Array.from(videoEl.audioTracks) : [];
        renderAudioTracks(nativeTracks, (selected) => {
          nativeTracks.forEach((track, idx) => { track.enabled = idx === selected; });
        });
      }, { once: true });
    }

    function loadSource(url, resumeAt = 0) {
      console.log('[Player] Loading source:', { url, resumeAt, type: url?.endsWith('.m3u8') ? 'HLS' : url?.endsWith('.mp4') ? 'MP4' : 'unknown' });
      
      const videoEl = document.getElementById('player');
      const normalizedUrl = String(url || '').split('?')[0].toLowerCase();
      const isMp4 = normalizedUrl.endsWith('.mp4');
      const isHlsManifest = normalizedUrl.endsWith('.m3u8');

      if (hls) {
        try { hls.destroy(); } catch (e) {}
        hls = null;
      }

      qualityTrackWrap.style.display = 'none';
      qualityTrackSelect.innerHTML = '';

      const isNativeHls = videoEl.canPlayType('application/vnd.apple.mpegurl') || videoEl.canPlayType('application/x-mpegURL');

      // Estratégia: conteúdo não-HLS toca direto (MP4-first).
      // Hls.js só entra para manifest .m3u8 explícito.
      if (isMp4 || !isHlsManifest) {
        console.log('[Player] Loading as non-HLS (MP4 or direct stream)');
        videoEl.src = url;
        videoEl.load();
        videoEl.addEventListener('loadedmetadata', () => {
          if (resumeAt > 0) videoEl.currentTime = resumeAt;
          videoEl.play().catch(() => {});
        }, { once: true });
        return;
      }

      if (window.Hls && Hls.isSupported()) {
        console.log('[Player] Hls.js is supported, loading manifest');
        const hlsConfig = isLiveTvContent ? {
          enableWorker: true,
          lowLatencyMode: false,
          backBufferLength: 120,
          liveSyncDuration: LIVE_DELAY_SECONDS,
          liveMaxLatencyDuration: LIVE_DELAY_SECONDS * 2,
          liveDurationInfinity: true,
          xhrSetup: (xhr, url) => {
            xhr.withCredentials = false;
          }
        } : {
          enableWorker: true,
          lowLatencyMode: false,
          backBufferLength: 180,
          maxBufferLength: 120,
          maxMaxBufferLength: 240,
          maxBufferHole: 0.5,
          startFragPrefetch: true,
          fragLoadingTimeOut: 20000,
          fragLoadingMaxRetry: 4,
          manifestLoadingMaxRetry: 4,
          xhrSetup: (xhr, url) => {
            xhr.withCredentials = false;
          }
        };

        hls = new Hls(hlsConfig);

        hls.loadSource(url);
        hls.attachMedia(videoEl);
        videoEl.crossOrigin = 'anonymous';

        hls.on(Hls.Events.MANIFEST_PARSED, () => {
          console.log('[HLS] Manifest parsed successfully', { url, levels: hls.levels?.length });
          clearStreamStatus();

          const tracks = (hls.audioTracks || []).map((track, index) => ({
            name: track.name || track.lang || 'Faixa ' + (index + 1),
            default: index === hls.audioTrack
          }));

          renderAudioTracks(tracks, (selected) => {
            hls.audioTrack = selected;
          });

          renderQualityLevels(hls.levels || [], (selectedHeight) => {
            if (selectedHeight === -1) {
              hls.currentLevel = -1;
              return;
            }

            const targetLevelIndex = (hls.levels || []).findIndex((level) => Number(level.height || 0) === selectedHeight);
            if (targetLevelIndex >= 0) {
              hls.currentLevel = targetLevelIndex;
            }
          });

          if (resumeAt > 0) {
            videoEl.currentTime = resumeAt;
          }

          if (isLiveTvContent && LIVE_DELAY_SECONDS > 0) {
            setStreamStatus('<strong>Modo estabilidade ativo:</strong> buffer de ' + LIVE_DELAY_SECONDS + 's ligado para reduzir travadas.');
          }

          videoEl.play().catch(() => {});
        });

        hls.on(Hls.Events.ERROR, (_, data) => {
          console.error('[HLS] Error:', data);
          if (!data || !data.fatal) {
            console.warn('[HLS] Non-fatal error:', data);
            return;
          }

          if (retryCount >= LIVE_DELAY_WARNING_THRESHOLD) {
            setStreamStatus(
              '<strong>O canal pode estar instável agora.</strong> Estamos segurando o buffer para você. Se demorar, tenha um pouco de paciência.',
              'warn'
            );
          }

          if (isVodContent && data.type === Hls.ErrorTypes.NETWORK_ERROR) {
            setStreamStatus(
              '<strong>Carregando o trecho selecionado...</strong> Estamos tentando continuar sem reiniciar o vídeo.',
              'warn'
            );
            try {
              hls.startLoad(Math.max(0, Number(videoEl.currentTime || 0) - 0.5));
            } catch (e) {
              retryStream();
            }
            return;
          }

          if (data.type === Hls.ErrorTypes.NETWORK_ERROR) {
            console.warn('[HLS] Network error, retrying...', data);
            retryStream();
            return;
          }

          if (data.type === Hls.ErrorTypes.MEDIA_ERROR) {
            console.warn('[HLS] Media error, recovering...', data);
            try { hls.recoverMediaError(); } catch (e) { retryStream(); }
            return;
          }

          console.error('[HLS] Fatal error, retrying stream...', data);
          retryStream();
        });
      } else if (isNativeHls) {
        loadWithNativeHls(videoEl, url);
      } else {
        videoEl.src = url;
      }
    }

    function formatTime(totalSeconds = 0) {
      const total = Math.max(0, Math.floor(totalSeconds || 0));
      const h = Math.floor(total / 3600);
      const m = Math.floor((total % 3600) / 60);
      const s = total % 60;
      const mm = String(m).padStart(2, '0');
      const ss = String(s).padStart(2, '0');
      if (h > 0) return String(h).padStart(2, '0') + ':' + mm + ':' + ss;
      return mm + ':' + ss;
    }

    function saveProgress(ended = false) {
      const videoEl = document.getElementById('player');
      const position = Math.floor(videoEl.currentTime || 0);
      const duration = Math.floor(videoEl.duration || 0);
      if (!ended && position < 5) return;
      if (!ended && Math.abs(position - lastProgressSecond) < 10) return;
      lastProgressSecond = position;

      const payload = JSON.stringify({ token: progressToken, position, duration, ended });
      if (navigator.sendBeacon) {
        try {
          const blob = new Blob([payload], { type: 'application/json' });
          navigator.sendBeacon('/api/progress', blob);
          return;
        } catch (e) {}
      }

      fetch('/api/progress', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: payload,
        keepalive: true
      }).catch(() => {});
    }

    function setupEpisodeActions() {
      const hasPrev = !!(prevEpisode && prevEpisode.token);
      const hasNext = !!(nextEpisode && nextEpisode.token);
      if (!episodeActions || (!hasPrev && !hasNext)) return;
      episodeActions.style.display = 'flex';
      if (hasPrev) {
        prevEpisodeBtn.addEventListener('click', () => {
          window.location.href = '/player/' + prevEpisode.token;
        });
      } else {
        prevEpisodeBtn.style.display = 'none';
      }
      if (hasNext) {
        nextEpisodeBtnInline.addEventListener('click', () => {
          if (nextEpisodeTimer) clearTimeout(nextEpisodeTimer);
          window.location.href = '/player/' + nextEpisode.token;
        });
      } else {
        nextEpisodeBtnInline.style.display = 'none';
      }
    }

    function applyResumeSeconds(value) {
      if (!Number.isFinite(value) || value < 10) return;
      resumeSeconds = value;
      const timeLabel = formatTime(resumeSeconds);
      resumeTime.textContent = timeLabel;
      confirmResumeTime.textContent = timeLabel;
      resumePrompt.style.display = 'flex';
    }

    function setupResumePrompt() {
      if (!resumePrompt) return;
      resumeBtn.addEventListener('click', () => {
        confirmOverlay.style.display = 'flex';
        confirmOverlay.setAttribute('aria-hidden', 'false');
      });
      cancelResumeBtn.addEventListener('click', () => {
        confirmOverlay.style.display = 'none';
        confirmOverlay.setAttribute('aria-hidden', 'true');
      });
      confirmResumeBtn.addEventListener('click', () => {
        confirmOverlay.style.display = 'none';
        confirmOverlay.setAttribute('aria-hidden', 'true');
        const videoEl = document.getElementById('player');
        videoEl.currentTime = resumeSeconds;
        videoEl.play().catch(() => {});
        resumePrompt.style.display = 'none';
      });

      applyResumeSeconds(resumeSeconds);

      fetch('/api/progress/' + progressToken)
        .then((r) => r.json())
        .then((d) => {
          if (d && Number.isFinite(d.resumeSeconds)) {
            applyResumeSeconds(d.resumeSeconds);
          }
        })
        .catch(() => {});
    }

    function retryStream() {
      if (isVodContent) {
        const videoEl = document.getElementById('player');
        if (videoEl && videoEl.seeking && hls) {
          setStreamStatus(
            '<strong>Carregando o ponto escolhido...</strong> Aguarde enquanto buscamos esse trecho.',
            'warn'
          );
          try {
            hls.startLoad(Math.max(0, Number(videoEl.currentTime || 0) - 0.5));
          } catch (e) {}
          return;
        }
      }

      if (retryCount >= 3) {
        setStreamStatus(
          '<strong>O canal parece instável no momento.</strong> Vamos tentar reconectar algumas vezes; se persistir, aguarde um pouco antes de tentar novamente.',
          'error'
        );
        document.querySelector('.video-wrapper').innerHTML = '<div style="padding: 50px; text-align: center; color: #ef4444; background: #000; height: 100%; display: flex; align-items: center; justify-content: center; flex-direction: column;"><h3><i class="fa-solid fa-satellite-dish" style="font-size:40px; margin-bottom:15px;"></i><br>Falha no Sinal</h3><p style="color:#94a3b8; margin-top:10px;">A conexão com o servidor foi interrompida. Tente recarregar a página.</p></div>';
        return;
      }

      retryCount++;
      setStreamStatus(
        '<strong>O canal pode estar instável agora.</strong> Tentando recuperar a transmissão com buffer de ' + LIVE_DELAY_SECONDS + 's.',
        'warn'
      );
      const videoEl = document.getElementById('player');
      const currentTime = videoEl.currentTime || 0;

      fetch('/api/refresh-stream/${req.params.token}/${purchase.sessionToken}')
        .then(r => r.json())
        .then(d => {
          if (!d || !d.url) return;
          loadSource(d.url, currentTime);
        })
        .catch(() => {});
    }

    function initializePlayer() {
      const videoEl = document.getElementById('player');
      videoEl.addEventListener('contextmenu', e => { e.preventDefault(); return false; });

      player = new Plyr(videoEl, {
        controls: [
          'play-large',
          'play',
          'progress',
          'current-time',
          'mute',
          'volume',
          'settings',
          'fullscreen'
        ],
        settings: ['speed'],
        speed: {
          selected: 1,
          options: [0.5, 0.75, 1, 1.25, 1.5, 2]
        }
      });

      videoEl.addEventListener('play', logPlayOnce);
      videoEl.addEventListener('error', retryStream);
      videoEl.addEventListener('seeking', () => {
        if (!isVodContent) return;
        vodUserSeeking = true;
        setStreamStatus('<strong>Carregando trecho escolhido...</strong> Aguarde um instante.', 'warn');
      });
      videoEl.addEventListener('seeked', () => {
        vodUserSeeking = false;
      });
      videoEl.addEventListener('pause', () => saveProgress(false));
      videoEl.addEventListener('ended', () => {
        saveProgress(true);
        if (nextEpisode && nextEpisode.token) {
          nextEpisodeHint.textContent = 'Iniciando próximo episódio em 5s...';
          nextEpisodeTimer = setTimeout(() => {
            window.location.href = '/player/' + nextEpisode.token;
          }, 5000);
        }
      });
      videoEl.addEventListener('timeupdate', () => {
        const now = Date.now();
        if (now - lastProgressSaveAt < 10000) return;
        lastProgressSaveAt = now;
        saveProgress(false);
      });
      document.addEventListener('visibilitychange', () => {
        if (document.hidden) saveProgress(false);
      });
      window.addEventListener('beforeunload', () => saveProgress(false));

      setupEpisodeActions();
      setupResumePrompt();

      if (isLiveTvContent) {
        // LiveTV: auto-iniciar carregamento com mensagem amigável
        setStreamStatus(
          '<strong>🔄 Carregando canal ao vivo...</strong><br><small>Por favor aguarde enquanto preparamos a melhor qualidade para você.</small>',
          'warn'
        );
        // Disparar verificação de buffer imediatamente
        setTimeout(() => {
          checkLiveTvBufferStatus();
        }, 100);
        return;
      }

      setStreamStatus(
        '<strong>Buffer de estabilidade ativo:</strong> a transmissão pode ficar alguns segundos atrás do vivo para evitar travadas.',
        'warn'
      );
      loadSource(streamPath, 0);
    }

    document.addEventListener('DOMContentLoaded', function() {
      initializePlayer();
    });
  </script>
</body>
</html>
    `);
  } catch (error) {
    console.error('Erro no player:', error.message);
    
    // TELA DE ERRO (ACESSO NEGADO) TEMA ESPACIAL (COM ASTRONAUTA NA ABA TAMBÉM)
    res.status(403).send(`
<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8"><title>Acesso Negado - ViewFlix Space</title>
  <link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90' fill='%234facfe'>👨‍🚀</text></svg>">
  <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css">
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body{
      background: linear-gradient(135deg, #050505 0%, #0b0c1b 50%, #1a1025 100%);
      color:#e2e8f0; display:flex; justify-content:center; align-items:center; 
      height:100vh; font-family:'Segoe UI', Arial, sans-serif; text-align:center;
    }
    body::before {
      content: ''; position: absolute; top: 0; left: 0; width: 100%; height: 100%;
      background-image: radial-gradient(#ffffff 1px, transparent 1px), radial-gradient(#ffffff 1px, transparent 1px);
      background-size: 50px 50px; background-position: 0 0, 25px 25px;
      opacity: 0.04; pointer-events: none; z-index: 0;
    }
    .error-box { 
      background: rgba(11, 12, 27, 0.7); backdrop-filter: blur(20px); 
      padding: 50px; border-radius: 20px; border: 1px solid rgba(79, 172, 254, 0.2); 
      box-shadow: 0 20px 50px rgba(0,0,0,0.8), 0 0 30px rgba(79, 172, 254, 0.1);
      position: relative; z-index: 1; max-width: 500px; width: 90%;
    }
    h1{ color: #4facfe; margin-bottom: 20px; font-size: 32px; font-weight: 800; text-shadow: 0 0 15px rgba(79, 172, 254, 0.4); }
    h1 i { font-size: 40px; margin-bottom: 15px; display: block; }
    p { color: #94a3b8; font-size: 16px; line-height: 1.6; margin-bottom: 25px; }
  </style>
</head>
<body>
  <div class="error-box">
    <h1><i class="fa-solid fa-user-astronaut"></i>Acesso Negado</h1>
    <p>A sua nave saiu de órbita.<br>Este link de transmissão é inválido, expirou ou o seu nível de acesso foi revogado pela base.</p>
  </div>
</body>
</html>`);
  }
});

// ===== LOG PLAY =====
router.post('/api/log-view', async (req, res) => {
  try {
    const { userId, videoId } = req.body;
    res.sendStatus(200);
  } catch {
    res.sendStatus(500);
  }
});

module.exports = router;