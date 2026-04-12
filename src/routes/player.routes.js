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
  <link href="https://vjs.zencdn.net/8.10.0/video-js.css" rel="stylesheet">
  <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css">
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      /* Fundo espacial elegante (gradiente escuro) */
      background: linear-gradient(135deg, #050505 0%, #0b0c1b 50%, #1a1025 100%);
      display: flex; flex-direction: column; justify-content: center; align-items: center;
      min-height: 100vh; font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; color: #e2e8f0; user-select: none;
    }
    
    /* Efeito de estrelas sutil no background */
    body::before {
      content: ''; position: absolute; top: 0; left: 0; width: 100%; height: 100%;
      background-image: radial-gradient(#ffffff 1px, transparent 1px), radial-gradient(#ffffff 1px, transparent 1px);
      background-size: 50px 50px; background-position: 0 0, 25px 25px;
      opacity: 0.04; pointer-events: none; z-index: 0;
    }

    .container { width: 100%; max-width: 1400px; padding: 20px; position: relative; z-index: 1; }
    
    /* Logo ViewFlix Space */
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
    .video-js { width: 100%; height: 80vh; font-family: 'Segoe UI', Arial, sans-serif; }
    
    /* Customização do Video.js para o tema Espacial */
    .vjs-theme-viewflix .vjs-control-bar { background: linear-gradient(to top, rgba(5,5,5,0.95) 0%, rgba(11,12,27,0.8) 50%, transparent 100%); height: 4.5em; }
    
    .vjs-theme-viewflix .vjs-big-play-button { 
      background: rgba(11, 12, 27, 0.6); border: 2px solid #4facfe; border-radius: 50%; 
      width: 2.5em; height: 2.5em; line-height: 2.3em; font-size: 3.5em; left: 50%; top: 50%; 
      transform: translate(-50%,-50%); transition: all 0.4s ease; backdrop-filter: blur(8px);
      color: #4facfe; box-shadow: 0 0 25px rgba(79, 172, 254, 0.4);
    }
    .vjs-theme-viewflix .vjs-big-play-button:hover { 
      background: #4facfe; color: #fff; transform: translate(-50%,-50%) scale(1.1); 
      box-shadow: 0 0 40px rgba(79, 172, 254, 0.8); border-color: #fff;
    }
    .vjs-theme-viewflix .vjs-play-progress, .vjs-theme-viewflix .vjs-volume-level { 
      background: linear-gradient(90deg, #00f2fe 0%, #4facfe 100%); 
      box-shadow: 0 0 15px rgba(79, 172, 254, 0.8);
    }
    .vjs-slider { background-color: rgba(255,255,255,0.15); }

    /* Barra de Informações */
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
    
    @media (max-width: 768px) { .video-js { height: 50vh; } }
  </style>
</head>
<body>
  <div class="container">
    <div class="logo"><i class="fa-solid fa-user-astronaut"></i>VIEWFLIX <span>SPACE</span></div>
    <div class="video-wrapper">
      <video id="player" class="video-js vjs-theme-viewflix vjs-big-play-centered" controls preload="auto"
        data-setup='{"fluid":true,"aspectRatio":"16:9","playbackRates":[0.5,0.75,1,1.25,1.5,2]}'>
        <source src="${streamPath}" type="video/mp4">
      </video>
    </div>
    <div class="info-bar">
      <div class="title">${purchase.title}</div>
      ${purchase.episodeName ? `<div class="meta"><span><i class="fas fa-satellite-dish"></i> ${purchase.episodeName}</span></div>` : ''}
      <div class="meta">
        <span><i class="fas fa-calendar-alt"></i> Comprado em ${new Date(purchase.purchaseDate).toLocaleDateString('pt-BR')}</span>
        <span><i class="fas fa-hourglass-half"></i> Expira em: <span class="timer" id="countdown">Calculando...</span></span>
        <span><i class="fas fa-eye"></i> ${purchase.viewCount} visualizaç${purchase.viewCount === 1 ? 'ão' : 'ões'}</span>
      </div>
    </div>
    <div class="warning">
      <i class="fas fa-user-shield"></i>
      Missão Pessoal e Intransferível • Conexão Criptografada HMAC • ID do Cadete: ${userId}
    </div>
  </div>
  <script src="https://vjs.zencdn.net/8.10.0/video.min.js"></script>
  <script>
    // Configuração do Cronômetro (Já atualizado com os dias!)
    const expirationTime = ${expirationTimestamp};
    const countdownEl = document.getElementById('countdown');

    function updateCountdown() {
      const now = Date.now();
      const diff = expirationTime - now;

      if (diff <= 0) {
        countdownEl.innerText = 'SINAL PERDIDO';
        countdownEl.style.color = '#ef4444';
        countdownEl.style.borderColor = 'rgba(239, 68, 68, 0.3)';
        countdownEl.style.background = 'rgba(239, 68, 68, 0.1)';
        
        if (typeof player !== 'undefined' && player) { 
          player.pause(); 
          player.dispose(); 
          document.querySelector('.video-wrapper').innerHTML = '<div style="padding: 50px; text-align: center; color: #4facfe; background: #000; height: 100%; display: flex; align-items: center; justify-content: center; flex-direction: column;"><h3><i class="fa-solid fa-meteor" style="font-size:40px; margin-bottom:15px;"></i><br>Transmissão Expirada</h3><p style="color:#94a3b8; margin-top:10px;">O seu tempo de acesso a este conteúdo chegou ao fim.</p></div>';
        }
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

    // Configuração do Player
    let player;
    let retryCount = 0;

    document.addEventListener('DOMContentLoaded', function() {
      player = videojs('player');
      player.el().addEventListener('contextmenu', e => { e.preventDefault(); return false; });

      player.ready(function() { player.load(); });

      let playLogged = false;
      player.on('play', function() {
        if (!playLogged) {
          fetch('/api/log-view', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ userId: ${userId}, videoId: '${videoId}', token: '${req.params.token}', timestamp: Date.now() })
          });
          playLogged = true;
        }
      });

      player.on('error', function() {
        const err = player.error();
        if (err && (err.code === 2 || err.code === 4)) {
          if (retryCount >= 3) {
             document.querySelector('.video-wrapper').innerHTML = '<div style="padding: 50px; text-align: center; color: #ef4444; background: #000; height: 100%; display: flex; align-items: center; justify-content: center; flex-direction: column;"><h3><i class="fa-solid fa-satellite-dish" style="font-size:40px; margin-bottom:15px;"></i><br>Falha no Sinal</h3><p style="color:#94a3b8; margin-top:10px;">A conexão com o servidor foi interrompida. Tente recarregar a página.</p></div>';
             return;
          }
          
          retryCount++;
          const currentTime = player.currentTime(); 
          
          fetch('/api/refresh-stream/${req.params.token}/${purchase.sessionToken}')
            .then(r => r.json())
            .then(d => { 
              if (d.url) { 
                player.src({ src: d.url, type: 'video/mp4' }); 
                player.play(); 
                if (currentTime > 0) player.currentTime(currentTime); 
              } 
            })
            .catch(() => {});
        }
      });
    });
  </script>
</body>
</html>
    `);
  } catch (error) {
    console.error('Erro no player:', error.message);
    
    // ==========================================
    // TELA DE ERRO (ACESSO NEGADO) TEMA ESPACIAL
    // ==========================================
    res.status(403).send(`
<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8"><title>Acesso Negado - ViewFlix Space</title>
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
    p { color: #94a3b8; font-size: 16px; line-height: 1.6; }
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