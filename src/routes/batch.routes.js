const express = require('express');
const { z } = require('zod');
const router = express.Router();

const adminAuth = require('../middlewares/admin-auth');
const asyncHandler = require('../middlewares/async-handler');
const env = require('../config/env');

// Schemas de validação
const createBatchSchema = z.object({
  name: z.string().min(3).max(100),
  description: z.string().optional(),
  items: z.array(
    z.object({
      videoId: z.string().min(1),
      title: z.string().nullable().optional(),
      mediaType: z.enum(['movie', 'series']),
      season: z.string().nullable().optional(),
      episodeName: z.string().nullable().optional(),
      episodeIndex: z.number().optional()
    })
  ).max(500).optional(), // Permite estar vazio ou ausente
  concurrency: z.number().min(1).max(10).optional(),
  autoStart: z.boolean().optional()
});

const updateBatchSchema = z.object({
  name: z.string().min(3).max(100).optional(),
  description: z.string().optional(),
  status: z.enum(['draft', 'queued', 'processing', 'paused']).optional(),
  concurrency: z.number().min(1).max(10).optional()
});

const addBatchItemsSchema = z.object({
  items: z.array(
    z.object({
      videoId: z.string().min(1),
      title: z.string().nullable().optional(),
      mediaType: z.enum(['movie', 'series']),
      season: z.string().nullable().optional(),
      episodeName: z.string().nullable().optional(),
      episodeIndex: z.number().optional()
    })
  ).min(1).max(50)
});

function normalizeBatchItems(items = []) {
  return items.map((item, idx) => ({
    ...item,
    status: item.status || 'pending',
    stage: item.stage || 'queued',
    progress: Number.isFinite(Number(item.progress)) ? Number(item.progress) : 0,
    episodeIndex: item.episodeIndex ?? idx
  }));
}

function recomputeBatchStats(batch) {
  const items = batch.items || [];
  batch.totalItems = items.length;
  batch.completedItems = items.filter((item) => item.status === 'ready').length;
  batch.failedItems = items.filter((item) => item.status === 'failed').length;
  const progressSum = items.reduce((sum, item) => sum + (Number.isFinite(Number(item.progress)) ? Number(item.progress) : 0), 0);
  batch.overallProgress = items.length > 0 ? Math.min(100, Math.round(progressSum / items.length)) : 0;
}

function createBatchPersistQueue(batch, BatchDownload) {
  let chain = Promise.resolve();
  return (snapshot = {}) => {
    chain = chain
      .then(() => BatchDownload.updateOne(
        { _id: batch._id },
        { $set: { ...snapshot, updatedAt: new Date() } }
      ))
      .catch((error) => {
        console.error('Erro ao persistir progresso do batch:', error);
      });
    return chain;
  };
}

// ===== CREATE BATCH =====
router.post('/api/admin/batch/create', adminAuth, asyncHandler(async (req, res) => {
  const parsed = createBatchSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({
      error: 'Dados inválidos',
      details: parsed.error.flatten()
    });
  }

  const { BatchDownload } = req.app.locals.models;
  
  const batch = new BatchDownload({
    userId: req.userId, // Admin user ID
    name: parsed.data.name,
    description: parsed.data.description,
    items: normalizeBatchItems(parsed.data.items || []),
    concurrency: parsed.data.concurrency || 2,
    autoStart: parsed.data.autoStart || false,
    totalItems: (parsed.data.items || []).length,
    completedItems: 0,
    failedItems: 0,
    overallProgress: 0
  });

  await batch.save();

  res.status(201).json({
    success: true,
    data: batch
  });
}));

