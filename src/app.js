const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const rateLimit = require('express-rate-limit');

const env = require('./config/env');
const requestContext = require('./middlewares/request-context');
const routes = require('./routes');
const path = require('path');
const { ChannelOverride } = require('./models');

const app = express();

// Register models in app.locals for access in routes
app.locals.models = { ChannelOverride };

app.set('trust proxy', 1);

// Helmet apenas para rotas do browser (player, catalog, etc)
// O relay não precisa de CSP
app.use(helmet({
  contentSecurityPolicy: false // CSP quebra o player de video
}));

// CORS: permite o domínio público E o worker do Cloudflare
const allowedOrigins = [
  env.DOMINIO_PUBLICO,
  'https://fasttv-worker.julinhopentakill.workers.dev',
  'https://api.viewflix.space',
  'https://watch.viewflix.space'
].filter(Boolean);

app.use(cors({
  origin: function (origin, callback) {
    // Permite requisições sem origin (server-to-server, curl, etc)
    if (!origin) return callback(null, true);
    if (allowedOrigins.includes(origin)) return callback(null, true);
    // Bloqueia origens desconhecidas
    return callback(new Error('CORS não permitido'), false);
  }
}));

app.use(express.json({ limit: '1mb' }));
app.use(requestContext);

// Rate limit geral — relay tem volume alto, aumentar um pouco
app.use(rateLimit({
  windowMs: 60 * 1000,
  max: 600,
  standardHeaders: true,
  legacyHeaders: false,
  // Não aplica rate limit no relay-stream (é chamado pelo worker, não pelo usuário)
  skip: (req) => req.path === '/relay-stream'
}));

// Serve arquivos estáticos da pasta `public/`
// (ex: /admin.html, assets, index, etc)
app.use(express.static(path.join(__dirname, '..', 'public')));

// Rota amigável sem extensão para o painel admin
app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'admin.html'));
});

// ==========================================
// 1. ROTAS PRINCIPAIS (PLAYER, API, ETC)
// Isto tem que vir ANTES das telas de erro!
// ==========================================
app.use(routes);

// ==========================================
// 2. PÁGINA 404 PERSONALIZADA (PERDIDO NO ESPAÇO)
// Se não achou em "routes" acima, cai aqui.
// ==========================================
app.use((req, res, next) => {
  res.status(404).send(`
<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8"><title>Perdido no Espaço - ViewFlix Space</title>
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
    .btn {
      display: inline-block; background: transparent; border: 2px solid #4facfe;
      color: #4facfe; text-decoration: none; padding: 10px 25px; border-radius: 8px;
      font-weight: bold; transition: all 0.3s;
    }
    .btn:hover { background: #4facfe; color: #fff; box-shadow: 0 0 15px rgba(79, 172, 254, 0.6); }
  </style>
</head>
<body>
  <div class="error-box">
    <h1><i class="fa-solid fa-satellite"></i>Erro 404</h1>
    <p><strong>Perdido no Espaço Cósmico!</strong><br>As coordenadas que você inseriu levam a um buraco negro. Esta página não existe na nossa galáxia.</p>
    <a href="https://t.me/ViewFlixBOT" class="btn"><i class="fa-solid fa-rocket"></i> Voltar à Base</a>
  </div>
</body>
</html>`);
});

// ==========================================
// 3. PÁGINA 500 PERSONALIZADA (FALHA NO MOTOR DE DOBRA)
// Se o código de alguma rota der "crash", cai aqui.
// ==========================================
app.use((err, req, res, next) => {
  console.error('Erro de Servidor detectado:', err.message);
  
  res.status(500).send(`
<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8"><title>Falha no Sistema - ViewFlix Space</title>
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
      padding: 50px; border-radius: 20px; border: 1px solid rgba(239, 68, 68, 0.3); 
      box-shadow: 0 20px 50px rgba(0,0,0,0.8), 0 0 30px rgba(239, 68, 68, 0.15);
      position: relative; z-index: 1; max-width: 500px; width: 90%;
    }
    h1{ color: #ef4444; margin-bottom: 20px; font-size: 32px; font-weight: 800; text-shadow: 0 0 15px rgba(239, 68, 68, 0.4); }
    h1 i { font-size: 40px; margin-bottom: 15px; display: block; }
    p { color: #94a3b8; font-size: 16px; line-height: 1.6; margin-bottom: 25px; }
  </style>
</head>
<body>
  <div class="error-box">
    <h1><i class="fa-solid fa-triangle-exclamation"></i>Erro 500</h1>
    <p><strong>Falha no Motor de Dobra!</strong><br>A nossa nave-mãe sofreu uma instabilidade de energia. Os nossos engenheiros já foram notificados para reparar os sistemas.</p>
  </div>
</body>
</html>`);
});

module.exports = app;