// src/routes/cookies.routes.js
// Rotas para gerenciar e monitorar cookies

const express = require('express');
const router = express.Router();
const asyncHandler = require('../middlewares/async-handler');
const cookieAuthMiddleware = require('../middlewares/cookie-auth');

// Aplicar autenticação em todas as rotas
router.use(cookieAuthMiddleware);

/**
 * GET /cookies/status
 * Retorna status dos cookies
 */
router.get('/status', asyncHandler(async (req, res) => {
  const cookieManager = req.app.locals.services?.cookieManager;
  
  if (!cookieManager) {
    return res.status(503).json({ error: 'Cookie Manager não inicializado' });
  }

  const status = cookieManager.getStatus();
  res.json({
    status,
    timestamp: new Date().toISOString()
  });
}));

/**
 * POST /cookies/validate
 * Valida os cookies atuais
 */
router.post('/validate', asyncHandler(async (req, res) => {
  const cookieManager = req.app.locals.services?.cookieManager;
  
  if (!cookieManager) {
    return res.status(503).json({ error: 'Cookie Manager não inicializado' });
  }

  const isValid = await cookieManager.validateCookies();
  
  res.json({
    valid: isValid,
    timestamp: new Date().toISOString()
  });
}));

/**
 * POST /cookies/refresh
 * Força renovação dos cookies
 */
router.post('/refresh', asyncHandler(async (req, res) => {
  const cookieManager = req.app.locals.services?.cookieManager;
  
  if (!cookieManager) {
    return res.status(503).json({ error: 'Cookie Manager não inicializado' });
  }

  const refreshed = await cookieManager.refreshCookies();
  const status = cookieManager.getStatus();
  
  res.json({
    refreshed,
    status,
    timestamp: new Date().toISOString()
  });
}));

/**
 * POST /cookies/webhook
 * Recebe cookies externos (ex.: Tampermonkey) e aplica no .env
 */
router.post('/webhook', asyncHandler(async (req, res) => {
  const cookieManager = req.app.locals.services?.cookieManager;

  if (!cookieManager) {
    return res.status(503).json({ error: 'Cookie Manager não inicializado' });
  }

  const source = req.body?.source || 'external';
  const sessionCookies = req.body?.sessionCookies || req.body?.cookie || '';
  const cfClearance = req.body?.cfClearance || req.body?.cf_clearance || '';

  if (!sessionCookies && !cfClearance) {
    return res.status(400).json({ error: 'Payload sem cookies' });
  }

  const result = await cookieManager.applyExternalCookies({
    sessionCookies,
    cfClearance,
    source
  });

  res.json({
    ok: true,
    source,
    result,
    timestamp: new Date().toISOString()
  });
}));

/**
 * POST /cookies/start-monitoring
 * Inicia monitoramento automático
 */
router.post('/start-monitoring', asyncHandler(async (req, res) => {
  const cookieManager = req.app.locals.services?.cookieManager;
  
  if (!cookieManager) {
    return res.status(503).json({ error: 'Cookie Manager não inicializado' });
  }

  cookieManager.startMonitoring();
  const status = cookieManager.getStatus();
  
  res.json({
    message: 'Monitoramento de cookies iniciado',
    status,
    timestamp: new Date().toISOString()
  });
}));

/**
 * POST /cookies/stop-monitoring
 * Para o monitoramento automático
 */
router.post('/stop-monitoring', asyncHandler(async (req, res) => {
  const cookieManager = req.app.locals.services?.cookieManager;
  
  if (!cookieManager) {
    return res.status(503).json({ error: 'Cookie Manager não inicializado' });
  }

  cookieManager.stopMonitoring();
  
  res.json({
    message: 'Monitoramento de cookies parado',
    timestamp: new Date().toISOString()
  });
}));

module.exports = router;
