const express = require('express');
const { z } = require('zod');
const env = require('../config/env');
const logger = require('../lib/logger');

const router = express.Router();

const querySchema = z.object({
  relay_secret: z.string().optional(),
  videoId: z.string().min(1),
  type: z.enum(['movie', 'series']).optional().default('movie')
});

router.get('/relay-stream', async (req, res, next) => {
  try {
    const parsed = querySchema.safeParse({
      relay_secret: req.query.relay_secret,
      videoId: req.query.videoId,
      type: req.query.type || 'movie'
    });

    if (!parsed.success) {
      return res.status(400).send('Invalid query');
    }

    const { relay_secret, videoId, type } = parsed.data;
    const requestId = req.requestId;

    // 1. O Node.js atua apenas como validador de segurança
    if (!relay_secret || relay_secret !== env.RELAY_SECRET) {
      logger.warn({ msg: 'relay_secret invalido', requestId });
      return res.status(403).send('Forbidden');
    }

    const login = env.LOGIN_USER || '';
    const senha = env.LOGIN_PASS || '';
    const baseType = type === 'series' ? 'series' : 'movie';
    
    // 2. Monta o caminho que o Nginx vai usar para puxar do GoPlay
    const videoPath = `${baseType}/${login}/${senha}/${encodeURIComponent(videoId)}.mp4`;

    logger.info({
      msg: 'Delegando stream ao Nginx via X-Accel-Redirect',
      requestId,
      videoId,
      videoPath
    });

    // 3. A MÁGICA: O Node.js passa o bastão para o Nginx através deste header
    res.setHeader('X-Accel-Redirect', `/internal-stream/${videoPath}`);
    
    // Repassa o pedido de Range (vital para o utilizador conseguir avançar o vídeo)
    if (req.headers.range) {
      res.setHeader('Range', req.headers.range);
    }

    res.end();

  } catch (error) {
    logger.error({ msg: 'erro no /relay-stream', error: error.message });
    next(error);
  }
});

module.exports = router;