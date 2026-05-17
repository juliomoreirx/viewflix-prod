const db = require('./db.service');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const config = require('../config');

// 🚀 CORE: Expressão regular implacável para capturar os formatos problemáticos na web
const REGEX_BLOQUEIO_4K = /(4k|hdr|hybrid)/i;

/**
 * Auxiliar interno para varrer os arrays e remover os itens incompatíveis
 * @private
 */
function _filtrarListaIncompativel(items) {
  if (!Array.isArray(items)) return items;
  return items.filter(item => {
    const titulo = item.title || item.name || item.titulo || '';
    // Mantém na lista apenas se o título NÃO der match com 4K, HDR ou Hybrid
    return !REGEX_BLOQUEIO_4K.test(titulo);
  });
}

// Armazenamento em memória isolado para o interceptor trabalhar
let _cacheInternoBlindado = { movies: [], series: [], livetv: [] };

// Integração com o serviço de cache injetado
let vouverService = {
  buscarDetalhes: null,
  estimarDuracao: async () => 109,
  atualizarCache: async () => {},
  
  // 🚀 INTERCEPTOR DINÂMICO: Garante blindagem não importa a origem do carregamento do cache
  get CACHE_CONTEUDO() {
    return _cacheInternoBlindado;
  },
  set CACHE_CONTEUDO(novoCache) {
    if (!novoCache) {
      _cacheInternoBlindado = { movies: [], series: [], livetv: [] };
      return;
    }
    _cacheInternoBlindado = {
      movies: _filtrarListaIncompativel(novoCache.movies || []),
      series: _filtrarListaIncompativel(novoCache.series || []),
      livetv: _filtrarListaIncompativel(novoCache.livetv || novoCache.channels || [])
    };
  }
};

function setExternalServices(services) {
  if (!services) return;
  vouverService.buscarDetalhes = services.buscarDetalhes || services.getDetails || null;
  vouverService.estimarDuracao = services.estimarDuracao || services.estimateDuration || vouverService.estimarDuracao;
  vouverService.atualizarCache = services.atualizarCache || vouverService.atualizarCache;
  vouverService.CACHE_CONTEUDO = services.CACHE_CONTEUDO || services.CACHE_CONTEUDO;
}

function getCacheSafe() {
  // Retorna o cache que já passou obrigatoriamente pelo filtro do Setter
  return vouverService.CACHE_CONTEUDO || { movies: [], series: [], livetv: [] };
}

async function ensureCacheLoaded() {
  const cache = getCacheSafe();
  if ((!cache.movies || cache.movies.length === 0) && (!cache.series || cache.series.length === 0) && (!cache.livetv || cache.livetv.length === 0)) {
    await vouverService.atualizarCache();
  }
}

function gerarTokenAcesso(userId, videoId, mediaType) {
  try {
    const tempoSegundos = (mediaType === 'series' || mediaType === 'serie') ? 604800 : 86400; // 7 dias ou 24h
    return jwt.sign(
      { userId, videoId, mediaType, exp: Math.floor(Date.now() / 1000) + tempoSegundos },
      config.JWT_SECRET
    );
  } catch (error) {
    console.error('Erro ao gerar token:', error);
    return null;
  }
}

async function salvarConteudoComprado(userId, videoId, mediaType, title, price, episodeName = null, season = null, extra = {}) {
  try {
    const token = gerarTokenAcesso(userId, videoId, mediaType);
    if (!token) return null;

    const PurchasedContentModel = db.getPurchasedContentModel();
    const purchaseDate = new Date();
    const horasExpiracao = mediaType === 'series' ? (7 * 24) : 24;
    const expiresAt = new Date(purchaseDate.getTime() + (horasExpiracao * 60 * 60 * 1000));
    const sessionToken = crypto.randomBytes(32).toString('hex');

    const purchase = new PurchasedContentModel({
      userId, videoId, mediaType, title, episodeName, season,
      seriesId: extra?.seriesId || undefined,
      episodeIndex: Number.isFinite(extra?.episodeIndex) ? extra.episodeIndex : undefined,
      totalEpisodes: Number.isFinite(extra?.totalEpisodes) ? extra.totalEpisodes : undefined,
      purchaseDate, expiresAt, token, price, sessionToken,
      source: 'purchase',
      cacheStatus: (mediaType === 'movie' || mediaType === 'series') ? 'pending' : undefined,
      cacheProgress: (mediaType === 'movie' || mediaType === 'series') ? 0 : undefined
    });

    await purchase.save();
    return { token, purchase };
  } catch (error) {
    console.error('Erro ao salvar conteúdo comprado:', error);
    return null;
  }
}

module.exports = {
  setExternalServices,
  getCacheSafe,
  ensureCacheLoaded,
  vouverService,
  gerarTokenAcesso,
  salvarConteudoComprado
};