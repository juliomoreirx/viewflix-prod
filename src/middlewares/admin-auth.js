// src/middlewares/admin-auth.js
const env = require('../config/env');

function adminAuth(req, res, next) {
  // 1. Failsafe: Se não existir token configurado no ambiente, bloqueia a rota inteira.
  if (!env.ADMIN_API_TOKEN) {
    return res.status(500).json({ error: 'Configuração de segurança do servidor ausente.' });
  }

  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Não autorizado' });
  }

  const token = authHeader.split(' ')[1];

  // 2. Validação estrita sem fallbacks hardcoded
  if (token !== env.ADMIN_API_TOKEN) {
    return res.status(401).json({ error: 'Não autorizado' });
  }

  // 3. Usa o array validado diretamente do nosso env.js (Zod)
  req.userId = env.ADMIN_IDS && env.ADMIN_IDS.length > 0 ? env.ADMIN_IDS[0] : 0;

  return next();
}

module.exports = adminAuth;