// ===== LIST BATCHES =====
router.get('/api/admin/batch/list', adminAuth, asyncHandler(async (req, res) => {
  const { status, limit = 50, page = 1 } = req.query;
  const { BatchDownload } = req.app.locals.models;

  const query = { userId: req.userId };
  if (status) {
    query.status = status;
  }

  const batches = await BatchDownload.find(query)
    .sort({ createdAt: -1 })
    .limit(Number(limit))
    .skip((Number(page) - 1) * Number(limit))
    .select('-items') // Não retornar items em lista (são grandes)
    .lean();

  const total = await BatchDownload.countDocuments(query);

  res.json({
    success: true,
    data: batches,
    pagination: {
      page: Number(page),
      limit: Number(limit),
      total,
      pages: Math.ceil(total / Number(limit))
    }
  });
}));

// ===== GET BATCH DETAILS =====
router.get('/api/admin/batch/:id', adminAuth, asyncHandler(async (req, res) => {
  const { BatchDownload } = req.app.locals.models;
  
  const batch = await BatchDownload.findById(req.params.id);
  
  if (!batch || batch.userId !== req.userId) {
    return res.status(404).json({ error: 'Lote não encontrado' });
  }

  res.json({
    success: true,
    data: batch
  });
}));

// ===== UPDATE BATCH =====
router.put('/api/admin/batch/:id', adminAuth, asyncHandler(async (req, res) => {
  const parsed = updateBatchSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({
      error: 'Dados inválidos',
      details: parsed.error.flatten()
    });
  }

  const { BatchDownload } = req.app.locals.models;
  
  const batch = await BatchDownload.findById(req.params.id);
  if (!batch || batch.userId !== req.userId) {
    return res.status(404).json({ error: 'Lote não encontrado' });
  }

  if (batch.status === 'processing') {
    return res.status(409).json({ error: 'Não é possível editar um lote em processamento' });
  }

  Object.assign(batch, parsed.data);
  batch.updatedAt = new Date();
  await batch.save();

  res.json({
    success: true,
    data: batch
  });
}));

// ===== ADD ITEMS TO BATCH =====
router.post('/api/admin/batch/:id/items', adminAuth, asyncHandler(async (req, res) => {
  const parsed = addBatchItemsSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({
      error: 'Dados inválidos',
      details: parsed.error.flatten()
    });
  }

  const { BatchDownload } = req.app.locals.models;
  const batch = await BatchDownload.findById(req.params.id);

  if (!batch || batch.userId !== req.userId) {
    return res.status(404).json({ error: 'Lote não encontrado' });
  }

  if (batch.status === 'processing' || batch.status === 'completed') {
    return res.status(409).json({ error: 'Não é possível editar um lote em processamento' });
  }

  const existingIds = new Set((batch.items || []).map((item) => String(item.videoId)));
  const incomingItems = parsed.data.items
    .filter((item) => !existingIds.has(String(item.videoId)))
    .map((item, idx) => ({
      ...item,
      episodeIndex: item.episodeIndex ?? (batch.items.length + idx),
      status: 'pending',
      stage: 'queued',
      progress: 0
    }));

  batch.items.push(...incomingItems);
  batch.totalItems = batch.items.length;
  batch.completedItems = batch.items.filter((item) => item.status === 'ready').length;
  batch.failedItems = batch.items.filter((item) => item.status === 'failed').length;
  batch.overallProgress = batch.totalItems > 0
    ? Math.round(((batch.completedItems + batch.failedItems) / batch.totalItems) * 100)
    : 0;
  batch.updatedAt = new Date();

  await batch.save();

  res.json({
    success: true,
    data: batch
  });
}));

// ===== DELETE BATCH =====
router.delete('/api/admin/batch/:id', adminAuth, asyncHandler(async (req, res) => {
  const { BatchDownload } = req.app.locals.models;
  
  const batch = await BatchDownload.findById(req.params.id);
  if (!batch || batch.userId !== req.userId) {
    return res.status(404).json({ error: 'Lote não encontrado' });
  }

  if (batch.status === 'processing') {
    return res.status(409).json({ error: 'Não é possível deletar um lote em processamento' });
  }

  await BatchDownload.deleteOne({ _id: batch._id });

  res.json({
    success: true,
    message: 'Lote deletado com sucesso'
  });
}));

