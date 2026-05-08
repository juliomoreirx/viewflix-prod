const env = require('../config/env');

function adminAuth(req, res, next) {
  const authToken = req.headers.authorization;
  const validToken = env.ADMIN_API_TOKEN || 'seu-token-super-secreto';

  if (authToken !== `Bearer ${validToken}`) {
    return res.status(401).json({ error: 'Não autorizado' });
  }

  // Set userId para usuário admin
  req.userId = 'admin';

  return next();
}

module.exports = adminAuth;