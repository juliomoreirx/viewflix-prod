const express = require('express');
const { z } = require('zod');
const fs = require('fs');
const path = require('path');

const asyncHandler = require('../middlewares/async-handler');
const { CACHE_CONTEUDO, atualizarCache } = require('../services/content-cache.service');
const { buscarDetalhes } = require('../services/content-details.service');

const router = express.Router();

const listQuerySchema = z.object({
  type: z.enum(['movies', 'series', 'adult', 'livetv']).optional(),
  page: z.string().optional(),
  q: z.string().optional()
});

const detailsQuerySchema = z.object({
  id: z.string().min(1),
  type: z.string().min(1)
});

router.get('/api/list', asyncHandler(async (req, res) => {
  const parsed = listQuerySchema.safeParse(req.query);
  if (!parsed.success) return res.status(400).json({ error: 'Parâmetros inválidos' });

  const { type = 'movies', page = '1', q } = parsed.data;
  const pageNum = parseInt(page, 10) || 1;
  const limit = 20;

  if (
    CACHE_CONTEUDO.series.length === 0 &&
    CACHE_CONTEUDO.movies.length === 0 &&
    (CACHE_CONTEUDO.livetv || []).length === 0
  ) {
    await atualizarCache(true);
  }

  const isAdulto = (n) => /[\[\(]xxx|\+18|adulto|hentai/i.test(String(n).toUpperCase());

  let lista;
  if (type === 'adult') {
    lista = [...CACHE_CONTEUDO.movies, ...CACHE_CONTEUDO.series].filter((i) => isAdulto(i.name));
  } else if (type === 'livetv') {
    lista = CACHE_CONTEUDO.livetv || [];
  } else {
    lista = (CACHE_CONTEUDO[type] || []).filter((i) => !isAdulto(i.name));
  }

  if (q) lista = lista.filter((i) => i.name.toLowerCase().includes(String(q).toLowerCase()));

  const total = lista.length;
  const items = lista.slice((pageNum - 1) * limit, pageNum * limit);

  const data = items.map((item) => {
    const folder =
      type === 'adult'
        ? (CACHE_CONTEUDO.movies.find((m) => m.id === item.id) ? 'movies' : 'series')
        : type;

    const coverPath = path.join(process.cwd(), 'public', 'covers', folder, `${item.id}.jpg`);
    const img = fs.existsSync(coverPath)
      ? `/covers/${folder}/${item.id}.jpg`
      : `https://via.placeholder.com/300x450?text=${encodeURIComponent(item.name)}`;

    return { id: item.id, title: item.name, img, type: folder };
  });

  return res.json({
    data,
    currentPage: pageNum,
    totalPages: Math.ceil(total / limit),
    totalItems: total
  });
}));

router.get('/api/details', asyncHandler(async (req, res) => {
  const parsed = detailsQuerySchema.safeParse(req.query);
  if (!parsed.success) return res.status(400).json({ error: 'ID e tipo são obrigatórios' });

  const { id, type } = parsed.data;
  const detalhes = await buscarDetalhes(id, type);

  if (!detalhes) return res.status(404).json({ error: 'Conteúdo não encontrado' });
  return res.json(detalhes);
}));

module.exports = router;