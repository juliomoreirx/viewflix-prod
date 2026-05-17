// bot/services/content.service.js
const db = require('./db.service');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const config = require('../config');
const path = require('path');
const fs = require('fs');

// 🚀 Importação do ecossistema de infraestrutura para reaproveitar a conexão nativa do Redis
const bunnyCacheService = require('../../src/services/bunny-cache.service');

// CORE: Expressão regular para capturar formatos de filmes/séries incompatíveis na web
const REGEX_BLOQUEIO_4K = /(4k|hdr|hybrid)/i;

// 🚀 CONFIGURAÇÃO LOCAL-FIRST: Aponta para a tua pasta centralizada de dumps/output
const OUTPUT_BASE_DIR = process.env.OUTPUT_DIR || path.join(__dirname, '../../output');

/**
 * Auxiliar interno para varrer os arrays de filmes/séries e remover os itens incompatíveis
 * @private
 */
function _filtrarListaIncompativel(items) {
  if (!Array.isArray(items)) return items;
  return items.filter(item => {
    const titulo = item.title || item.name || item.titulo || '';
    return !REGEX_BLOQUEIO_4K.test(titulo);
  });
}

/**
 * Auxiliar interno para varrer e blindar a lista de canais ao vivo (Live TV)
 * Regras: Remover canais que iniciam com [24H] e canais que contenham [H265] ou [HDR]
 * @private
 */
function _filtrarCanaisIncompativeis(items) {
  if (!Array.isArray(items)) return items;
  
  const regexInicio24h = /^\[24h\]/i;
  const regexContemIncompativel = /(h265|hdr)/i;
  
  return items.filter(item => {
    const titulo = item.title || item.name || item.titulo || '';
    return !regexInicio24h.test(titulo) && !regexContemIncompativel.test(titulo);
  });
}

// Armazenamento em memória isolado para o interceptor trabalhar localmente na thread ativa
let _cacheInternoBlindado = { movies: [], series: [], livetv: [] };

// Referência guardada internamente para o raspador remoto atuar como contingência (Fallback)
let _buscarDetalhesRemoto = null;

/**
 * Procura um ficheiro de metadados JSON local mapeando as possíveis estruturas de diretórios da pasta output
 * @private
 */
function _encontrarMetadataLocal(id, type) {
  const folderType = type === 'movie' ? 'movies' : 'series';
  
  // Mapeamento resiliente de caminhos baseados na tua estrutura estruturada de raspagem
  const caminhosPossiveis = [
    path.join(OUTPUT_BASE_DIR, folderType, String(id), 'details.json'),
    path.join(OUTPUT_BASE_DIR, folderType, String(id), 'info.json'),
    path.join(OUTPUT_BASE_DIR, folderType, String(id), `${id}.json`),
    path.join(OUTPUT_BASE_DIR, type, String(id), 'details.json'),
    path.join(OUTPUT_BASE_DIR, type, String(id), `${id}.json`)
  ];

  for (const caminho of caminhosPossiveis) {
    if (fs.existsSync(caminho)) {
      return caminho;
    }
  }
  return null;
}

/**
 * Interceptor de Alta Velocidade Local-First. Lê metadados do SSD local em 3ms.
 * Caso não encontre, recorre à API externa e persiste o resultado para as próximas consultas.
 * @private
 */
