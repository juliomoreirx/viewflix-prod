const env = require('../config/env');

function adminAuth(req, res, next) {
  const authToken = req.headers.authorization;
  const validToken = env.ADMIN_API_TOKEN || 'seu-token-super-secreto';

  if (authToken !== `Bearer ${validToken}`) {
    return res.status(401).json({ error: 'Não autorizado' });
  }

  return next();
}

module.exports = adminAuth;