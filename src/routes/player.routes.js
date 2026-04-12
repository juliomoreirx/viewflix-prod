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
// Renderiza o HTML do player. As rotas /api/stream-secure e /api/refresh-stream
// são gerenciadas exclusivamente pelo secure-stream.routes.js (mais robusto).
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
    const msRestantes = Math.max(0, purchase.expiresAt.getTime() - Date.now());

    res.send(`
<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${purchase.title} - FastTV</title>
  <link href="https://vjs.zencdn.net/8.10.0/video-js.css" rel="stylesheet">
  <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css">
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      background: linear-gradient(135deg, #0a0a0a 0%, #1a1a1a 100%);
      display: flex; flex-direction: column; justify-content: center; align-items: center;
      min-height: 100vh; font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; color: #fff; user-select: none;
    }
    .container { width: 100%; max-width: 1400px; padding: 20px; position: relative; }
    .logo { color: #E50914; font-size: 36px; font-weight: bold; text-align: center; margin-bottom: 30px; text-shadow: 0 0 20px rgba(229,9,20,0.5); }
    .video-wrapper { position: relative; width: 100%; background: #000; border-radius: 12px; overflow: hidden; box-shadow: 0 20px 60px rgba(0,0,0,0.8); }
    .video-js { width: 100%; height: 80vh; font-family: 'Segoe UI', Arial, sans-serif; }
    .vjs-theme-fasttv .vjs-control-bar { background: linear-gradient(to top, rgba(0,0,0,0.9) 0%, rgba(0,0,0,0.7) 50%, transparent 100%); height: 4em; }
    .vjs-theme-fasttv .vjs-big-play-button { background: rgba(229,9,20,0.9); border: none; border-radius: 50%; width: 2em; height: 2em; line-height: 2em; font-size: 3em; left: 50%; top: 50%; transform: translate(-50%,-50%); transition: all 0.3s; }
    .vjs-theme-fasttv .vjs-big-play-button:hover { background: rgba(229,9,20,1); transform: translate(-50%,-50%) scale(1.1); }
    .vjs-theme-fasttv .vjs-play-progress, .vjs-theme-fasttv .vjs-volume-level { background-color: #E50914; }
    .info-bar { background: rgba(20,20,20,0.95); backdrop-filter: blur(10px); padding: 20px; border-radius: 12px; margin-top: 20px; border: 1px solid rgba(255,255,255,0.1); }
    .title { font-size: 24px; font-weight: bold; margin-bottom: 10px; color: #fff; }
    .meta { display: flex; gap: 20px; flex-wrap: wrap; font-size: 14px; color: #aaa; margin-bottom: 15px; }
    .meta span { display: flex; align-items: center; gap: 8px; }
    .warning { text-align: center; margin-top: 20px; padding: 15px; background: rgba(229,9,20,0.1); border-radius: 8px; font-size: 14px; border: 1px solid rgba(229,9,20,0.3); }
    .timer { display: inline-block; background: rgba(229,9,20,0.2); padding: 5px 12px; border-radius: 20px; font-weight: bold; }
    @media (max-width: 768px) { .video-js { height: 50vh; } }
  </style>
</head>
<body>
  <div class="container">
    <div class="logo">FAST<span style="color:#fff">TV</span></div>
    <div class="video-wrapper">
      <video id="player" class="video-js vjs-theme-fasttv vjs-big-play-centered" controls preload="auto"
        data-setup='{"fluid":true,"aspectRatio":"16:9","playbackRates":[0.5,0.75,1,1.25,1.5,2]}'>
        <source src="${streamPath}" type="video/mp4">
      </video>
    </div>
    <div class="info-bar">
      <div class="title">${purchase.title}</div>
      ${purchase.episodeName ? `<div class="meta"><span><i class="fas fa-tv"></i> ${purchase.episodeName}</span></div>` : ''}
      <div class="meta">
        <span><i class="fas fa-calendar"></i> Comprado em ${new Date(purchase.purchaseDate).toLocaleDateString('pt-BR')}</span>
        <span><i class="fas fa-clock"></i> Expira em <span class="timer" id="countdown"></span></span>
        <span><i class="fas fa-eye"></i> ${purchase.viewCount} visualizaç${purchase.viewCount === 1 ? 'ão' : 'ões'}</span>
      </div>
    </div>
    <div class="warning">
      <i class="fas fa-shield-alt"></i>
      Este link é pessoal e intransferível • Protegido por assinatura HMAC • ID: ${userId}
    </div>
  </div>
  <script src="https://vjs.zencdn.net/8.10.0/video.min.js"></script>
  <script>
    let msRestantes = ${msRestantes};
    let player;

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

    let erroDeRedeCount = 0;

      player.on('error', function() {
        const err = player.error();
        console.error("Erro no player detectado:", err);
        
        // Code 2 = Erro de rede (Caiu a conexão)
        if (err && (err.code === 2 || err.code === 4)) {
          erroDeRedeCount++;
          
          // Se falhou 3 vezes seguidas, para o loop e avisa o usuário
          if (erroDeRedeCount > 3) {
             const wrapper = document.querySelector('.video-wrapper');
             wrapper.innerHTML = '<div style="padding: 50px; text-align: center; color: red; background: #000; height: 100%; display: flex; align-items: center; justify-content: center;"><h3>Falha na conexão com o servidor de vídeo.</h3><p>Tente recarregar a página.</p></div>';
             return;
          }

          // Tenta pegar um link novo e continuar
          fetch('/api/refresh-stream/${req.params.token}/${purchase.sessionToken}')
            .then(r => r.json())
            .then(d => { 
              if (d.url) { 
                const tempoAtual = player.currentTime(); // Salva onde parou
                player.src({ src: d.url, type: 'video/mp4' }); 
                player.play(); 
                player.currentTime(tempoAtual); // Tenta voltar para onde estava
              } 
            })
            .catch(e => console.error("Falha ao dar refresh no stream", e));
        }
      });

    function updateCountdown() {
      msRestantes -= 60000;
      if (msRestantes <= 0) {
        document.getElementById('countdown').innerText = 'EXPIRADO';
        if (player) { player.pause(); player.dispose(); }
        return;
      }
      const totalMin = Math.floor(msRestantes / 60000);
      const hours = Math.floor(totalMin / 60);
      const minutes = totalMin % 60;
      document.getElementById('countdown').innerText = hours + 'h ' + minutes + 'm';
    }

    (function() {
      const totalMin = Math.floor(msRestantes / 60000);
      const hours = Math.floor(totalMin / 60);
      const minutes = totalMin % 60;
      document.getElementById('countdown').innerText = hours + 'h ' + minutes + 'm';
    })();

    setInterval(updateCountdown, 60000);
  </script>
</body>
</html>
    `);
  } catch (error) {
    console.error('Erro no player:', error.message);
    res.status(403).send(`
<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8"><title>Acesso Negado - FastTV</title>
  <style>body{background:#0a0a0a;color:#fff;display:flex;justify-content:center;align-items:center;height:100vh;font-family:Arial,sans-serif;text-align:center}.error{max-width:600px;padding:40px}h1{color:#E50914;margin-bottom:20px}</style>
</head>
<body><div class="error"><h1>⚠️ Acesso Negado</h1><p>Link inválido, expirado ou usuário bloqueado.</p></div></body>
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