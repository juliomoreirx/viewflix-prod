const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const RedisStore = require('rate-limit-redis').default;
const compression = require('compression');

const env = require('./config/env');
const redisClient = require('./lib/redis');
const requestContext = require('./middlewares/request-context');
const routes = require('./routes');
const path = require('path');
const { ChannelOverride } = require('./models');

const app = express();

// Register models in app.locals for access in routes
app.locals.models = { ChannelOverride };

app.set('trust proxy', 1);

app.use(compression());

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
    // Same-origin requests (where the browser omits the Origin header) should be allowed.
    // In standard Express setups, same-origin requests to API endpoints from the frontend
    // might omit the Origin header. Thus, allowing origin = undefined is necessary for
    // internal API calls to work properly, including frontend browser integrations.
    if (!origin) return callback(null, true);

    if (allowedOrigins.includes(origin)) return callback(null, true);

    // Bloqueia origens desconhecidas
    return callback(new Error('CORS não permitido'), false);
  }
}));

app.use(express.json({ limit: '1mb' }));
app.use(requestContext);

// Rate limit geral — relay tem volume alto, aumentar um pouco
const rateLimitConfig = {
  windowMs: 60 * 1000,
  max: 600,
  standardHeaders: true,
  legacyHeaders: false,
  // Não aplica rate limit no relay-stream (é chamado pelo worker, não pelo usuário)
  skip: (req) => req.path === '/relay-stream'
};

if (redisClient) {
  rateLimitConfig.store = new RedisStore({
    sendCommand: (...args) => redisClient.call(...args),
  });
}

app.use(rateLimit(rateLimitConfig));

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
  res.status(404).sendFile(path.join(__dirname, '..', 'public', '404.html'));
});

// ==========================================
// 3. PÁGINA 500 PERSONALIZADA (FALHA NO MOTOR DE DOBRA)
// Se o código de alguma rota der "crash", cai aqui.
// ==========================================
app.use((err, req, res, next) => {
  console.error('Erro de Servidor detectado:', err.message);
  
  res.status(500).sendFile(path.join(__dirname, '..', 'public', '500.html'));
});

module.exports = app;