// ===== START BATCH =====
router.post('/api/admin/batch/:id/start', adminAuth, asyncHandler(async (req, res) => {
  const { BatchDownload } = req.app.locals.models;
  const bunnyCacheService = req.app.locals.services?.bunnyCacheService;

  if (!bunnyCacheService) {
    return res.status(500).json({ error: 'Serviço de cache não disponível' });
  }

  const batch = await BatchDownload.findById(req.params.id);
  if (!batch || batch.userId !== req.userId) {
    return res.status(404).json({ error: 'Lote não encontrado' });
  }

  if (batch.status === 'processing' || batch.status === 'completed') {
    return res.status(409).json({ error: 'Lote já foi processado' });
  }

  batch.status = 'processing';
  batch.startedAt = new Date();
  batch.updatedAt = new Date();
  await batch.save();

  // Processar itens em background (não bloquear response)
  processBatchAsync(batch, bunnyCacheService).catch((err) => {
    console.error('Erro ao processar batch:', err);
  });

  res.json({
    success: true,
    data: batch,
    message: 'Processamento iniciado em background'
  });
}));

// ===== PAUSE BATCH =====
router.post('/api/admin/batch/:id/pause', adminAuth, asyncHandler(async (req, res) => {
  const { BatchDownload } = req.app.locals.models;
  
  const batch = await BatchDownload.findById(req.params.id);
  if (!batch || batch.userId !== req.userId) {
    return res.status(404).json({ error: 'Lote não encontrado' });
  }

  if (batch.status !== 'processing') {
    return res.status(409).json({ error: 'Apenas lotes em processamento podem ser pausados' });
  }

  batch.status = 'paused';
  batch.updatedAt = new Date();
  await batch.save();

  res.json({
    success: true,
    data: batch
  });
}));

// ===== RESUME BATCH =====
router.post('/api/admin/batch/:id/resume', adminAuth, asyncHandler(async (req, res) => {
  const { BatchDownload } = req.app.locals.models;
  const bunnyCacheService = req.app.locals.services?.bunnyCacheService;

  if (!bunnyCacheService) {
    return res.status(500).json({ error: 'Serviço de cache não disponível' });
  }

  const batch = await BatchDownload.findById(req.params.id);
  if (!batch || batch.userId !== req.userId) {
    return res.status(404).json({ error: 'Lote não encontrado' });
  }

  if (batch.status !== 'paused') {
    return res.status(409).json({ error: 'Apenas lotes pausados podem ser retomados' });
  }

  batch.status = 'processing';
  batch.updatedAt = new Date();
  await batch.save();

  processBatchAsync(batch, bunnyCacheService).catch((err) => {
    console.error('Erro ao processar batch:', err);
  });

  res.json({
    success: true,
    data: batch
  });
}));