async function _buscarDetalhesLocalFirst(id, type) {
  try {
    const caminhoLocal = _encontrarMetadataLocal(id, type);
    
    if (caminhoLocal) {
      const rawData = fs.readFileSync(caminhoLocal, 'utf8');
      const detalhes = JSON.parse(rawData);
      
      // Normalizações básicas de contrato de dados
      if (!detalhes.mediaType) detalhes.mediaType = type;
      if (!detalhes.id) detalhes.id = id;
      
      // 🚀 CAPA LOCAL INTELIGENTE: Se não houver coverPath definido, varre a pasta à procura do .jpg correspondente
      if (!detalhes.coverPath) {
        const folderPath = path.dirname(caminhoLocal);
        const arquivos = fs.readdirSync(folderPath);
        const imagem = arquivos.find(f => /\.(jpg|jpeg|png)$/i.test(f));
        if (imagem) {
          detalhes.coverPath = path.join(folderPath, imagem);
        }
      }

      console.log(`⚡ [Local-First Engine] Conteúdo [${type}] ID: ${id} resolvido instantaneamente do disco local.`);
      return detalhes;
    }
  } catch (err) {
    console.error(`⚠️ Erro ao processar leitura do cache local do ID ${id}:`, err.message);
  }

  // FALLBACK: Se não localizou no disco rígido da VPS, dispara o robô remoto convencional
  if (_buscarDetalhesRemoto) {
    console.log(`🌐 [Remote Fallback] ID: ${id} não localizado na pasta output. Acionando raspador remoto...`);
    const detalhesRemotos = await _buscarDetalhesRemoto(id, type);
    
    // Auto-Alimentação: Grava o resultado remotamente no disco para blindar a próxima consulta
    if (detalhesRemotos) {
      try {
        const folderType = type === 'movie' ? 'movies' : 'series';
        const targetFolder = path.join(OUTPUT_BASE_DIR, folderType, String(id));
        if (!fs.existsSync(targetFolder)) {
          fs.mkdirSync(targetFolder, { recursive: true });
        }
        fs.writeFileSync(path.join(targetFolder, 'details.json'), JSON.stringify(detalhesRemotos, null, 2), 'utf8');
        console.log(`💾 [Local-First System] Cache gerado com sucesso para o ID ${id} dentro de output/${folderType}.`);
      } catch (saveErr) {
        console.warn(`⚠️ Falha ao salvar persistência de contingência local:`, saveErr.message);
      }
    }
    return detalhesRemotos;
  }
  return null;
}

// Integração com o serviço de cache injetado
let vouverService = {
  buscarDetalhes: _buscarDetalhesLocalFirst, // Injetado por padrão como Local-First
  estimarDuracao: async () => 109,
  atualizarCache: async () => {},
  
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
      livetv: _filtrarCanaisIncompativeis(novoCache.livetv || novoCache.channels || [])
    };
    
    bunnyCacheService.redisConnection.set('fasttv:catalog:global', JSON.stringify(_cacheInternoBlindado))
      .then(() => {
        console.log(`📥 [Redis Catalog] Catálogo de segurança persistido e sincronizado no Redis com sucesso.`);
      })
      .catch(err => {
        console.error('❌ [Redis Catalog] Erro crítico ao salvar string de cache no Redis:', err.message);
      });
  }
};

function setExternalServices(services) {
  if (!services) return;
  // Redireciona o buscador externo para a nossa variável de fallback seguro
  _buscarDetalhesRemoto = services.buscarDetalhes || services.getDetails || null;
  
  // Mantém a API do bot amarrada ao interceptor local de alta performance
  vouverService.buscarDetalhes = _buscarDetalhesLocalFirst;
  
  vouverService.estimarDuracao = services.estimarDuracao || services.estimateDuration || vouverService.estimarDuracao;
  vouverService.atualizarCache = services.atualizarCache || vouverService.atualizarCache;
  if (services.CACHE_CONTEUDO) {
    vouverService.CACHE_CONTEUDO = services.CACHE_CONTEUDO;
  }
}

function getCacheSafe() {
  return vouverService.CACHE_CONTEUDO || { movies: [], series: [], livetv: [] };
}

async function ensureCacheLoaded() {
  if (_cacheInternoBlindado.movies.length === 0 && _cacheInternoBlindado.series.length === 0 && _cacheInternoBlindado.livetv.length === 0) {
    try {
      const cacheSalvoNoRedis = await bunnyCacheService.redisConnection.get('fasttv:catalog:global');
      if (cacheSalvoNoRedis) {
        const parsedCache = JSON.parse(cacheSalvoNoRedis);
        _cacheInternoBlindado = parsedCache;
        console.log(`🚀 [Redis Catalog] Sincronização multi-cluster ativa! Catálogo recuperado via Redis: ${_cacheInternoBlindado.movies.length} filmes, ${_cacheInternoBlindado.series.length} séries, ${_cacheInternoBlindado.livetv.length} canais.`);
        return;
      }
    } catch (err) {
      console.error('❌ [Redis Catalog] Falha ao tentar ler backup do catálogo no Redis, acionando fluxo convencional:', err.message);
    }
  }

  const cache = getCacheSafe();
  if ((!cache.movies || cache.movies.length === 0) && (!cache.series || cache.series.length === 0) && (!cache.livetv || cache.livetv.length === 0)) {
    await vouverService.atualizarCache();
  }
}

function gerarTokenAcesso(userId, videoId, mediaType) {
  try {
    const tempoSegundos = (mediaType === 'series' || mediaType === 'serie') ? 604800 : 86400; 
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