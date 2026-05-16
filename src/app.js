// src/app.js
const express = require('express');
const cors = require('cors');
const helmet = require('helmet'); // Segurança Sênior
const compression = require('compression');
const path = require('path');

// Importação do Logger
const logger = require('./lib/logger');

// Importação de Middlewares Base
const requestContext = require('./middlewares/request-context');
const { notFoundHandler, errorHandler } = require('./middlewares/error-handler');

// Importação das Rotas Principal
const routes = require('./routes');

// ==========================================
// INICIALIZAÇÃO DA APLICAÇÃO EXPRESS
// ==========================================
const app = express();

// ==========================================
// 1. MIDDLEWARES DE SEGURANÇA E PERFORMANCE
// ==========================================
app.use(helmet({
  contentSecurityPolicy: false, // Mantido desativado para compatibilidade com players inline
  crossOriginEmbedderPolicy: false
}));

app.use(cors()); // Permite requisições de origens cruzadas
app.use(compression()); // Compacta as respostas em GZIP para economizar banda

// ==========================================
// 2. PARSERS E CONTEXTO DE REQUEST
// ==========================================
app.use(express.json()); 
app.use(express.urlencoded({ extended: true })); 
app.use(requestContext); // Injeta o X-Request-ID para rastreio de logs

// Interceptor de Logs para monitoramento de tráfego
app.use((req, res, next) => {
  logger.info({
    msg: 'Incoming request',
    method: req.method,
    url: req.url,
    ip: req.ip,
    requestId: req.requestId
  });
  next();
});

// ==========================================
// 3. PROVEDORES DE ARQUIVOS ESTÁTICOS OBSCURECIDOS
// ==========================================

// Provedor 1: Pasta Pública Tradicional (public/)
const publicPath = path.join(__dirname, '..', 'public');
app.use(express.static(publicPath, {
  setHeaders: (res, filePath) => {
    if (filePath.match(/\.(jpg|jpeg|png|gif|svg)$/)) {
      res.setHeader('Cache-Control', 'public, max-age=604800');
    }
  }
}));

// 🚀 SOLUÇÃO DE SEGURANÇA: Mapeamento direto das subpastas de categorias.
// Oculta completamente a palavra "output" da face da terra!
const outputPath = path.join(__dirname, '..', 'output');

app.use('/filmes', express.static(path.join(outputPath, 'filmes'), {
  setHeaders: (res, filePath) => {
    if (filePath.match(/\.(jpg|jpeg|png|gif|svg)$/)) {
      res.setHeader('Cache-Control', 'public, max-age=604800');
    }
  }
}));

app.use('/series', express.static(path.join(outputPath, 'series'), {
  setHeaders: (res, filePath) => {
    if (filePath.match(/\.(jpg|jpeg|png|gif|svg)$/)) {
      res.setHeader('Cache-Control', 'public, max-age=604800');
    }
  }
}));

// ==========================================
// 4. REGISTO DAS ROTAS DA API
// ==========================================
app.use(routes);

// ==========================================
// 5. TRATAMENTO DE ERROS E FALLBACKS
// ==========================================
app.use(notFoundHandler);
app.use(errorHandler);

module.exports = app;