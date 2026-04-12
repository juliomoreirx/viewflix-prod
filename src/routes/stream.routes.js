const express = require('express');
const axios = require('axios');
const { z } = require('zod');
const { HttpProxyAgent } = require('http-proxy-agent');
const env = require('../config/env');
const logger = require('../lib/logger');

const router = express.Router();

const querySchema = z.object({
  relay_secret: z.string().optional(),
  videoId: z.string().min(1),
  type: z.enum(['movie', 'series']).optional().default('movie')
});

// Proxy apenas para autenticação rápida (não consome dados)
const RES_PROXY_HOST = (env.RES_PROXY_HOST || '').trim();
const RES_PROXY_PORT = parseInt(String(env.RES_PROXY_PORT || '0').trim(), 10);
const RES_PROXY_USER = env.RES_PROXY_USER || '';
const RES_PROXY_PASS = env.RES_PROXY_PASS || '';

const proxyUrl = `http://${encodeURIComponent(RES_PROXY_USER)}:${encodeURIComponent(RES_PROXY_PASS)}@${RES_PROXY_HOST}:${RES_PROXY_PORT}`;
const residentialProxyAgent = new HttpProxyAgent(proxyUrl);

router.get('/relay-stream', async (req, res, next) => {
  try {
    const parsed = querySchema.safeParse({
      relay_secret: req.query.relay_secret,
      videoId: req.query.videoId,
      type: req.query.type || 'movie'
    });

    if (!parsed.success) return res.status(400).send('Invalid query');

    const { relay_secret, videoId, type } = parsed.data;

    if (!relay_secret || relay_secret !== env.RELAY_SECRET) {
      return res.status(403).send('Forbidden');
    }

    const login = env.LOGIN_USER || '';
    const senha = env.LOGIN_PASS || '';
    const base = type === 'series' ? 'http://goplay.icu/series' : 'http://goplay.icu/movie';
    const streamUrl = `${base}/${login}/${senha}/${encodeURIComponent(videoId)}.mp4`;

    // 1. Usa o proxy apenas para descobrir a porta do cofre (0 consumo de dados pesados)
    const response = await axios.get(streamUrl, {
      httpAgent: residentialProxyAgent,
      httpsAgent: residentialProxyAgent,
      maxRedirects: 0, 
      validateStatus: (status) => status >= 200 && status <= 302
    });

    const finalUrl = response.headers.location;

    if (!finalUrl) {
      return res.status(404).send('Falha ao capturar IP do video.');
    }

    // 2. Remove o "http://" para que o Nginx consiga ler o caminho corretamente
    const urlLimpa = finalUrl.replace(/^https?:\/\//, '');

    logger.info({ msg: 'Delegando IP bruto para o Nginx', videoId, urlLimpa });

    if (req.headers.range) {
      res.setHeader('Range', req.headers.range);
    }

    // 3. O Node envia o IP dinâmico diretamente na URI do túnel
    res.setHeader('X-Accel-Redirect', `/proxy-stream/${urlLimpa}`);
    res.end();

  } catch (error) {
    logger.error({ msg: 'erro no /relay-stream', error: error.message });
    next(error);
  }
});

module.exports = router;