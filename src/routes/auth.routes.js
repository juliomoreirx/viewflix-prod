const express = require('express');
const { z } = require('zod');
const asyncHandler = require('../middlewares/async-handler');
const { fazerLoginVouver } = require('../services/vouver-auth.service');
const { getSessionCookiesRaw, atualizarCache } = require('../services/content-cache.service');

const router = express.Router();

const bodySchema = z.object({
  username: z.string().min(1),
  password: z.string().min(1)
});

router.post('/api/login', asyncHandler(async (req, res) => {
  const parsed = bodySchema.safeParse(req.body);
  if (!parsed.success) {
    return res.json({ status: 'error', message: 'Usuário e senha são obrigatórios' });
  }

  const { username, password } = parsed.data;
  const success = await fazerLoginVouver(username, password);

  if (success) {
    return res.json({ status: 'success', message: 'Login realizado com sucesso' });
  }

  const hasSession = !!getSessionCookiesRaw();
  if (hasSession) {
    await atualizarCache(true);
    return res.json({
      status: 'success',
      message: 'Login automático falhou, mas sessão ativa do servidor foi mantida'
    });
  }

  return res.json({ status: 'error', message: 'Falha no login' });
}));

module.exports = router;