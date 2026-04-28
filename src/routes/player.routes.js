const express = require('express');
const jwt = require('jsonwebtoken');
const { HttpProxyAgent } = require('http-proxy-agent');

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

    @media (max-width: 768px) { .player-shell { height: 50vh; } }
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
    </div>
    <div class="warning">
      <i class="fas fa-user-shield"></i>
      Missão Pessoal e Intransferível • Conexão Criptografada HMAC • ID do Cadete: ${userId}
    </div>
    <div class="stream-status" id="streamStatus" role="status" aria-live="polite"></div>
  </div>
  <script src="https://cdn.jsdelivr.net/npm/hls.js@1.5.15/dist/hls.min.js"></script>
  <script src="https://cdn.plyr.io/3.7.8/plyr.polyfilled.js"></script>
  <script>
    const expirationTime = ${expirationTimestamp};
    const countdownEl = document.getElementById('countdown');
    const streamPath = '${streamPath}';
    const streamStatusEl = document.getElementById('streamStatus');

    const LIVE_DELAY_SECONDS = 30;
    const LIVE_DELAY_WARNING_THRESHOLD = 1;

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
    const audioTrackWrap = document.getElementById('audioTrackWrap');
    const audioTrackSelect = document.getElementById('audioTrackSelect');
    const qualityTrackWrap = document.getElementById('qualityTrackWrap');
    const qualityTrackSelect = document.getElementById('qualityTrackSelect');

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
        videoEl.src = url;
        videoEl.load();
        videoEl.addEventListener('loadedmetadata', () => {
          if (resumeAt > 0) videoEl.currentTime = resumeAt;
          videoEl.play().catch(() => {});
        }, { once: true });
        return;
      }

      if (window.Hls && Hls.isSupported()) {
        hls = new Hls({
          enableWorker: true,
          lowLatencyMode: false,
          backBufferLength: 120,
          liveSyncDuration: LIVE_DELAY_SECONDS,
          liveMaxLatencyDuration: LIVE_DELAY_SECONDS * 2,
          liveDurationInfinity: true
        });

        hls.loadSource(url);
        hls.attachMedia(videoEl);

        hls.on(Hls.Events.MANIFEST_PARSED, () => {
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

          if (LIVE_DELAY_SECONDS > 0) {
            setStreamStatus('<strong>Modo estabilidade ativo:</strong> buffer de ' + LIVE_DELAY_SECONDS + 's ligado para reduzir travadas.');
          }

          videoEl.play().catch(() => {});
        });

        hls.on(Hls.Events.ERROR, (_, data) => {
          if (!data || !data.fatal) return;

          if (retryCount >= LIVE_DELAY_WARNING_THRESHOLD) {
            setStreamStatus(
              '<strong>O canal pode estar instável agora.</strong> Estamos segurando o buffer para você. Se demorar, tenha um pouco de paciência.',
              'warn'
            );
          }

          if (data.type === Hls.ErrorTypes.NETWORK_ERROR) {
            retryStream();
            return;
          }

          if (data.type === Hls.ErrorTypes.MEDIA_ERROR) {
            try { hls.recoverMediaError(); } catch (e) { retryStream(); }
            return;
          }

          retryStream();
        });
      } else if (isNativeHls) {
        loadWithNativeHls(videoEl, url);
      } else {
        videoEl.src = url;
      }
    }

    function retryStream() {
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
    console.log(`📊 Play: User ${userId} | Vídeo ${videoId}`);
    res.sendStatus(200);
  } catch {
    res.sendStatus(500);
  }
});

module.exports = router;