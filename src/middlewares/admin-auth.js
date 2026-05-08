const env = require('../config/env');

function adminAuth(req, res, next) {
  const authToken = req.headers.authorization;
  const validToken = env.ADMIN_API_TOKEN || 'seu-token-super-secreto';

  if (authToken !== `Bearer ${validToken}`) {
    return res.status(401).json({ error: 'Não autorizado' });
  }

  const adminIds = String(process.env.ADMIN_IDS || '')
    .split(',')
    .map((id) => Number(id.trim()))
    .filter((id) => Number.isFinite(id));

  req.userId = adminIds[0] || 0;

  return next();
}

module.exports = adminAuth;