// Função auxiliar para processar lote em background
async function processBatchAsync(batch, bunnyCacheService) {
  const { PurchasedContent, BatchDownload } = require('../models');
  const persistBatch = createBatchPersistQueue(batch, BatchDownload);

  try {
    const activeDownloads = [];
    let itemIndex = 0;

    while (itemIndex < batch.items.length || activeDownloads.length > 0) {
      // Manter número máximo de downloads paralelos
      while (activeDownloads.length < batch.concurrency && itemIndex < batch.items.length) {
        const item = batch.items[itemIndex];
        itemIndex++;

        // Criar purchase object para o item do batch
        const purchase = new PurchasedContent({
          userId: batch.userId,
          videoId: item.videoId,
          title: item.title || item.videoId,
          mediaType: item.mediaType,
          season: item.season,
          episodeName: item.episodeName,
          token: `batch-${batch._id}-${item._id}`,
          sessionToken: `batch-session-${Date.now()}-${Math.random()}`,
          source: 'batch',
          sourceBatchId: String(batch._id),
          sourceBatchItemId: String(item._id),
          cacheStatus: 'pending',
          cacheProgress: 0,
          expiresAt: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000), // 1 ano
          // Deixar buildStoragePath gerar o caminho correto (movies/ ou series/)
          // Não fazer purchase real, apenas cache
          price: 0,
          purchaseDate: new Date()
        });

        await purchase.save();

        // Enfileirar no cache service
        const downloadPromise = new Promise((resolve) => {
          bunnyCacheService.enqueue(purchase, {
            onProgress: ({ percent, stage }) => {
              const idx = batch.items.findIndex(i => String(i._id) === String(item._id));
              if (idx >= 0) {
                batch.items[idx].progress = Number.isFinite(Number(percent)) ? Number(percent) : 0;
                batch.items[idx].stage = stage || 'downloading';
                batch.items[idx].status = percent === 100 ? 'ready' : 'downloading';
                recomputeBatchStats(batch);
                void persistBatch({
                  items: batch.items,
                  completedItems: batch.completedItems,
                  failedItems: batch.failedItems,
                  overallProgress: batch.overallProgress,
                  status: batch.status,
                  startedAt: batch.startedAt,
                  completedAt: batch.completedAt
                });
              }
            },
            onReady: ({ storagePath }) => {
              const idx = batch.items.findIndex(i => String(i._id) === String(item._id));
              if (idx >= 0) {
                batch.items[idx].status = 'ready';
                batch.items[idx].progress = 100;
                batch.items[idx].stage = 'ready';
                batch.items[idx].storagePath = storagePath;
                batch.items[idx].cacheReadyAt = new Date();
                recomputeBatchStats(batch);
                void persistBatch({
                  items: batch.items,
                  completedItems: batch.completedItems,
                  failedItems: batch.failedItems,
                  overallProgress: batch.overallProgress,
                  status: batch.status,
                  startedAt: batch.startedAt,
                  completedAt: batch.completedAt
                });
              }
              resolve();
            },
            onError: (error) => {
              const idx = batch.items.findIndex(i => String(i._id) === String(item._id));
              if (idx >= 0) {
                batch.items[idx].status = 'failed';
                batch.items[idx].error = error.message;
                batch.items[idx].stage = 'failed';
                batch.items[idx].progress = Number.isFinite(Number(batch.items[idx].progress)) ? Number(batch.items[idx].progress) : 0;
                recomputeBatchStats(batch);
                void persistBatch({
                  items: batch.items,
                  completedItems: batch.completedItems,
                  failedItems: batch.failedItems,
                  overallProgress: batch.overallProgress,
                  status: batch.status,
                  startedAt: batch.startedAt,
                  completedAt: batch.completedAt
                });
              }
              resolve();
            }
          });
        });

        activeDownloads.push(downloadPromise);
      }

      // Aguardar uma das promises
      if (activeDownloads.length > 0) {
        await Promise.race(activeDownloads);
        // Remover promises resolvidas
        const settled = await Promise.allSettled(activeDownloads);
        activeDownloads.length = 0; // Limpar array
      }

      // Atualizar batch a cada item completado
      if (batch.status !== 'paused') {
        recomputeBatchStats(batch);
        await persistBatch({
          items: batch.items,
          completedItems: batch.completedItems,
          failedItems: batch.failedItems,
          overallProgress: batch.overallProgress,
          status: batch.status,
          startedAt: batch.startedAt,
          completedAt: batch.completedAt
        });
      }

      if (batch.status === 'paused') {
        break;
      }
    }

    // Finalizar
    batch.status = 'completed';
    batch.completedAt = new Date();
    recomputeBatchStats(batch);
    batch.updatedAt = new Date();
    await batch.save();
  } catch (error) {
    console.error('Erro processando batch:', error);
    batch.status = 'failed';
    batch.updatedAt = new Date();
    await batch.save();
  }
}

module.exports = router;
