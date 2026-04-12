const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const rateLimit = require('express-rate-limit');

const env = require('./config/env');
const requestContext = require('./middlewares/request-context');
const { notFoundHandler, errorHandler } = require('./middlewares/error-handler');
const routes = require('./routes');

const app = express();

app.set('trust proxy', 1);

// Helmet apenas para rotas do browser (player, catalog, etc)
// O relay não precisa de CSP
app.use(helmet({
  contentSecurityPolicy: false // CSP quebra o player de video
}));

// CORS: permite o domínio público E o worker do Cloudflare
// O relay-stream não precisa de CORS (é chamado server-to-server pelo worker)
// mas o player e APIs do browser precisam
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

app.use(routes);
app.use(notFoundHandler);
app.use(errorHandler);

module.exports = app;