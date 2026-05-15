// ===== CARREGA VARIÁVEIS DE AMBIENTE =====
require('dotenv').config();

const TelegramBot = require('node-telegram-bot-api');
const jwt = require('jsonwebtoken');
const axios = require('axios');
const crypto = require('crypto');

const UserLocal = require('./src/models/user.model.js');
const PurchasedContentLocal = require('./src/models/purchased-content.model.js');

// Importando o novo serviço purificador
const { 
  decodificarHTML, 
  escaparMarkdownSeguro, 
  sanitizarTexto, 
  removerAcentos 
} = require('./src/services/text-utils.service');
const sessionService = require('./src/services/session.service');
const paymentAdapter = require('./src/adapters/payment.adapter');
const bunnyCacheService = require('./src/services/bunny-cache.service');
const logger = require('./src/lib/logger');


// ============================
// CONFIGURAÇÕES (TODAS DO .ENV)
// ============================
const BOT_TOKEN = process.env.BOT_TOKEN;
const JWT_SECRET = process.env.JWT_SECRET;
const MP_ACCESS_TOKEN = process.env.MP_ACCESS_TOKEN;

let DOMINIO_PUBLICO = '';

const PRECO_POR_HORA = parseInt(process.env.PRECO_POR_HORA || '250', 10);
const PRECO_MINIMO = parseInt(process.env.PRECO_MINIMO || '25', 10);
const PRECO_MINIMO_SERIE = parseInt(process.env.PRECO_MINIMO_SERIE || String(PRECO_MINIMO), 10);
const PRECO_LIVETV_FIXO = parseInt(process.env.PRECO_LIVETV_FIXO || '500', 10);
const BONUS_INICIAL_NOVO_USUARIO = parseInt(process.env.BONUS_INICIAL_NOVO_USUARIO || '500', 10);

const ADMIN_IDS = process.env.ADMIN_IDS ? process.env.ADMIN_IDS.split(',').map(id => parseInt(id, 10)) : [];

// ===== VALIDAÇÃO DE VARIÁVEIS OBRIGATÓRIAS =====
if (!BOT_TOKEN) {
  console.error('❌ ERRO CRÍTICO: BOT_TOKEN não definido no .env');
  process.exit(1);
}

if (!JWT_SECRET) {
  console.error('❌ ERRO CRÍTICO: JWT_SECRET não definido no .env');
  process.exit(1);
}

if (!MP_ACCESS_TOKEN) {
  // Pix não disponível sem token
}

// ============================
// INICIALIZAÇÃO DO BOT
// ============================
const bot = new TelegramBot(BOT_TOKEN, { polling: false });

// ============================
// GARBAGE COLLECTION E ESTADO 
// ============================
let userStates = {};
let pendingPayments = {};
let paymentCheckIntervals = {}

const cacheProgressByToken = new Map();

// Limpa memória a cada 30 minutos
setInterval(() => {
  const agora = Date.now();
  // Limpar estados inativos há mais de 1 hora
  for (const chatId in userStates) {
    if (userStates[chatId].updatedAt && (agora - userStates[chatId].updatedAt > 3600000)) {
      delete userStates[chatId];
    }
  }
  // Limpar pagamentos pendentes expirados
  for (const pixId in pendingPayments) {
    if (pendingPayments[pixId].timestamp && (agora - pendingPayments[pixId].timestamp > 1800000)) {
      delete pendingPayments[pixId];
    }
  }
}, 1800000); // 30 min

// ============================
// SERVIÇOS EXTERNOS
// ============================
let vouverService = {
  buscarDetalhes: null,
  estimarDuracao: null,
  atualizarCache: async () => {},
  CACHE_CONTEUDO: { movies: [], series: [], livetv: [] }
};

function setModels(models) {
  UserModel =
    models?.User ||
    models?.user ||
    models?.['user.model'] ||
    UserLocal;

  PurchasedContentModel =
    models?.PurchasedContent ||
    models?.purchasedContent ||
    models?.['purchased-content.model'] ||
    PurchasedContentLocal;

  // Models injetados
}

function initBot(models, services, dominio) {
  setModels(models);

  vouverService.buscarDetalhes =
    services?.buscarDetalhes ||
    services?.getDetails ||
    services?.fetchDetails ||
    null;

  vouverService.estimarDuracao =
    services?.estimarDuracao ||
    services?.estimateDuration ||
    null;

  vouverService.atualizarCache =
    services?.atualizarCache ||
    vouverService.atualizarCache;

  vouverService.CACHE_CONTEUDO =
    services?.CACHE_CONTEUDO ||
    vouverService.CACHE_CONTEUDO ||
    { movies: [], series: [], livetv: [] };

  DOMINIO_PUBLICO = dominio || DOMINIO_PUBLICO;

  // ==========================================
  // ADICIONE ESTA LINHA AQUI:
  bot.startPolling();
  // ==========================================

  // Bot inicializado
}

function getCacheSafe() {
  return vouverService?.CACHE_CONTEUDO || { movies: [], series: [], livetv: [] };
}

async function ensureCacheLoaded() {
  const cache = getCacheSafe();
  if (
    (!cache.movies || cache.movies.length === 0) &&
    (!cache.series || cache.series.length === 0) &&
    (!cache.livetv || cache.livetv.length === 0)
  ) {
    await vouverService?.atualizarCache?.();
  }
}

function getBuscarDetalhes() {
  return typeof vouverService?.buscarDetalhes === 'function' ? vouverService.buscarDetalhes : null;
}

function getEstimarDuracao(defaultMin = 109) {
  if (typeof vouverService?.estimarDuracao === 'function') return vouverService.estimarDuracao;
  return async () => defaultMin;
}

function toAbsoluteUrl(url = '') {
  if (!url) return '';
  if (/^https?:\/\//i.test(url)) return url;
  const base = String(DOMINIO_PUBLICO || '').replace(/\/$/, '');
  return base ? `${base}${url.startsWith('/') ? '' : '/'}${url}` : url;
}

function toTelegramUrl(url = '') {
  if (!url) return '';
  let normalized = String(url);
  if (/\.ngrok-free\.app\b/i.test(normalized)) {
    normalized = normalized.includes('?')
      ? `${normalized}&ngrok-skip-browser-warning=1`
      : `${normalized}?ngrok-skip-browser-warning=1`;
  }
  return encodeURI(normalized);
}

// ============================
// FUNÇÕES AUXILIARES (TRADUTORES HTML)
// ============================



function formatMoney(centavos) {
  return `R$ ${(centavos / 100).toFixed(2).replace('.', ',')}`;
}

function normalizarDuracaoMin(mediaType, duracaoMinutos) {
  const d = parseInt(String(duracaoMinutos || 0), 10);
  if (Number.isFinite(d) && d > 0) return d;
  return mediaType === 'movie' ? 110 : 24; 
}

function calcularPrecoFinal({ mediaType = 'movie', duracaoMinutos = 0 }) {
  const tipo = mediaType === 'series' ? 'series' : 'movie';
  const minutos = normalizarDuracaoMin(tipo, duracaoMinutos);

  const precoExato = (PRECO_POR_HORA * minutos) / 60;
  const precoBase = Math.round(precoExato);

  const minimoAplicado = tipo === 'series' ? PRECO_MINIMO_SERIE : PRECO_MINIMO;
  const precoFinal = Math.max(precoBase, minimoAplicado);

  return {
    mediaType: tipo,
    duracaoMinutos: minutos,
    precoPorHora: PRECO_POR_HORA,
    precoBase,
    precoMinimoAplicado: minimoAplicado,
    precoFinal
  };
}

function calcularPreco(minutos) {
  return calcularPrecoFinal({ mediaType: 'movie', duracaoMinutos: minutos }).precoFinal;
}

function formatTimeRemaining(expiresAt) {
  const now = new Date();
  const diff = expiresAt - now;
  if (diff <= 0) return '❌ EXPIRADO';
  const days = Math.floor(diff / (1000 * 60 * 60 * 24));
  const hours = Math.floor((diff % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));
  const minutes = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60));
  if (days > 0) return `⏰ ${days}d ${hours}h restantes`;
  if (hours > 0) return `⏰ ${hours}h ${minutes}m restantes`;
  return `⏰ ${minutes}m restantes`;
}

function isAdmin(userId) {
  return ADMIN_IDS.includes(userId);
}

// ============================
// SISTEMA DE REGISTRO
// ============================
async function verificarOuCriarUsuario(msg) {
  const userId = msg.from.id;
  const firstName = msg.from.first_name || 'Usuário';
  const lastName = msg.from.last_name || '';
  const username = msg.from.username || null;
  const languageCode = msg.from.language_code || 'pt-BR';
  const isPremium = msg.from.is_premium || false;

  try {
    if (!UserModel || typeof UserModel.findOne !== 'function') return null;

    let user = await UserModel.findOne({ userId });

    if (!user) {
      user = new UserModel({
        userId,
        firstName,
        lastName,
        username,
        credits: 0,
        isActive: true,
        isBlocked: false,
        registeredAt: new Date(),
        lastAccess: new Date(),
        metadata: { telegramLanguageCode: languageCode, isPremium }
      });
      await user.save();
      return { isNew: true, user };
    }

    user.lastAccess = new Date();
    user.firstName = firstName;
    user.lastName = lastName;
    user.username = username;
    await user.save();
    return { isNew: false, user };
  } catch (error) {
    console.error('Erro ao verificar/criar usuário:', error);
    return null;
  }
}

async function verificarBloqueio(userId) {
  try {
    const user = await UserModel.findOne({ userId });
    if (user && user.isBlocked) {
      return { blocked: true, reason: user.blockedReason || 'Sua conta foi bloqueada pelo administrador.' };
    }
    return { blocked: false };
  } catch (error) {
    console.error('Erro ao verificar bloqueio:', error);
    return { blocked: false };
  }
}

async function concederBonusInicialSeElegivel(user, isNewUser) {
  if (!isNewUser || !user || BONUS_INICIAL_NOVO_USUARIO <= 0) {
    return { granted: false, amount: 0 };
  }

  try {
    if (!UserModel || typeof UserModel.findOneAndUpdate !== 'function') {
      return { granted: false, amount: 0 };
    }

    const reservado = await UserModel.findOneAndUpdate(
      {
        userId: user.userId,
        'metadata.initialBonusGranted': { $ne: true }
      },
      {
        $set: {
          'metadata.initialBonusGranted': true,
          'metadata.initialBonusGrantedAt': new Date(),
          'metadata.initialBonusAmount': BONUS_INICIAL_NOVO_USUARIO
        }
      },
      { new: true }
    );

    if (!reservado) {
      return { granted: false, amount: 0 };
    }

    const creditado = await addCredits(user.userId, BONUS_INICIAL_NOVO_USUARIO);
    if (!creditado) {
      await UserModel.updateOne(
        { userId: user.userId },
        {
          $set: { 'metadata.initialBonusGranted': false },
          $unset: {
            'metadata.initialBonusGrantedAt': '',
            'metadata.initialBonusAmount': ''
          }
        }
      );
      return { granted: false, amount: 0 };
    }

    return { granted: true, amount: BONUS_INICIAL_NOVO_USUARIO };
  } catch (error) {
    console.error('Erro ao conceder bônus inicial:', error.message);
    return { granted: false, amount: 0 };
  }
}

async function getUserCredits(userId) {
  return await paymentAdapter.getUserCredits(userId);
}

function normalizeTitle(value) {
  return removerAcentos(String(value || '')).toLowerCase().trim();
}

function getPurchaseVisibilityFilter(extra = {}) {
  return {
    ...extra,
    source: { $ne: 'batch' },
    token: { $not: /^batch-/ }
  };
}

async function getOwnedMoviesSet(userId, ids) {
  if (!PurchasedContentModel || typeof PurchasedContentModel.find !== 'function') return new Set();
  const uniqueIds = Array.from(new Set((ids || []).map((id) => String(id))));
  if (uniqueIds.length === 0) return new Set();

  const rows = await PurchasedContentModel.find({
    userId,
    mediaType: 'movie',
    videoId: { $in: uniqueIds },
    ...getPurchaseVisibilityFilter({ expiresAt: { $gt: new Date() } })
  }).select('videoId');

  return new Set(rows.map((r) => String(r.videoId)));
}

async function getOwnedSeriesTitleSet(userId, titles) {
  if (!PurchasedContentModel || typeof PurchasedContentModel.find !== 'function') return new Set();
  const normalizedTitles = Array.from(new Set((titles || []).map((t) => normalizeTitle(t))));
  if (normalizedTitles.length === 0) return new Set();

  const rows = await PurchasedContentModel.find({
    userId,
    mediaType: 'series',
    ...getPurchaseVisibilityFilter({ expiresAt: { $gt: new Date() } })
  }).select('title');

  const owned = new Set();
  for (const row of rows) {
    const key = normalizeTitle(row.title);
    if (normalizedTitles.includes(key)) owned.add(key);
  }

  return owned;
}

async function getOwnedEpisodesSet(userId, title, season, episodeIds) {
  if (!PurchasedContentModel || typeof PurchasedContentModel.find !== 'function') return new Set();
  const ids = Array.from(new Set((episodeIds || []).map((id) => String(id))));
  if (ids.length === 0) return new Set();

  const rows = await PurchasedContentModel.find({
    userId,
    mediaType: 'series',
    title: String(title || ''),
    season: String(season || ''),
    videoId: { $in: ids },
    ...getPurchaseVisibilityFilter({ expiresAt: { $gt: new Date() } })
  }).select('videoId');

  return new Set(rows.map((r) => String(r.videoId)));
}

async function addCredits(userId, centavos) {
  return await paymentAdapter.addCredits(userId, centavos);
}

async function dispararCampanhaTelegram({ message, bonusAmount = 0, bonusLimit = 0, adminLabel = 'Admin' }) {
  if (!UserModel || typeof UserModel.find !== 'function') {
    throw new Error('Modelo de usuário indisponível');
  }

  const texto = String(message || '').trim();
  if (!texto) {
    throw new Error('Mensagem da campanha é obrigatória');
  }

  const bonusCentavos = Math.max(0, parseInt(String(bonusAmount || 0), 10) || 0);
  const bonusMax = Math.max(0, parseInt(String(bonusLimit || 0), 10) || 0);

  const usuarios = await UserModel.find({
    registeredAt: { $exists: true },
    isBlocked: { $ne: true }
  })
    .sort({ registeredAt: 1, userId: 1 })
    .select('userId firstName username registeredAt isActive isBlocked')
    .lean();

  let sentCount = 0;
  let failedCount = 0;
  let bonusGrantedCount = 0;
  const bonusWinners = [];

  for (const user of usuarios) {
    try {
      await bot.sendMessage(user.userId, texto, {
        parse_mode: 'Markdown',
        disable_web_page_preview: false
      });
      sentCount += 1;

      if (bonusCentavos > 0 && bonusGrantedCount < bonusMax) {
        await addCredits(user.userId, bonusCentavos);
        bonusGrantedCount += 1;
        bonusWinners.push({ userId: user.userId, username: user.username || null, firstName: user.firstName || null });

        await bot.sendMessage(
          user.userId,
          `🎁 *Você ganhou um bônus de ${formatMoney(bonusCentavos)}!*\n\nObrigado por testar a plataforma.`,
          { parse_mode: 'Markdown' }
        ).catch(() => {});
      }
    } catch (error) {
      failedCount += 1;
    }
  }

  return {
    adminLabel,
    totalRecipients: usuarios.length,
    sentCount,
    failedCount,
    bonusGrantedCount,
    bonusAmount: bonusCentavos,
    bonusWinners
  };
}

async function deductCredits(userId, centavos) {
  try {
    const user = await UserModel.findOne({ userId });
    if (!user || user.credits < centavos) return false;

    user.credits -= centavos;
    user.totalSpent += centavos;
    user.totalPurchases += 1;
    await user.save();
    return true;
  } catch (error) {
    console.error('Erro ao deduzir créditos:', error);
    return false;
  }
}

function gerarTokenAcesso(userId, videoId, mediaType) {
  try {
    const tempoSegundos = (mediaType === 'series' || mediaType === 'serie') ? 604800 : 86400;
    return jwt.sign(
      { userId, videoId, mediaType, exp: Math.floor(Date.now() / 1000) + tempoSegundos },
      JWT_SECRET
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

async function iniciarCacheComNotificacao(chatId, purchase, caption, mediaType) {
  if (!purchase || (mediaType !== 'movie' && mediaType !== 'series')) return;

  const token = purchase.token;
  const initialText = `⏳ *Estamos preparando seu conteúdo...*\n\nAguarde alguns minutos. Assim que estiver disponível, avisaremos aqui.`;
  const msg = await bot.sendMessage(chatId, initialText, { parse_mode: 'Markdown' }).catch(() => null);
  const messageId = msg?.message_id || null;

  const throttle = (tokenKey, percent) => {
    const last = cacheProgressByToken.get(tokenKey) || -1;
    if (percent === null) return false;
    if (percent === 100 || percent - last >= 5) {
      cacheProgressByToken.set(tokenKey, percent);
      return true;
    }
    return false;
  };

  bunnyCacheService.enqueue(purchase, {
    onProgress: (progress) => {
      const percent = typeof progress.percent === 'number' ? progress.percent : null;
      if (percent === null) return;

      if (!throttle(token, percent)) return;

      const text = `⏳ *Preparando seu conteúdo:* ${percent}%\n\nAguarde alguns minutos. Assim que estiver disponível, avisaremos aqui.`;
      if (messageId) {
        bot.editMessageText(text, { chat_id: chatId, message_id: messageId, parse_mode: 'Markdown' }).catch(() => {});
      }
    },
    onReady: () => {
      const text = `✅ *Conteúdo disponível!*\n\nVocê já pode assistir. Bom proveito!`;
      if (messageId) {
        bot.editMessageText(text, { chat_id: chatId, message_id: messageId, parse_mode: 'Markdown' }).catch(() => {});
      } else {
        bot.sendMessage(chatId, text, { parse_mode: 'Markdown' }).catch(() => {});
      }

      enviarVideoComLink(chatId, token, caption, 0, caption, mediaType).catch(() => {});
    },
    onError: () => {
      const text = `⚠️ *Falha ao preparar o conteúdo.*\nTente novamente em alguns minutos.`;
      if (messageId) {
        bot.editMessageText(text, { chat_id: chatId, message_id: messageId, parse_mode: 'Markdown' }).catch(() => {});
      } else {
        bot.sendMessage(chatId, text, { parse_mode: 'Markdown' }).catch(() => {});
      }
    }
  });
}

function clearUserState(chatId) {
  if (userStates[chatId]) delete userStates[chatId];
}

function setUserState(chatId, stateData) {
  userStates[chatId] = { ...stateData, updatedAt: Date.now() };
}

function showMainMenu(chatId, text = '🏠 *Menu Principal*') {
  bot.sendMessage(chatId, text, {
    parse_mode: 'Markdown',
    reply_markup: {
      keyboard: [
        ['🔍 Buscar Filmes', '📺 Buscar Séries'],
        ['📡 Canais ao Vivo', '🔎 Buscar Canais'],
        ['🎬 Filmes A-Z', '📺 Séries A-Z'],
        ['📦 Meu Conteúdo', '🔞 Conteúdo +18'],
        ['💰 Adicionar Créditos', '💳 Meu Saldo']
      ],
      resize_keyboard: true
    }
  }).catch(() => {});
}

function mostrarAlfabeto(chatId, tipo) {
  const alfabeto = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ#'.split('');
  const keyboard = [];
  for (let i = 0; i < alfabeto.length; i += 5) {
    const linha = alfabeto.slice(i, i + 5).map(letra => ({
      text: letra,
      callback_data: `letter_${tipo}_${letra}_1`
    }));
    keyboard.push(linha);
  }
  keyboard.push([{ text: '🏠 Menu Principal', callback_data: 'back_main' }]);
  const tipoTexto = tipo === 'movies' ? 'Filmes' : 'Séries';
  bot.sendMessage(chatId,
    `🔤 *${tipoTexto} por Letra*\n\nSelecione a primeira letra:`,
    { parse_mode: 'Markdown', reply_markup: { inline_keyboard: keyboard } }
  );
}

async function listarPorLetra(chatId, tipo, letra, pagina = 1) {
  try {
    const ITENS_POR_PAGINA = 20;
    await ensureCacheLoaded();

    const cache = getCacheSafe();
    const lista = cache[tipo] || [];
    const isAdulto = (nome) => /[\[\(]xxx|\+18|adulto|hentai|playboy|brasileirinhas/i.test(nome || '');

    let resultados;
    if (letra === '#') {
      resultados = lista.filter(i => !isAdulto(i.name) && /^[^a-zA-Z]/.test(decodificarHTML(i.name || '')));
    } else {
      resultados = lista.filter(i => !isAdulto(i.name) && decodificarHTML(i.name || '').toUpperCase().startsWith(letra));
    }

    const totalItens = resultados.length;
    const totalPaginas = Math.max(1, Math.ceil(totalItens / ITENS_POR_PAGINA));
    const paginaAtual = Math.min(Math.max(1, pagina), totalPaginas);
    const inicio = (paginaAtual - 1) * ITENS_POR_PAGINA;
    const fim = inicio + ITENS_POR_PAGINA;
    const itensPagina = resultados.slice(inicio, fim);

    if (totalItens === 0) {
      await bot.sendMessage(chatId,
        `❌ *Nenhum resultado encontrado com "${letra}"*`,
        {
          parse_mode: 'Markdown',
          reply_markup: {
            inline_keyboard: [
              [{ text: '🔤 Escolher Outra Letra', callback_data: `alphabet_${tipo}` }],
              [{ text: '🏠 Menu Principal', callback_data: 'back_main' }]
            ]
          }
        }
      );
      return;
    }

    // APLICANDO DECODER NOS BOTÕES A-Z
    let ownedMovieIds = new Set();
    if (tipo === 'movies') {
      ownedMovieIds = await getOwnedMoviesSet(chatId, itensPagina.map((r) => r.id));
    }

    const buttons = itensPagina.map(item => {
      const name = decodificarHTML(item.name || '');
      const owned = tipo === 'movies' ? ownedMovieIds.has(String(item.id)) : false;
      const prefix = owned ? '✅ ' : '';
      return [{
        text: `${prefix}${name.substring(0, 60)}${name.length > 60 ? '...' : ''}`,
        callback_data: `details_${item.id}_${tipo}`
      }];
    });

    const navRow = [];
    if (paginaAtual > 1) navRow.push({ text: '◀️ Anterior', callback_data: `letter_${tipo}_${letra}_${paginaAtual - 1}` });
    if (totalPaginas > 1) navRow.push({ text: `📄 ${paginaAtual}/${totalPaginas}`, callback_data: 'noop' });
    if (paginaAtual < totalPaginas) navRow.push({ text: 'Próximo ▶️', callback_data: `letter_${tipo}_${letra}_${paginaAtual + 1}` });
    if (navRow.length > 0) buttons.push(navRow);

    buttons.push([
      { text: '🔤 Outra Letra', callback_data: `alphabet_${tipo}` },
      { text: '🏠 Menu', callback_data: 'back_main' }
    ]);

    const tipoTexto = tipo === 'movies' ? 'Filmes' : 'Séries';
    const notice = tipo === 'movies'
      ? '\n\n✅ = você já possui (válido)'
      : '';

    await bot.sendMessage(
      chatId,
      `🔤 *${tipoTexto} - Letra "${letra}"*\n\n📋 Mostrando ${inicio + 1}-${Math.min(fim, totalItens)} de ${totalItens} resultado${totalItens > 1 ? 's' : ''}${notice}`,
      { parse_mode: 'Markdown', reply_markup: { inline_keyboard: buttons } }
    );
  } catch (error) {
    console.error('Erro ao listar por letra:', error);
    await bot.sendMessage(chatId, '❌ Erro ao buscar conteúdo. Tente novamente.');
  }
}

async function listarCanaisAoVivo(chatId, pagina = 1) {
  try {
    await ensureCacheLoaded();
    const cache = getCacheSafe();
    const canais = cache.livetv || [];

    if (canais.length === 0) {
      await bot.sendMessage(chatId,
        '❌ *Nenhum canal ao vivo disponível no momento.*',
        {
          parse_mode: 'Markdown',
          reply_markup: {
            inline_keyboard: [
              [{ text: '🔎 Buscar Canais', callback_data: 'search_livetv' }],
              [{ text: '🏠 Menu Principal', callback_data: 'back_main' }]
            ]
          }
        }
      );
      return;
    }

    const ITENS_POR_PAGINA = 20;
    const totalItens = canais.length;
    const totalPaginas = Math.max(1, Math.ceil(totalItens / ITENS_POR_PAGINA));
    const paginaAtual = Math.min(Math.max(1, pagina), totalPaginas);
    const inicio = (paginaAtual - 1) * ITENS_POR_PAGINA;
    const fim = inicio + ITENS_POR_PAGINA;
    const itensPagina = canais.slice(inicio, fim);

    const buttons = itensPagina.map((item) => {
      const name = decodificarHTML(item.name || `Canal ${item.id}`);
      return [{
        text: `📡 ${name.substring(0, 54)}${name.length > 54 ? '...' : ''}`,
        callback_data: `live_details_${item.id}`
      }];
    });

    const navRow = [];
    if (paginaAtual > 1) navRow.push({ text: '◀️ Anterior', callback_data: `livepage_${paginaAtual - 1}` });
    if (totalPaginas > 1) navRow.push({ text: `📄 ${paginaAtual}/${totalPaginas}`, callback_data: 'noop' });
    if (paginaAtual < totalPaginas) navRow.push({ text: 'Próximo ▶️', callback_data: `livepage_${paginaAtual + 1}` });
    if (navRow.length > 0) buttons.push(navRow);

    buttons.push([
      { text: '🔎 Buscar Canais', callback_data: 'search_livetv' },
      { text: '🏠 Menu', callback_data: 'back_main' }
    ]);

    await bot.sendMessage(
      chatId,
      `📡 *Canais ao Vivo*

💰 Valor fixo por canal: ${formatMoney(PRECO_LIVETV_FIXO)}
⏰ Validade do acesso: 24 horas

📋 Mostrando ${inicio + 1}-${Math.min(fim, totalItens)} de ${totalItens} canais`,
      { parse_mode: 'Markdown', reply_markup: { inline_keyboard: buttons } }
    );
  } catch (error) {
    console.error('Erro ao listar canais ao vivo:', error);
    await bot.sendMessage(chatId, '❌ Erro ao listar canais. Tente novamente.');
  }
}

function buscarCanaisPorTermo(canais = [], termo = '') {
  const termoBusca = removerAcentos(String(termo || '').trim());
  if (!termoBusca) return [];
  return canais.filter((item) => removerAcentos(item?.name || '').includes(termoBusca));
}

async function renderBuscaCanaisPaginada(chatId, termoOriginal, pagina = 1) {
  await ensureCacheLoaded();
  const cache = getCacheSafe();
  const canais = cache.livetv || [];
  const resultados = buscarCanaisPorTermo(canais, termoOriginal);

  if (resultados.length === 0) {
    await bot.sendMessage(chatId,
      `❌ *Nenhum canal encontrado para:* ${escaparMarkdownSeguro(termoOriginal)}\n\nTente outro termo.`,
      {
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [
            [{ text: '🔄 Buscar novamente', callback_data: 'retry_search_livetv' }],
            [{ text: '🏠 Menu Principal', callback_data: 'back_main' }]
          ]
        }
      }
    );
    return;
  }

  const ITENS_POR_PAGINA = 20;
  const totalItens = resultados.length;
  const totalPaginas = Math.max(1, Math.ceil(totalItens / ITENS_POR_PAGINA));
  const paginaAtual = Math.min(Math.max(1, pagina), totalPaginas);
  const inicio = (paginaAtual - 1) * ITENS_POR_PAGINA;
  const fim = inicio + ITENS_POR_PAGINA;
  const itensPagina = resultados.slice(inicio, fim);

  const buttons = itensPagina.map((item) => {
    const name = decodificarHTML(item.name || `Canal ${item.id}`);
    return [{
      text: `📡 ${name.substring(0, 54)}${name.length > 54 ? '...' : ''}`,
      callback_data: `live_details_${item.id}`
    }];
  });

  const navRow = [];
  if (paginaAtual > 1) navRow.push({ text: '◀️ Anterior', callback_data: `live_search_page_${paginaAtual - 1}` });
  if (totalPaginas > 1) navRow.push({ text: `📄 ${paginaAtual}/${totalPaginas}`, callback_data: 'noop' });
  if (paginaAtual < totalPaginas) navRow.push({ text: 'Próximo ▶️', callback_data: `live_search_page_${paginaAtual + 1}` });
  if (navRow.length > 0) buttons.push(navRow);

  buttons.push([
    { text: '🔎 Nova busca', callback_data: 'search_livetv' },
    { text: '📡 Lista completa', callback_data: 'list_livetv' }
  ]);
  buttons.push([{ text: '🏠 Menu Principal', callback_data: 'back_main' }]);

  await bot.sendMessage(
    chatId,
    `🔎 *Busca de Canais*\n\nTermo: *${escaparMarkdownSeguro(termoOriginal)}*\n💰 Valor fixo por canal: ${formatMoney(PRECO_LIVETV_FIXO)}\n⏰ Validade: 24 horas\n\n📋 Mostrando ${inicio + 1}-${Math.min(fim, totalItens)} de ${totalItens} resultados`,
    { parse_mode: 'Markdown', reply_markup: { inline_keyboard: buttons } }
  );
}

async function mostrarMeuConteudo(chatId) {
  try {
    if (!PurchasedContentModel || typeof PurchasedContentModel.find !== 'function') {
      await bot.sendMessage(chatId, '❌ Serviço temporariamente indisponível.');
      return;
    }

    await bot.sendMessage(chatId, '📦 Carregando seu conteúdo...');
    const conteudos = await PurchasedContentModel.find({
      userId: chatId,
      ...getPurchaseVisibilityFilter({ expiresAt: { $gt: new Date() } })
    }).sort({ purchaseDate: -1 });

    if (conteudos.length === 0) {
      await bot.sendMessage(chatId,
        `📦 *Meu Conteúdo*\n\nVocê ainda não comprou nenhum conteúdo.\n\n🎬 Explore filmes e séries no menu principal!`,
        {
          parse_mode: 'Markdown',
          reply_markup: {
            inline_keyboard: [
              [{ text: '🔍 Buscar Filmes', callback_data: 'search_movies' }],
              [{ text: '📺 Buscar Séries', callback_data: 'search_series' }],
              [{ text: '🏠 Menu Principal', callback_data: 'back_main' }]
            ]
          }
        }
      );
      return;
    }

    const groups = buildMeuConteudoGroups(conteudos);
    userStates[chatId] = {
      ...(userStates[chatId] || {}),
      myContent: groups,
      updatedAt: Date.now()
    };

    const buttons = [];
    if (groups.movies.length > 0) {
      buttons.push([{ text: `🎬 Filmes (${groups.movies.length})`, callback_data: 'mycontent_movies' }]);
    }
    if (groups.series.length > 0) {
      buttons.push([{ text: `📺 Séries (${groups.series.length})`, callback_data: 'mycontent_series' }]);
    }
    if (groups.livetv.length > 0) {
      buttons.push([{ text: `📡 Canais (${groups.livetv.length})`, callback_data: 'mycontent_live' }]);
    }

    buttons.push([{ text: '🏠 Menu Principal', callback_data: 'back_main' }]);

    await bot.sendMessage(chatId,
      `📦 *Meu Conteúdo*\n\n🎬 Filmes: ${groups.movies.length}\n📺 Séries: ${groups.series.length}\n📡 Canais: ${groups.livetv.length}\n\nSelecione uma categoria para ver seus itens.\n\n💡 *Dica:* Filmes e Canais expiram em 24h, Séries em 7 dias`,
      { parse_mode: 'Markdown', reply_markup: { inline_keyboard: buttons } }
    );
  } catch (error) {
    console.error('Erro ao mostrar conteúdo:', error);
    await bot.sendMessage(chatId, '❌ Erro ao carregar seu conteúdo. Tente novamente.');
  }
}

function buildMeuConteudoGroups(conteudos) {
  const movies = [];
  const livetv = [];
  const seriesMap = new Map();

  for (const item of conteudos) {
    const title = decodificarHTML(item.title || '') || item.title || '';
    const purchaseDate = item.purchaseDate ? new Date(item.purchaseDate) : new Date(0);
    if (item.mediaType === 'movie') {
      movies.push({ ...item.toObject?.() || item, title, purchaseDate });
      continue;
    }

    if (item.mediaType === 'livetv') {
      livetv.push({ ...item.toObject?.() || item, title, purchaseDate });
      continue;
    }

    const key = normalizeTitle(title || item.title || '');
    if (!seriesMap.has(key)) {
      seriesMap.set(key, {
        title: title || item.title || 'Série',
        seasons: new Map(),
        totalEpisodes: 0,
        lastPurchaseDate: purchaseDate
      });
    }

    const group = seriesMap.get(key);
    if (purchaseDate > group.lastPurchaseDate) group.lastPurchaseDate = purchaseDate;
    const seasonKey = String(item.season || '1');
    if (!group.seasons.has(seasonKey)) group.seasons.set(seasonKey, []);
    group.seasons.get(seasonKey).push({ ...item.toObject?.() || item, title, purchaseDate });
    group.totalEpisodes += 1;
  }

  movies.sort((a, b) => new Date(b.purchaseDate) - new Date(a.purchaseDate));
  livetv.sort((a, b) => new Date(b.purchaseDate) - new Date(a.purchaseDate));

  const series = Array.from(seriesMap.values()).sort((a, b) => {
    const diff = new Date(b.lastPurchaseDate) - new Date(a.lastPurchaseDate);
    if (diff !== 0) return diff;
    return String(a.title).localeCompare(String(b.title), 'pt-BR', { sensitivity: 'base' });
  });

  return { movies, livetv, series };
}

function paginateList(items, page = 1, perPage = 10) {
  const total = items.length;
  const totalPages = Math.max(1, Math.ceil(total / perPage));
  const current = Math.min(Math.max(1, page), totalPages);
  const start = (current - 1) * perPage;
  const end = start + perPage;
  return {
    items: items.slice(start, end),
    total,
    totalPages,
    current
  };
}

function buildPaginationRow(prefix, current, totalPages) {
  const row = [];
  if (current > 1) row.push({ text: '◀️ Anterior', callback_data: `${prefix}_${current - 1}` });
  if (totalPages > 1) row.push({ text: `📄 ${current}/${totalPages}`, callback_data: 'noop' });
  if (current < totalPages) row.push({ text: 'Próximo ▶️', callback_data: `${prefix}_${current + 1}` });
  return row;
}

async function mostrarMeuConteudoFilmes(chatId, page = 1) {
  const state = userStates[chatId]?.myContent;
  if (!state) return mostrarMeuConteudo(chatId);
  if (state.movies.length === 0) {
    await bot.sendMessage(chatId, '🎬 Você não tem filmes disponíveis.', {
      reply_markup: { inline_keyboard: [[{ text: '📦 Voltar ao Meu Conteúdo', callback_data: 'my_content' }]] }
    });
    return;
  }

  const pageData = paginateList(state.movies, page, 10);
  const buttons = pageData.items.map((item) => {
    const nome = decodificarHTML(item.title || '');
    const timer = formatTimeRemaining(item.expiresAt);
    return [{
      text: `🎬 ${nome.substring(0, 45)} | ${timer}`,
      callback_data: `mycontent_${item._id}`
    }];
  });

  const navRow = buildPaginationRow('mycontent_movies_page', pageData.current, pageData.totalPages);
  if (navRow.length > 0) buttons.push(navRow);

  buttons.push([{ text: '📦 Voltar ao Meu Conteúdo', callback_data: 'my_content' }]);

  await bot.sendMessage(chatId,
    `🎬 *Meus Filmes*\n\nTotal: ${pageData.total}`,
    { parse_mode: 'Markdown', reply_markup: { inline_keyboard: buttons } }
  );
}

async function mostrarMeuConteudoLive(chatId, page = 1) {
  const state = userStates[chatId]?.myContent;
  if (!state) return mostrarMeuConteudo(chatId);
  if (state.livetv.length === 0) {
    await bot.sendMessage(chatId, '📡 Você não tem canais disponíveis.', {
      reply_markup: { inline_keyboard: [[{ text: '📦 Voltar ao Meu Conteúdo', callback_data: 'my_content' }]] }
    });
    return;
  }

  const pageData = paginateList(state.livetv, page, 10);
  const buttons = pageData.items.map((item) => {
    const nome = decodificarHTML(item.title || '');
    const timer = formatTimeRemaining(item.expiresAt);
    return [{
      text: `📡 ${nome.substring(0, 45)} | ${timer}`,
      callback_data: `mycontent_${item._id}`
    }];
  });

  const navRow = buildPaginationRow('mycontent_live_page', pageData.current, pageData.totalPages);
  if (navRow.length > 0) buttons.push(navRow);

  buttons.push([{ text: '📦 Voltar ao Meu Conteúdo', callback_data: 'my_content' }]);

  await bot.sendMessage(chatId,
    `📡 *Meus Canais*\n\nTotal: ${pageData.total}`,
    { parse_mode: 'Markdown', reply_markup: { inline_keyboard: buttons } }
  );
}

async function mostrarMeuConteudoSeries(chatId, page = 1) {
  const state = userStates[chatId]?.myContent;
  if (!state) return mostrarMeuConteudo(chatId);
  if (state.series.length === 0) {
    await bot.sendMessage(chatId, '📺 Você não tem séries disponíveis.', {
      reply_markup: { inline_keyboard: [[{ text: '📦 Voltar ao Meu Conteúdo', callback_data: 'my_content' }]] }
    });
    return;
  }

  const pageData = paginateList(state.series, page, 10);
  const buttons = pageData.items.map((serie, index) => {
    const nome = decodificarHTML(serie.title || '');
    return [{
      text: `📺 ${nome.substring(0, 45)} (${serie.totalEpisodes} ep)`,
      callback_data: `myseries_${(pageData.current - 1) * 10 + index}`
    }];
  });

  const navRow = buildPaginationRow('mycontent_series_page', pageData.current, pageData.totalPages);
  if (navRow.length > 0) buttons.push(navRow);

  buttons.push([{ text: '📦 Voltar ao Meu Conteúdo', callback_data: 'my_content' }]);

  await bot.sendMessage(chatId,
    `📺 *Minhas Séries*\n\nSelecione uma série para ver temporadas e episódios.`,
    { parse_mode: 'Markdown', reply_markup: { inline_keyboard: buttons } }
  );
}

async function mostrarMeuConteudoSerieDetalhes(chatId, index, page = 1) {
  const state = userStates[chatId]?.myContent;
  if (!state) return mostrarMeuConteudo(chatId);
  const serie = state.series[index];
  if (!serie) return mostrarMeuConteudoSeries(chatId);

  const seasonKeys = Array.from(serie.seasons.keys()).sort((a, b) => {
    const na = Number.parseInt(a, 10);
    const nb = Number.parseInt(b, 10);
    const bothNumeric = !Number.isNaN(na) && !Number.isNaN(nb);
    if (bothNumeric) return na - nb;
    return String(a).localeCompare(String(b), 'pt-BR', { sensitivity: 'base' });
  });

  const episodeEntries = [];
  for (const seasonKey of seasonKeys) {
    const episodes = serie.seasons.get(seasonKey) || [];
    episodes.sort((a, b) => {
      const dateDiff = new Date(a.purchaseDate || 0) - new Date(b.purchaseDate || 0);
      if (dateDiff !== 0) return dateDiff;
      const nameA = String(a.episodeName || '');
      const nameB = String(b.episodeName || '');
      return nameA.localeCompare(nameB, 'pt-BR', { sensitivity: 'base' });
    });

    for (const episode of episodes) {
      const epName = episode.episodeName ? decodificarHTML(episode.episodeName) : 'Episódio';
      episodeEntries.push({
        season: seasonKey,
        label: `▶️ ${epName}`,
        expiresAt: episode.expiresAt,
        id: episode._id
      });
    }
  }

  const pageData = paginateList(episodeEntries, page, 10);
  const buttons = [];

  let currentSeason = null;
  for (const entry of pageData.items) {
    if (entry.season !== currentSeason) {
      currentSeason = entry.season;
      buttons.push([{ text: `📂 Temporada ${currentSeason}`, callback_data: 'noop' }]);
    }

    const timer = formatTimeRemaining(entry.expiresAt);
    const label = `${entry.label} | ${timer}`;
    buttons.push([{ text: label.substring(0, 60), callback_data: `mycontent_${entry.id}` }]);
  }

  const navRow = buildPaginationRow(`myseries_${index}_page`, pageData.current, pageData.totalPages);
  if (navRow.length > 0) buttons.push(navRow);

  buttons.push([{ text: '📺 Voltar às Séries', callback_data: 'mycontent_series' }]);
  buttons.push([{ text: '📦 Voltar ao Meu Conteúdo', callback_data: 'my_content' }]);

  await bot.sendMessage(chatId,
    `📺 *${escaparMarkdownSeguro(serie.title)}*\n\n${serie.totalEpisodes} episódio${serie.totalEpisodes > 1 ? 's' : ''} disponível${serie.totalEpisodes > 1 ? 'is' : ''}.`,
    { parse_mode: 'Markdown', reply_markup: { inline_keyboard: buttons } }
  );
}

async function mostrarDetalhesConteudo(chatId, contentId) {
  try {
    if (!PurchasedContentModel || typeof PurchasedContentModel.findById !== 'function') {
      await bot.sendMessage(chatId, '❌ Serviço temporariamente indisponível.');
      return;
    }

    const content = await PurchasedContentModel.findById(contentId);
    if (!content) {
      await bot.sendMessage(chatId, '❌ Conteúdo não encontrado.');
      return;
    }

    if (new Date() > content.expiresAt) {
      await bot.sendMessage(chatId,
        `⏰ *Link Expirado*\n\nEste conteúdo expirou.\n\nVocê pode comprá-lo novamente se desejar assistir.`,
        {
          parse_mode: 'Markdown',
          reply_markup: {
            inline_keyboard: [
              [{ text: '📦 Voltar ao Meu Conteúdo', callback_data: 'my_content' }],
              [{ text: '🏠 Menu Principal', callback_data: 'back_main' }]
            ]
          }
        }
      );
      return;
    }

    const playerUrl = `${DOMINIO_PUBLICO}/player/${content.token}`;
    const timeRemaining = formatTimeRemaining(content.expiresAt);
    const emoji = content.mediaType === 'movie' ? '🎬' : (content.mediaType === 'livetv' ? '📡' : '📺');

    const mensagem =
      `${emoji} *${escaparMarkdownSeguro(content.title)}*\n\n` +
      (content.episodeName ? `📺 ${escaparMarkdownSeguro(content.episodeName)}\n\n` : '') +
      `💰 Preço pago: ${formatMoney(content.price)}\n` +
      `📅 Comprado em: ${new Date(content.purchaseDate).toLocaleDateString('pt-BR', {
        day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit'
      })}\n` +
      `👁️ Visualizações: ${content.viewCount}\n` +
      `${timeRemaining}\n\n` +
      `🎯 *Clique em "▶️ Assistir" para abrir o player!*`;


      const coverUrl = toTelegramUrl(
        toAbsoluteUrl(detalhes.coverUrl || detalhes.capa_url || detalhes.capa || '')
      );
      if (coverUrl) {
        logger.info({
          msg: 'Enviando capa dos detalhes',
          chatId,
          title: detalhes.title,
          coverUrl
        });

        try {
          await bot.sendPhoto(chatId, coverUrl, {
            caption: detalhes.title ? ` ${detalhes.title}` : ' Detalhes do conteúdo'
          });
        } catch (error) {
          logger.warn({
            msg: 'Falha ao enviar capa dos detalhes',
            chatId,
            title: detalhes.title,
            error: error.message
          });
        }
      } else {
        logger.info({
          msg: 'Detalhes sem capa para enviar',
          chatId,
          title: detalhes.title
        });
      }

    await bot.sendMessage(chatId, mensagem, {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [
          [{ text: '▶️ Assistir Agora', url: playerUrl }],
          [{ text: '📦 Voltar ao Meu Conteúdo', callback_data: 'my_content' }],
          [{ text: '🏠 Menu Principal', callback_data: 'back_main' }]
        ]
      }
    });
  } catch (error) {
    console.error('Erro ao mostrar detalhes do conteúdo:', error);
    await bot.sendMessage(chatId, '❌ Erro ao carregar detalhes. Tente novamente.');
  }
}

async function enviarVideoComLink(chatId, token, caption, precoNum, videoInfo, mediaType = 'movie') {
  try {
    const playerUrl = `${DOMINIO_PUBLICO}/player/${token}`;
    const tempoValido = mediaType === 'series' ? '7 dias' : '24 horas';
    const emoji = mediaType === 'movie' ? '🎬' : (mediaType === 'livetv' ? '📡' : '📺');

    await bot.sendMessage(chatId,
      `✅ *Conteúdo Liberado!*\n\n${escaparMarkdownSeguro(caption)}\n\n${emoji} *Como assistir:*\n1. Clique no botão "▶️ Assistir Agora"\n2. O vídeo abrirá no seu navegador\n3. Assista em tela cheia!\n\n⏰ *Link válido por ${tempoValido}*\n📦 Salvo em "Meu Conteúdo"\n🔒 Link protegido por DRM`,
      {
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [
            [{ text: '▶️ Assistir Agora', url: playerUrl }],
            [{ text: '📦 Meu Conteúdo', callback_data: 'my_content' }],
            [{ text: '🏠 Menu Principal', callback_data: 'back_main' }]
          ]
        }
      }
    );
    return true;
  } catch (error) {
    console.error(`❌ Erro ao enviar link ${videoInfo}:`, error.message);
    await addCredits(chatId, precoNum);
    const saldoRestaurado = await getUserCredits(chatId);
    await bot.sendMessage(chatId,
      `❌ *Erro ao Enviar Conteúdo*\n\n💰 Créditos devolvidos: ${formatMoney(precoNum)}\n💳 Saldo atual: ${formatMoney(saldoRestaurado)}`,
      { parse_mode: 'Markdown' }
    );
    return false;
  }
}

// ============================
// SISTEMA DE PAGAMENTO PIX
// ============================
async function criarPagamentoPix(userId, valorCentavos) {
  return await paymentAdapter.criarPagamentoPix(userId, valorCentavos);
}

function startPaymentVerification(paymentId, userId) {
  if (paymentCheckIntervals[paymentId]) clearInterval(paymentCheckIntervals[paymentId]);

  let attempts = 0;
  const maxAttempts = 120;

  paymentCheckIntervals[paymentId] = setInterval(async () => {
    attempts++;
    try {
      const status = await checkPaymentStatus(paymentId);
      if (status === 'approved') {
        clearInterval(paymentCheckIntervals[paymentId]);
        delete paymentCheckIntervals[paymentId];
      } else if (status === 'cancelled' || status === 'rejected' || attempts >= maxAttempts) {
        clearInterval(paymentCheckIntervals[paymentId]);
        delete paymentCheckIntervals[paymentId];
        if (pendingPayments[paymentId]) {
          bot.sendMessage(userId, '⏰ O pagamento expirou ou foi cancelado. Tente novamente se desejar adicionar créditos.').catch(() => {});
          delete pendingPayments[paymentId];
        }
      }
    } catch (error) {
      console.error(`Erro ao verificar pagamento ${paymentId}:`, error.message);
    }
  }, 5000);
}

async function checkPaymentStatus(paymentId) {
  return await paymentAdapter.checkPaymentStatus(paymentId);
}

async function processarPagamentoAprovado(paymentId, userId, amount) {
  return await paymentAdapter.processarPagamentoAprovado(paymentId, userId, amount);
}

// ============================
// SISTEMA DE NOTIFICAÇÕES
// ============================
async function verificarConteudosExpirando() {
  try {
    if (!PurchasedContentModel || typeof PurchasedContentModel.find !== 'function') return;
    if (!UserModel || typeof UserModel.findOne !== 'function') return;

    const agora = new Date();
    const daquiA2Horas = new Date(agora.getTime() + (2 * 60 * 60 * 1000));
    const daquiA24Horas = new Date(agora.getTime() + (24 * 60 * 60 * 1000));

    const filmesExpirando = await PurchasedContentModel.find({
      mediaType: 'movie',
      ...getPurchaseVisibilityFilter({ expiresAt: { $gt: agora, $lte: daquiA2Horas } }),
      notificationSent: false
    });

    const seriesExpirando = await PurchasedContentModel.find({
      mediaType: 'series',
      ...getPurchaseVisibilityFilter({ expiresAt: { $gt: agora, $lte: daquiA24Horas } }),
      notificationSent: false
    });

    const canaisExpirando = await PurchasedContentModel.find({
      mediaType: 'livetv',
      ...getPurchaseVisibilityFilter({ expiresAt: { $gt: agora, $lte: daquiA2Horas } }),
      notificationSent: false
    });

    const todosExpirando = [...filmesExpirando, ...seriesExpirando, ...canaisExpirando];

    for (const content of todosExpirando) {
      try {
        const user = await UserModel.findOne({ userId: content.userId });

        if (!user || !user.notificationsEnabled) {
          content.notificationSent = true;
          await content.save();
          continue;
        }

        const timeRemaining = formatTimeRemaining(content.expiresAt);
        const playerUrl = `${DOMINIO_PUBLICO}/player/${content.token}`;
        const nomeCompleto = content.episodeName ? `${content.title} - ${content.episodeName}` : content.title;
        const emoji = content.mediaType === 'movie' ? '🎬' : (content.mediaType === 'livetv' ? '📡' : '📺');
        const tipo = content.mediaType === 'movie' ? 'Filme' : (content.mediaType === 'livetv' ? 'Canal' : 'Episódio');

        await bot.sendMessage(
          content.userId,
          `⏰ *${tipo} Expirando em Breve!*\n\n${emoji} *${escaparMarkdownSeguro(nomeCompleto)}*\n\n${timeRemaining}\n\n⚠️ Assista agora antes que expire!`,
          {
            parse_mode: 'Markdown',
            reply_markup: {
              inline_keyboard: [
                [{ text: '▶️ Assistir Agora', url: playerUrl }],
                [{ text: '📦 Meu Conteúdo', callback_data: 'my_content' }]
              ]
            }
          }
        );

        content.notificationSent = true;
        await content.save();
      } catch (error) {
        if (error.response?.body?.error_code === 403) {
          content.notificationSent = true;
          await content.save();
        } else {
          console.error(`Erro ao enviar notificação para ${content.userId}:`, error.message);
        }
      }
    }
  } catch (error) {
    console.error('Erro ao verificar conteúdos expirando:', error);
  }
}

// ============================
// COMANDOS DO BOT
// ============================

// Comando: Retentar download de conteúdo falhado
bot.onText(/\/requeue_(.+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  const purchaseId = match[1];

  try {
    if (!PurchasedContentModel) {
      await bot.sendMessage(chatId, '❌ Sistema indisponível. Tente novamente.');
      return;
    }

    const purchase = await PurchasedContentModel.findById(purchaseId);
    if (!purchase) {
      await bot.sendMessage(chatId, '❌ Conteúdo não encontrado.');
      return;
    }

    if (purchase.userId !== msg.from.id) {
      await bot.sendMessage(chatId, '❌ Você não tem permissão para retentar este conteúdo.');
      return;
    }

    // Reset cache status e reenfileira
    await purchase.updateOne({
      $set: {
        cacheStatus: 'pending',
        cacheProgress: 0,
        cacheError: null,
        cacheUpdatedAt: new Date()
      }
    });

    bunnyCacheService.enqueue(purchase, {
      onProgress: ({ percent, stage }) => {
        cacheProgressByToken.set(purchase._id.toString(), percent);
      },
      onReady: ({ storagePath }) => {
        // Send success message with video link
        enviarVideoComLink(chatId, purchase.token, purchase.title || 'Conteúdo', 0, purchase.title || 'Conteúdo', purchase.mediaType).catch((err) => {
          console.error('Erro ao enviar link após requeue:', err);
        });
      },
      onError: (error) => {
        notificarFalhaCacheAoUsuario(chatId, purchase);
      }
    });

    await bot.sendMessage(
      chatId,
      `♻️ *Download retentando*\n\n${sanitizarTexto(purchase.title || 'Conteúdo')}\n\nVocê será notificado quando estiver pronto.`,
      { parse_mode: 'Markdown' }
    );
  } catch (error) {
    console.error('Erro ao requeue:', error);
    await bot.sendMessage(chatId, '❌ Erro ao retentar. Tente novamente.');
  }
});

bot.onText(/\/start/, async (msg) => {
  const chatId = msg.chat.id;

  try {
    await ensureCacheLoaded();

    const resultado = await verificarOuCriarUsuario(msg);
    if (!resultado) {
      bot.sendMessage(chatId, '❌ Erro ao acessar o sistema. Tente novamente em alguns instantes.');
      return;
    }

    const { isNew, user } = resultado;
    const bloqueio = await verificarBloqueio(chatId);

    if (bloqueio.blocked) {
      bot.sendMessage(chatId,
        `🚫 *Acesso Bloqueado*\n\n${escaparMarkdownSeguro(bloqueio.reason)}\n\nEntre em contato com o suporte.`,
        { parse_mode: 'Markdown' }
      );
      return;
    }

    clearUserState(chatId);
    setUserState(chatId, { step: 'menu' });

    const bonusInfo = await concederBonusInicialSeElegivel(user, isNew);

    const cache = getCacheSafe();
    const totalFilmes = cache.movies.length;
    const totalSeries = cache.series.length;
    const totalCanais = (cache.livetv || []).length;
    const totalConteudo = totalFilmes + totalSeries + totalCanais;
    const saldo = await getUserCredits(chatId);
    const nomeSeguro = sanitizarTexto(user.firstName);

    const bonusMensagem = bonusInfo.granted
      ? `\n\n🎁 *Bônus de Boas-Vindas Liberado Hoje!*\nVocê recebeu ${formatMoney(bonusInfo.amount)} em créditos iniciais para começar agora.`
      : '';

    const welcome = isNew
      ? `🎉 *Bem-vindo ao FastTV, ${nomeSeguro}!*\n\n✅ Conta criada com sucesso!\n\n📊 Catálogo:\n🎥 ${totalFilmes.toLocaleString('pt-BR')} filmes\n📺 ${totalSeries.toLocaleString('pt-BR')} séries\n📡 ${totalCanais.toLocaleString('pt-BR')} canais ao vivo\n📦 ${totalConteudo.toLocaleString('pt-BR')} conteúdos\n\n💰 Saldo: ${formatMoney(saldo)}${bonusMensagem}`
      : `🎬 *Bem-vindo de volta, ${nomeSeguro}!*\n\n📊 Catálogo:\n🎥 ${totalFilmes.toLocaleString('pt-BR')} filmes\n📺 ${totalSeries.toLocaleString('pt-BR')} séries\n📡 ${totalCanais.toLocaleString('pt-BR')} canais ao vivo\n📦 ${totalConteudo.toLocaleString('pt-BR')} conteúdos\n\n💰 Saldo: ${formatMoney(saldo)}`;

    showMainMenu(chatId, welcome);
  } catch (error) {
    console.error('Erro no comando /start:', error);
    bot.sendMessage(chatId, '❌ Erro ao iniciar. Tente novamente com /start');
  }
});

bot.onText(/\/saldo/, async (msg) => {
  const chatId = msg.chat.id;
  try {
    const saldo = await getUserCredits(chatId);
    bot.sendMessage(chatId, `💰 *Seu Saldo*\n\nSaldo disponível: ${formatMoney(saldo)}`, {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [
          [{ text: '💰 Adicionar Créditos', callback_data: 'menu_add_credits' }],
          [{ text: '🏠 Menu Principal', callback_data: 'back_main' }]
        ]
      }
    });
  } catch (error) {
    bot.sendMessage(chatId, '❌ Erro ao consultar saldo.');
  }
});

bot.onText(/🎬 Filmes A-Z/, (msg) => mostrarAlfabeto(msg.chat.id, 'movies'));
bot.onText(/📺 Séries A-Z/, (msg) => mostrarAlfabeto(msg.chat.id, 'series'));
bot.onText(/📦 Meu Conteúdo/, async (msg) => mostrarMeuConteudo(msg.chat.id));
bot.onText(/📡 Canais ao Vivo/, async (msg) => listarCanaisAoVivo(msg.chat.id, 1));

bot.onText(/🔍 Buscar Filmes/, (msg) => {
  const chatId = msg.chat.id;
  setUserState(chatId, { step: 'search_movies' });
  bot.sendMessage(chatId, '🎬 *Buscar Filmes*\n\nDigite o nome do filme:', {
    parse_mode: 'Markdown',
    reply_markup: { inline_keyboard: [[{ text: '⬅️ Voltar', callback_data: 'back_main' }]] }
  });
});

bot.onText(/📺 Buscar Séries/, (msg) => {
  const chatId = msg.chat.id;
  setUserState(chatId, { step: 'search_series' });
  bot.sendMessage(chatId, '📺 *Buscar Séries*\n\nDigite o nome da série:', {
    parse_mode: 'Markdown',
    reply_markup: { inline_keyboard: [[{ text: '⬅️ Voltar', callback_data: 'back_main' }]] }
  });
});

bot.onText(/🔎 Buscar Canais/, (msg) => {
  const chatId = msg.chat.id;
  setUserState(chatId, { step: 'search_livetv' });
  bot.sendMessage(chatId, '📡 *Buscar Canais ao Vivo*\n\nDigite o nome do canal (ex: Globo):', {
    parse_mode: 'Markdown',
    reply_markup: { inline_keyboard: [[{ text: '⬅️ Voltar', callback_data: 'back_main' }]] }
  });
});

bot.onText(/🔞 Conteúdo \+18/, (msg) => {
  const chatId = msg.chat.id;
  setUserState(chatId, { step: 'search_adult' });
  bot.sendMessage(chatId,
    '🔞 *Conteúdo Adulto*\n\nDigite o termo de busca:',
    { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: '⬅️ Voltar', callback_data: 'back_main' }]] } }
  );
});

bot.onText(/💳 Meu Saldo/, async (msg) => {
  const chatId = msg.chat.id;
  const saldo = await getUserCredits(chatId);
  bot.sendMessage(chatId, `💰 *Seu Saldo*\n\nSaldo disponível: ${formatMoney(saldo)}`, {
    parse_mode: 'Markdown',
    reply_markup: { inline_keyboard: [[{ text: '💰 Adicionar Créditos', callback_data: 'menu_add_credits' }], [{ text: '🏠 Voltar', callback_data: 'back_main' }]] }
  });
});

bot.onText(/💰 Adicionar Créditos/, (msg) => mostrarOpcoesCredito(msg.chat.id));

function mostrarOpcoesCredito(chatId) {
  const valores = [
    { label: 'R$ 5,00', value: 500 },
    { label: 'R$ 10,00', value: 1000 },
    { label: 'R$ 25,00', value: 2500 },
    { label: 'R$ 50,00', value: 5000 },
    { label: 'R$ 100,00', value: 10000 }
  ];
  const keyboard = valores.map(v => [{ text: `${v.label} - ${Math.floor((v.value / PRECO_POR_HORA) * 10) / 10}h`, callback_data: `add_${v.value}` }]);
  keyboard.push([{ text: '⬅️ Voltar', callback_data: 'back_main' }]);

  bot.sendMessage(chatId, `💰 *Adicionar Créditos*\n\nEscolha o valor:`, {
    parse_mode: 'Markdown',
    reply_markup: { inline_keyboard: keyboard }
  });
}

// ============================
// PROCESSAMENTO DE MENSAGENS (BUSCA)
// ============================
bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  const text = msg.text;
  if (!text || text.startsWith('/') || /🔍|🔎|📺|📡|🔞|💰|💳|🎬|📦/.test(text)) return;

  const state = userStates[chatId];
  if (!state || !['search_movies', 'search_series', 'search_adult', 'search_livetv', 'search_livetv_results'].includes(state.step)) return;

  try {
    const loadingMsg = await bot.sendMessage(chatId, '🔍 Buscando...');
    await ensureCacheLoaded();
    const cache = getCacheSafe();

    const termoBusca = removerAcentos(text);
    const isAdulto = (nome) => /[\[\(]xxx|\+18|adulto|hentai|playboy|brasileirinhas/i.test(nome || '');
    let resultados = [];

    if (state.step === 'search_adult') {
      const todosItens = [...(cache.movies || []), ...(cache.series || [])];
      resultados = todosItens.filter(i => isAdulto(i.name) && removerAcentos(i.name || '').includes(termoBusca)).slice(0, 15);
    } else if (state.step === 'search_livetv' || state.step === 'search_livetv_results') {
      setUserState(chatId, { step: 'search_livetv_results', liveSearchTerm: text });
      bot.deleteMessage(chatId, loadingMsg.message_id).catch(() => {});
      await renderBuscaCanaisPaginada(chatId, text, 1);
      return;
    } else {
      const lista = cache[state.step === 'search_movies' ? 'movies' : 'series'] || [];
      resultados = lista.filter(i => !isAdulto(i.name) && removerAcentos(i.name || '').includes(termoBusca)).slice(0, 15);
    }

    bot.deleteMessage(chatId, loadingMsg.message_id).catch(() => {});

    if (resultados.length === 0) {
      bot.sendMessage(chatId,
        `❌ *Nenhum resultado encontrado*\n\nTente buscar com outro termo.`,
        {
          parse_mode: 'Markdown',
          reply_markup: {
            inline_keyboard: [
              [{ text: '🔄 Buscar novamente', callback_data: `retry_${state.step === 'search_livetv_results' ? 'search_livetv' : state.step}` }],
              [{ text: '🏠 Menu Principal', callback_data: 'back_main' }]
            ]
          }
        }
      );
      return;
    }

    // APLICANDO DECODER NOS BOTÕES DE RESULTADO DE BUSCA
    let ownedMovieIds = new Set();

    if (state.step === 'search_movies') {
      ownedMovieIds = await getOwnedMoviesSet(chatId, resultados.map((r) => r.id));
    }

    const buttons = resultados.map(item => {
      const name = decodificarHTML(item.name || '');
      if (state.step === 'search_livetv') {
        return [{ text: `📡 ${name.substring(0, 54)}${name.length > 54 ? '...' : ''}`, callback_data: `live_details_${item.id}` }];
      }
      // Determinador de tipo: usar state.step ao invés de cache.movies (que era errado)
      const tipo = state.step === 'search_movies' ? 'movies' : state.step === 'search_adult' ? 'movies' : 'series';
      const owned = tipo === 'movies' ? ownedMovieIds.has(String(item.id)) : false;
      const prefix = owned ? '✅ ' : '';
      return [{ text: `${prefix}${name.substring(0, 60)}${name.length > 60 ? '...' : ''}`, callback_data: `details_${item.id}_${tipo}` }];
    });
    buttons.push([{ text: '🏠 Menu Principal', callback_data: 'back_main' }]);

    const notice = state.step === 'search_movies'
      ? '\n\n✅ = você já possui (válido)'
      : '';

    bot.sendMessage(chatId,
      `📋 *${resultados.length} resultado${resultados.length > 1 ? 's' : ''} encontrado${resultados.length > 1 ? 's' : ''}:*\n\nSelecione para ver detalhes:${notice}`,
      { parse_mode: 'Markdown', reply_markup: { inline_keyboard: buttons } }
    );
  } catch (error) {
    console.error('Erro ao processar busca:', error);
    bot.sendMessage(chatId, '❌ Erro ao realizar busca.');
  }
});


// ============================
// CALLBACK QUERIES (BOTÕES)
// ============================

bot.on('callback_query', async (query) => {
  const chatId = query.message.chat.id;
  const data = query.data;
  const msgId = query.message.message_id;

  try {
    // callback debug desativado

    if (data === 'noop') { bot.answerCallbackQuery(query.id); return; }

    if (data === 'back_main') {
      bot.answerCallbackQuery(query.id);
      bot.deleteMessage(chatId, msgId).catch(() => {});
      clearUserState(chatId);
      showMainMenu(chatId);
      return;
    }

    if (data.startsWith('retry_')) {
      const step = data.replace('retry_', '');
      setUserState(chatId, { step });
      bot.answerCallbackQuery(query.id);
      bot.deleteMessage(chatId, msgId).catch(() => {});
      bot.sendMessage(
        chatId,
        step === 'search_movies'
          ? '🎬 Digite o nome do filme:'
          : step === 'search_series'
            ? '📺 Digite o nome da série:'
            : step === 'search_livetv'
              ? '📡 Digite o nome do canal:'
              : '🔞 Digite o termo de busca:'
      );
      return;
    }

    if (data === 'search_livetv') {
      setUserState(chatId, { step: 'search_livetv' });
      bot.answerCallbackQuery(query.id);
      bot.deleteMessage(chatId, msgId).catch(() => {});
      bot.sendMessage(chatId, '📡 *Buscar Canais ao Vivo*\n\nDigite o nome do canal (ex: Globo):', {
        parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: [[{ text: '⬅️ Voltar', callback_data: 'back_main' }]] }
      });
      return;
    }

    if (data === 'list_livetv') {
      bot.answerCallbackQuery(query.id);
      bot.deleteMessage(chatId, msgId).catch(() => {});
      await listarCanaisAoVivo(chatId, 1);
      return;
    }

    if (data.startsWith('livepage_')) {
      const pagina = parseInt(data.split('_')[1], 10) || 1;
      bot.answerCallbackQuery(query.id);
      bot.deleteMessage(chatId, msgId).catch(() => {});
      await listarCanaisAoVivo(chatId, pagina);
      return;
    }

    if (data.startsWith('live_search_page_')) {
      const pagina = parseInt(data.split('_')[3], 10) || 1;
      const state = userStates[chatId];
      const termo = state?.liveSearchTerm || '';

      bot.answerCallbackQuery(query.id);
      bot.deleteMessage(chatId, msgId).catch(() => {});

      if (!termo) {
        setUserState(chatId, { step: 'search_livetv' });
        await bot.sendMessage(chatId, '📡 *Buscar Canais ao Vivo*\n\nDigite o nome do canal (ex: Globo):', {
          parse_mode: 'Markdown',
          reply_markup: { inline_keyboard: [[{ text: '⬅️ Voltar', callback_data: 'back_main' }]] }
        });
        return;
      }

      setUserState(chatId, { step: 'search_livetv_results', liveSearchTerm: termo });
      await renderBuscaCanaisPaginada(chatId, termo, pagina);
      return;
    }

    if (data.startsWith('live_details_')) {
      const id = data.replace('live_details_', '');
      bot.answerCallbackQuery(query.id, { text: 'Carregando canal...' });
      bot.deleteMessage(chatId, msgId).catch(() => {});

      await ensureCacheLoaded();
      const cache = getCacheSafe();
      const canal = (cache.livetv || []).find((item) => String(item.id) === String(id));

      if (!canal) {
        await bot.sendMessage(chatId, '❌ Canal não encontrado. Atualize e tente novamente.');
        return;
      }

      const saldoAtual = await getUserCredits(chatId);
      const nomeCanal = decodificarHTML(canal.name || `Canal ${id}`);
      const mensagem =
        `📡 *${escaparMarkdownSeguro(nomeCanal)}*\n\n` +
        `💰 Preço fixo: ${formatMoney(PRECO_LIVETV_FIXO)}\n` +
        `⏰ Validade do acesso: 24 horas\n` +
        `💳 Seu saldo: ${formatMoney(saldoAtual)}`;

      const keyboard = [];
      if (saldoAtual < PRECO_LIVETV_FIXO) {
        keyboard.push([{ text: '💰 Adicionar Créditos', callback_data: 'menu_add_credits' }]);
      } else {
        keyboard.push([{ text: `▶️ Assistir Canal - ${formatMoney(PRECO_LIVETV_FIXO)}`, callback_data: `watch_live_${id}_${PRECO_LIVETV_FIXO}` }]);
      }

      keyboard.push([{ text: '📡 Ver Lista de Canais', callback_data: 'list_livetv' }]);
      keyboard.push([{ text: '🏠 Menu Principal', callback_data: 'back_main' }]);

      await bot.sendMessage(chatId, mensagem, {
        parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: keyboard }
      });
      return;
    }

    if (data.startsWith('alphabet_')) {
      const tipo = data.split('_')[1];
      bot.answerCallbackQuery(query.id);
      bot.deleteMessage(chatId, msgId).catch(() => {});
      mostrarAlfabeto(chatId, tipo);
      return;
    }

    if (data.startsWith('letter_')) {
      const parts = data.split('_');
      const tipo = parts[1];
      const letra = parts[2];
      const pagina = parseInt(parts[3], 10) || 1;
      bot.answerCallbackQuery(query.id);
      bot.deleteMessage(chatId, msgId).catch(() => {});
      await listarPorLetra(chatId, tipo, letra, pagina);
      return;
    }

    if (data === 'my_content') {
      bot.answerCallbackQuery(query.id);
      bot.deleteMessage(chatId, msgId).catch(() => {});
      await mostrarMeuConteudo(chatId);
      return;
    }

    if (data === 'mycontent_movies') {
      bot.answerCallbackQuery(query.id);
      bot.deleteMessage(chatId, msgId).catch(() => {});
      await mostrarMeuConteudoFilmes(chatId);
      return;
    }

    if (data.startsWith('mycontent_movies_page_')) {
      const page = parseInt(data.split('_').pop(), 10) || 1;
      bot.answerCallbackQuery(query.id);
      bot.deleteMessage(chatId, msgId).catch(() => {});
      await mostrarMeuConteudoFilmes(chatId, page);
      return;
    }

    if (data === 'mycontent_series') {
      bot.answerCallbackQuery(query.id);
      bot.deleteMessage(chatId, msgId).catch(() => {});
      await mostrarMeuConteudoSeries(chatId);
      return;
    }

    if (data.startsWith('mycontent_series_page_')) {
      const page = parseInt(data.split('_').pop(), 10) || 1;
      bot.answerCallbackQuery(query.id);
      bot.deleteMessage(chatId, msgId).catch(() => {});
      await mostrarMeuConteudoSeries(chatId, page);
      return;
    }

    if (data === 'mycontent_live') {
      bot.answerCallbackQuery(query.id);
      bot.deleteMessage(chatId, msgId).catch(() => {});
      await mostrarMeuConteudoLive(chatId);
      return;
    }

    if (data.startsWith('mycontent_live_page_')) {
      const page = parseInt(data.split('_').pop(), 10) || 1;
      bot.answerCallbackQuery(query.id);
      bot.deleteMessage(chatId, msgId).catch(() => {});
      await mostrarMeuConteudoLive(chatId, page);
      return;
    }

    if (data.startsWith('myseries_')) {
      const parts = data.split('_');
      const index = parseInt(parts[1], 10);
      bot.answerCallbackQuery(query.id);
      bot.deleteMessage(chatId, msgId).catch(() => {});
      if (Number.isFinite(index)) {
        if (parts.length >= 4 && parts[2] === 'page') {
          const page = parseInt(parts[3], 10) || 1;
          await mostrarMeuConteudoSerieDetalhes(chatId, index, page);
        } else {
          await mostrarMeuConteudoSerieDetalhes(chatId, index);
        }
      } else {
        await mostrarMeuConteudoSeries(chatId);
      }
      return;
    }

    if (data.startsWith('mycontent_')) {
      const contentId = data.split('_')[1];
      bot.answerCallbackQuery(query.id);
      bot.deleteMessage(chatId, msgId).catch(() => {});
      await mostrarDetalhesConteudo(chatId, contentId);
      return;
    }

    if (data === 'menu_add_credits') {
      bot.answerCallbackQuery(query.id);
      bot.deleteMessage(chatId, msgId).catch(() => {});
      mostrarOpcoesCredito(chatId);
      return;
    }

    if (data.startsWith('add_')) {
      const valor = parseInt(data.split('_')[1], 10);
      if (isNaN(valor) || valor <= 0) return;

      bot.answerCallbackQuery(query.id, { text: 'Gerando PIX...' });
      const pix = await criarPagamentoPix(chatId, valor);

      if (!pix) {
        bot.sendMessage(chatId, '❌ Erro ao gerar PIX.', {
          parse_mode: 'Markdown',
          reply_markup: {
            inline_keyboard: [
              [{ text: '🔄 Tentar novamente', callback_data: data }],
              [{ text: '🏠 Menu Principal', callback_data: 'back_main' }]
            ]
          }
        });
        return;
      }

      bot.deleteMessage(chatId, msgId).catch(() => {});
      await bot.sendMessage(
        chatId,
        `💳 *PIX Gerado - ${formatMoney(valor)}*\n\n*Código Pix:*\n<code>${pix.pix_code}</code>`,
        { parse_mode: 'HTML' }
      );

      if (pix.pix_qr_base64) {
        await bot.sendPhoto(chatId, Buffer.from(pix.pix_qr_base64, 'base64'), {
          caption: '📱 QR Code PIX'
        });
      }

      await bot.sendMessage(chatId, '⏳ *Aguardando confirmação do pagamento...*', {
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [
            [{ text: '💳 Ver Saldo', callback_data: 'check_balance' }],
            [{ text: '🏠 Menu Principal', callback_data: 'back_main' }]
          ]
        }
      });
      return;
    }

    if (data === 'check_balance') {
      const saldo = await getUserCredits(chatId);
      bot.answerCallbackQuery(query.id, {
        text: `Saldo atual: ${formatMoney(saldo)}`,
        show_alert: true
      });
      return;
    }

    if (data.startsWith('details_')) {
      const [, id, type] = data.split('_');
      bot.answerCallbackQuery(query.id, { text: 'Carregando detalhes...' });
      bot.deleteMessage(chatId, msgId).catch(() => {});

      const buscarDetalhes = getBuscarDetalhes();
      if (!buscarDetalhes) {
        await bot.sendMessage(chatId, '❌ Serviço de detalhes indisponível no momento.');
        return;
      }

      const detalhes = await buscarDetalhes(id, type);
      if (!detalhes) {
        await bot.sendMessage(chatId, '❌ Erro ao carregar detalhes do conteúdo.');
        return;
      }

      setUserState(chatId, { step: 'details', data: detalhes, id, type });
      const saldoAtual = await getUserCredits(chatId);
      const tituloSeguro = escaparMarkdownSeguro(detalhes.title);

      let mensagem = `🎬 *${tituloSeguro}*\n\n`;
      if (detalhes.info?.genero) mensagem += `🎭 ${escaparMarkdownSeguro(detalhes.info.genero)}\n`;
      if (detalhes.info?.ano) mensagem += `📅 ${detalhes.info.ano}\n`;
      if (detalhes.info?.imdb) mensagem += `⭐ IMDB: ${detalhes.info.imdb}\n`;
      if (detalhes.info?.sinopse) mensagem += `\n${escaparMarkdownSeguro(String(detalhes.info.sinopse).substring(0, 400))}\n\n`;

      const keyboard = [];

      if (detalhes.mediaType === 'movie') {
        let minutos = parseInt(detalhes.info?.duracaoMinutos || 0, 10);

        if (!Number.isFinite(minutos) || minutos <= 0) {
          const estimarDuracao = getEstimarDuracao(110);
          minutos = await estimarDuracao('movie', id, null);
        }

        const pricing = calcularPrecoFinal({ mediaType: 'movie', duracaoMinutos: minutos });

        mensagem += `⏱️ Duração: ~${pricing.duracaoMinutos}min\n💰 Preço: ${formatMoney(pricing.precoFinal)}\n⏰ Válido por: 24 horas\n💳 Seu saldo: ${formatMoney(saldoAtual)}`;

        if (saldoAtual < pricing.precoFinal) {
          keyboard.push([{ text: '💰 Adicionar Créditos', callback_data: 'menu_add_credits' }]);
        } else {
          keyboard.push([{
            text: `▶️ Assistir - ${formatMoney(pricing.precoFinal)}`,
            callback_data: `watch_movie_${id}_${pricing.precoFinal}_${pricing.duracaoMinutos}`
          }]);
        }
      } else {
        mensagem += `📺 *Temporadas disponíveis:*\n\n⏰ Válido por: 7 dias\n💳 Seu saldo: ${formatMoney(saldoAtual)}\n\n`;
        Object.keys(detalhes.seasons || {}).forEach((seasonKey) => {
          const eps = detalhes.seasons[seasonKey] || [];
          keyboard.push([{
            text: `Temporada ${seasonKey} (${eps.length} episódio${eps.length > 1 ? 's' : ''})`,
            callback_data: `season_${id}_${String(seasonKey)}`
          }]);
        });
      }

      keyboard.push([{ text: '🏠 Menu Principal', callback_data: 'back_main' }]);

      const coverUrl = toTelegramUrl(
        toAbsoluteUrl(detalhes.coverUrl || detalhes.capa_url || detalhes.capa || '')
      );
      if (coverUrl) {
        logger.info({
          msg: 'Enviando capa dos detalhes',
          chatId,
          title: detalhes.title,
          coverUrl
        });

        try {
          await bot.sendPhoto(chatId, coverUrl, {
            caption: detalhes.title ? `Detalhes: ${detalhes.title}` : 'Detalhes do conteudo'
          });
        } catch (error) {
          logger.warn({
            msg: 'Falha ao enviar capa dos detalhes',
            chatId,
            title: detalhes.title,
            error: error.message
          });
        }
      } else {
        logger.info({
          msg: 'Detalhes sem capa para enviar',
          chatId,
          title: detalhes.title
        });
      }

      await bot.sendMessage(chatId, mensagem, {
        parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: keyboard }
      });
      return;
    }

    if (data.startsWith('season_')) {
      const [, id, seasonRaw] = data.split('_');
      const season = String(seasonRaw);
      const state = userStates[chatId];

      if (!state || !state.data || !state.data.seasons) {
        bot.answerCallbackQuery(query.id, { text: 'Erro ao carregar temporada' });
        return;
      }

      let episodios =
        state.data.seasons[season] ||
        state.data.seasons[String(season)] ||
        state.data.seasons[Number(season)] ||
        [];

      if ((!Array.isArray(episodios) || episodios.length === 0) && typeof state.data.seasons === 'object') {
        const foundKey = Object.keys(state.data.seasons).find(k => String(k) === season || String(k).includes(season));
        if (foundKey) episodios = state.data.seasons[foundKey] || [];
      }

      if (!Array.isArray(episodios) || episodios.length === 0) {
        bot.answerCallbackQuery(query.id, { text: 'Temporada sem episódios' });
        return;
      }

      bot.answerCallbackQuery(query.id);

      const episodeIds = episodios.map((ep) => String(ep.id));
      const ownedEpisodes = await getOwnedEpisodesSet(chatId, state.data.title, season, episodeIds);

      let precoTotal = 0;
      let restantes = 0;
      const estimarDuracao = typeof vouverService?.estimarDuracao === 'function'
        ? vouverService.estimarDuracao
        : async () => 24;

      for (const ep of episodios) {
        if (ownedEpisodes.has(String(ep.id))) continue;
        let min = await estimarDuracao('series', ep.id);
        if (!Number.isFinite(min) || min <= 0) min = 24;
        const p = calcularPrecoFinal({ mediaType: 'series', duracaoMinutos: min });
        precoTotal += p.precoFinal;
        restantes += 1;
      }

      const saldoAtual = await getUserCredits(chatId);
      const keyboard = [];

      // APLICANDO DECODER NOS BOTÕES DOS EPISÓDIOS DA TEMPORADA
      for (let i = 0; i < episodios.length; i++) {
        const ep = episodios[i];
        const name = decodificarHTML(ep.name || `Episódio ${i + 1}`);
        const owned = ownedEpisodes.has(String(ep.id));
        const prefix = owned ? '✅ ' : '';
        keyboard.push([{
          text: `${prefix}${i + 1}. ${name.substring(0, 50)}${name.length > 50 ? '...' : ''}`,
          callback_data: `episode_${ep.id}_${season}`
        }]);
      }

      if (restantes === 0) {
        keyboard.push([{ text: '✅ Temporada já adquirida', callback_data: 'noop' }]);
      } else if (saldoAtual >= precoTotal) {
        keyboard.push([{
          text: `📥 Comprar Temporada (${restantes} restantes) - ${formatMoney(precoTotal)}`,
          callback_data: `buy_season_${id}_${season}_${precoTotal}`
        }]);
      } else {
        keyboard.push([{
          text: `⚠️ Saldo Insuficiente - Faltam ${formatMoney(precoTotal - saldoAtual)}`,
          callback_data: 'menu_add_credits'
        }]);
      }

      keyboard.push([{ text: '⬅️ Voltar aos Detalhes', callback_data: `details_${id}_${state.type}` }]);
      keyboard.push([{ text: '🏠 Menu Principal', callback_data: 'back_main' }]);

      bot.deleteMessage(chatId, msgId).catch(() => {});
      bot.sendMessage(
        chatId,
        `📺 *${escaparMarkdownSeguro(state.data.title)}*\n*Temporada ${season}*\n\n` +
          `Total: ${episodios.length} episódio${episodios.length > 1 ? 's' : ''}\n` +
          `Restantes: ${restantes}\n` +
          `Preço da temporada: ${formatMoney(precoTotal)}\n` +
          `⏰ Válido por: 7 dias\n` +
          `💳 Seu saldo: ${formatMoney(saldoAtual)}\n\n` +
          `✅ = episódio já comprado (válido)\n\n` +
          `Selecione um episódio:`,
        { parse_mode: 'Markdown', reply_markup: { inline_keyboard: keyboard } }
      );
      return;
    }

    if (data.startsWith('episode_')) {
      const [, epId, season] = data.split('_');
      const state = userStates[chatId];

      if (!state || !state.data || !state.data.seasons) {
        bot.answerCallbackQuery(query.id, { text: 'Erro ao carregar episódio' });
        return;
      }

      let episodios =
        state.data.seasons[season] ||
        state.data.seasons[String(season)] ||
        state.data.seasons[Number(season)] ||
        [];

      if ((!Array.isArray(episodios) || episodios.length === 0) && typeof state.data.seasons === 'object') {
        const foundKey = Object.keys(state.seasons).find(k => String(k) === season || String(k).includes(season));
        if (foundKey) episodios = state.data.seasons[foundKey] || [];
      }

      const episodio = (episodios || []).find(e => String(e.id) === String(epId));
      if (!episodio) {
        bot.answerCallbackQuery(query.id, { text: 'Episódio não encontrado' });
        return;
      }

      bot.answerCallbackQuery(query.id);

      const estimarDuracao = typeof vouverService?.estimarDuracao === 'function'
        ? vouverService.estimarDuracao
        : async () => 24;

      let minutos = await estimarDuracao('series', epId);
      if (!Number.isFinite(minutos) || minutos <= 0) minutos = 24;

      const pricing = calcularPrecoFinal({ mediaType: 'series', duracaoMinutos: minutos });
      const saldoAtual = await getUserCredits(chatId);

      bot.deleteMessage(chatId, msgId).catch(() => {});

      const ownedEpisode = await PurchasedContentModel.findOne({
        userId: chatId,
        mediaType: 'series',
        videoId: String(epId),
        ...getPurchaseVisibilityFilter({ expiresAt: { $gt: new Date() } })
      });

      let mensagem =
        `📺 *${escaparMarkdownSeguro(state.data.title)}*\n` +
        `*Temporada ${season} - ${escaparMarkdownSeguro(episodio.name || 'Episódio')}*\n\n` +
        `⏱️ Duração: ~${pricing.duracaoMinutos}min\n` +
        `⏰ Válido por: 7 dias\n` +
        `💳 Seu saldo: ${formatMoney(saldoAtual)}`;

      const keyboard = [];
      if (ownedEpisode) {
        mensagem += `\n\n✅ Você já possui este episódio.`;
        keyboard.push([{ text: '▶️ Assistir Agora', url: `${DOMINIO_PUBLICO}/player/${ownedEpisode.token}` }]);
        keyboard.push([{ text: '📦 Meu Conteúdo', callback_data: 'my_content' }]);
      } else if (saldoAtual < pricing.precoFinal) {
        mensagem += `\n💰 Preço: ${formatMoney(pricing.precoFinal)}`;
        mensagem += `\n\n⚠️ *Saldo insuficiente!* Faltam ${formatMoney(pricing.precoFinal - saldoAtual)}`;
        keyboard.push([{ text: '💰 Adicionar Créditos', callback_data: 'menu_add_credits' }]);
      } else {
        mensagem += `\n💰 Preço: ${formatMoney(pricing.precoFinal)}`;
        keyboard.push([{
          text: `▶️ Assistir - ${formatMoney(pricing.precoFinal)}`,
          callback_data: `watch_ep_${epId}_${pricing.precoFinal}_${season}`
        }]);
      }

      keyboard.push([{ text: '⬅️ Voltar à Temporada', callback_data: `season_${state.id}_${season}` }]);
      keyboard.push([{ text: '🏠 Menu Principal', callback_data: 'back_main' }]);

      bot.sendMessage(chatId, mensagem, {
        parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: keyboard }
      });
      return;
    }

    if (data.startsWith('watch_movie_')) {
      const parts = data.split('_');
      const id = parts[2];
      const precoNum = parseInt(parts[3], 10);
      const minutosReais = parts[4] ? parseInt(parts[4], 10) : 110;
      const state = userStates[chatId];

      bot.answerCallbackQuery(query.id);

      const saldoAtual = await getUserCredits(chatId);
      if (saldoAtual < precoNum) {
        bot.sendMessage(chatId,
          `❌ *Saldo Insuficiente*\n\nVocê possui: ${formatMoney(saldoAtual)}\nNecessário: ${formatMoney(precoNum)}\nFaltam: ${formatMoney(precoNum - saldoAtual)}`,
          {
            parse_mode: 'Markdown',
            reply_markup: {
              inline_keyboard: [
                [{ text: '💰 Adicionar Créditos', callback_data: 'menu_add_credits' }],
                [{ text: '🏠 Menu Principal', callback_data: 'back_main' }]
              ]
            }
          }
        );
        return;
      }

      const deducaoSucesso = await deductCredits(chatId, precoNum);
      if (!deducaoSucesso) {
        bot.sendMessage(chatId, '❌ Erro ao processar pagamento. Tente novamente.');
        return;
      }

      const titulo = state?.data?.title || 'Filme';
      const saved = await salvarConteudoComprado(chatId, id, 'movie', titulo, precoNum);
      if (!saved?.token) {
        await addCredits(chatId, precoNum);
        bot.sendMessage(chatId, '❌ Erro ao gerar link. Créditos devolvidos.');
        return;
      }

      const novoSaldo = await getUserCredits(chatId);
      await bot.sendMessage(chatId,
        `✅ *Pagamento Confirmado!*\n\n🎬 Duração: ${minutosReais}min\n💰 -${formatMoney(precoNum)}\n💳 Novo saldo: ${formatMoney(novoSaldo)}\n\n⏰ Link válido por *24 horas*`,
        { parse_mode: 'Markdown' }
      );

      await iniciarCacheComNotificacao(chatId, saved.purchase, `🎬 ${titulo} (${minutosReais}min)`, 'movie');
      return;
    }

    if (data.startsWith('watch_live_')) {
      const [, , id, preco] = data.split('_');
      const precoNum = parseInt(preco, 10) || PRECO_LIVETV_FIXO;

      bot.answerCallbackQuery(query.id);

      const saldoAtual = await getUserCredits(chatId);
      if (saldoAtual < precoNum) {
        await bot.sendMessage(chatId,
          `❌ *Saldo Insuficiente*\n\nVocê possui: ${formatMoney(saldoAtual)}\nNecessário: ${formatMoney(precoNum)}\nFaltam: ${formatMoney(precoNum - saldoAtual)}`,
          {
            parse_mode: 'Markdown',
            reply_markup: {
              inline_keyboard: [
                [{ text: '💰 Adicionar Créditos', callback_data: 'menu_add_credits' }],
                [{ text: '🏠 Menu Principal', callback_data: 'back_main' }]
              ]
            }
          }
        );
        return;
      }

      const deducaoSucesso = await deductCredits(chatId, precoNum);
      if (!deducaoSucesso) {
        await bot.sendMessage(chatId, '❌ Erro ao processar pagamento. Tente novamente.');
        return;
      }

      await ensureCacheLoaded();
      const cache = getCacheSafe();
      const canal = (cache.livetv || []).find((item) => String(item.id) === String(id));
      const tituloCanal = decodificarHTML(canal?.name || `Canal ${id}`);

      const saved = await salvarConteudoComprado(chatId, id, 'livetv', tituloCanal, precoNum);
      if (!saved?.token) {
        await addCredits(chatId, precoNum);
        await bot.sendMessage(chatId, '❌ Erro ao gerar link. Créditos devolvidos.');
        return;
      }

      const novoSaldo = await getUserCredits(chatId);
      await bot.sendMessage(chatId,
        `✅ *Pagamento Confirmado!*\n\n📡 Canal: ${escaparMarkdownSeguro(tituloCanal)}\n💰 -${formatMoney(precoNum)}\n💳 Novo saldo: ${formatMoney(novoSaldo)}\n\n⏰ Link válido por *24 horas*`,
        { parse_mode: 'Markdown' }
      );

      await enviarVideoComLink(chatId, saved.token, `📡 ${tituloCanal}`, precoNum, tituloCanal, 'livetv');
      return;
    }

    if (data.startsWith('watch_ep_')) {
      const [, , epId, preco, season] = data.split('_');
      const precoNum = parseInt(preco, 10);
      const state = userStates[chatId];

      bot.answerCallbackQuery(query.id);

      const saldoAtual = await getUserCredits(chatId);
      if (saldoAtual < precoNum) {
        bot.sendMessage(chatId,
          `❌ *Saldo Insuficiente*\n\nVocê possui: ${formatMoney(saldoAtual)}\nNecessário: ${formatMoney(precoNum)}\nFaltam: ${formatMoney(precoNum - saldoAtual)}`,
          {
            parse_mode: 'Markdown',
            reply_markup: {
              inline_keyboard: [
                [{ text: '💰 Adicionar Créditos', callback_data: 'menu_add_credits' }],
                [{ text: '🏠 Menu Principal', callback_data: 'back_main' }]
              ]
            }
          }
        );
        return;
      }

      const deducaoSucesso = await deductCredits(chatId, precoNum);
      if (!deducaoSucesso) {
        bot.sendMessage(chatId, '❌ Erro ao processar pagamento. Tente novamente.');
        return;
      }

      let nomeEpisodio = 'Episódio';
      let episodeIndex = null;
      let totalEpisodes = null;
      let seriesId = state?.id || state?.data?.id || null;
      if (state?.data?.seasons) {
        for (const s of Object.values(state.data.seasons)) {
          const list = Array.isArray(s) ? s : [];
          const epIndex = list.findIndex(e => String(e.id) === String(epId));
          if (epIndex >= 0) {
            const ep = list[epIndex];
            nomeEpisodio = ep?.name || nomeEpisodio;
            episodeIndex = epIndex + 1;
            totalEpisodes = list.length || null;
            break;
          }
        }
      }

      const tituloSerie = state?.data?.title || 'Série';
      const saved = await salvarConteudoComprado(chatId, epId, 'series', tituloSerie, precoNum, nomeEpisodio, season, {
        seriesId,
        episodeIndex,
        totalEpisodes
      });

      if (!saved?.token) {
        await addCredits(chatId, precoNum);
        bot.sendMessage(chatId, '❌ Erro ao gerar link. Créditos devolvidos.');
        return;
      }

      const novoSaldo = await getUserCredits(chatId);
      await bot.sendMessage(chatId,
        `✅ *Pagamento Confirmado!*\n\n📺 Episódio: ${escaparMarkdownSeguro(nomeEpisodio)}\n💰 -${formatMoney(precoNum)}\n💳 Novo saldo: ${formatMoney(novoSaldo)}\n\n⏰ Link válido por *7 dias*`,
        { parse_mode: 'Markdown' }
      );

      await iniciarCacheComNotificacao(chatId, saved.purchase, `📺 ${nomeEpisodio}`, 'series');
      return;
    }

    if (data.startsWith('buy_season_')) {
      const [, , id, season, preco] = data.split('_');
      const precoNum = parseInt(preco, 10);
      const state = userStates[chatId];

      bot.answerCallbackQuery(query.id);

      let episodios =
        state?.data?.seasons?.[season] ||
        state?.data?.seasons?.[String(season)] ||
        state?.data?.seasons?.[Number(season)] ||
        [];

      if ((!Array.isArray(episodios) || episodios.length === 0) && state?.data?.seasons) {
        const foundKey = Object.keys(state.data.seasons).find(k => String(k) === String(season) || String(k).includes(String(season)));
        if (foundKey) episodios = state.data.seasons[foundKey] || [];
      }

      if (!Array.isArray(episodios) || episodios.length === 0) {
        bot.sendMessage(chatId, '❌ Erro ao carregar episódios da temporada.');
        return;
      }

      const episodeIds = episodios.map((ep) => String(ep.id));
      const ownedEpisodes = await getOwnedEpisodesSet(chatId, state?.data?.title || '', season, episodeIds);
      const restantes = episodios.filter((ep) => !ownedEpisodes.has(String(ep.id)));

      if (restantes.length === 0) {
        await bot.sendMessage(chatId,
          `✅ *Você já possui todos os episódios desta temporada.*`,
          { parse_mode: 'Markdown' }
        );
        return;
      }

      let precoRestante = 0;
      const estimarDuracao = typeof vouverService?.estimarDuracao === 'function'
        ? vouverService.estimarDuracao
        : async () => 24;

      for (const ep of restantes) {
        let min = await estimarDuracao('series', ep.id);
        if (!Number.isFinite(min) || min <= 0) min = 24;
        const p = calcularPrecoFinal({ mediaType: 'series', duracaoMinutos: min });
        precoRestante += p.precoFinal;
      }

      const saldoAtual = await getUserCredits(chatId);
      if (saldoAtual < precoRestante) {
        bot.sendMessage(chatId,
          `❌ *Saldo Insuficiente*\n\nVocê possui: ${formatMoney(saldoAtual)}\nNecessário: ${formatMoney(precoRestante)}\nFaltam: ${formatMoney(precoRestante - saldoAtual)}`,
          {
            parse_mode: 'Markdown',
            reply_markup: {
              inline_keyboard: [
                [{ text: '💰 Adicionar Créditos', callback_data: 'menu_add_credits' }],
                [{ text: '🏠 Menu Principal', callback_data: 'back_main' }]
              ]
            }
          }
        );
        return;
      }

      const deducaoSucesso = await deductCredits(chatId, precoRestante);
      if (!deducaoSucesso) {
        bot.sendMessage(chatId, '❌ Erro ao processar pagamento. Tente novamente.');
        return;
      }

      const novoSaldo = await getUserCredits(chatId);
      const statusMessage = await bot.sendMessage(chatId,
        `✅ *Compra confirmada!*\n\n-${formatMoney(precoRestante)}\n💳 Novo saldo: ${formatMoney(novoSaldo)}\n\n📤 Estamos liberando ${restantes.length} episódios desta temporada.\n⏳ Conteúdo em processamento — vamos avisando conforme ficar disponível.\n\nDisponíveis agora: 0/${restantes.length}\n⏰ *Links válidos por 7 dias*`,
        { parse_mode: 'Markdown' }
      );
      const statusMessageId = statusMessage?.message_id || null;
      const progressState = {
        total: restantes.length,
        ready: 0,
        lastUpdateAt: 0,
        lastReleased: [],
        startedAt: Date.now()
      };

      const updateProgressMessage = async (force = false) => {
        if (!statusMessageId) return;
        const now = Date.now();
        if (!force && now - progressState.lastUpdateAt < 1500) return;
        progressState.lastUpdateAt = now;

        const done = progressState.ready >= progressState.total;
        const header = done ? `✅ *Temporada ${season} Liberada!*` : '⏳ *Conteúdo em processamento*';
        const body = done
          ? `\n\nTodos os episódios desta temporada já estão disponíveis.`
          : `\n\nEstamos liberando episódios desta temporada.`;

        const lastList = progressState.lastReleased.length > 0
          ? `\n\n🆕 Últimos liberados:\n${progressState.lastReleased.map((name) => `• ${escaparMarkdownSeguro(name)}`).join('\n')}`
          : '';

        let etaText = '';
        if (!done && progressState.ready > 0) {
          const elapsedMs = Date.now() - progressState.startedAt;
          const avgMs = elapsedMs / Math.max(1, progressState.ready);
          const remaining = Math.max(0, progressState.total - progressState.ready);
          const etaMs = Math.round(avgMs * remaining);
          const etaMinutes = Math.max(1, Math.ceil(etaMs / 60000));
          etaText = `\n\n⏱️ Estimativa: ~${etaMinutes} min restantes`;
        }

        const text =
          `${header}\n\n-${formatMoney(precoRestante)}\n💳 Novo saldo: ${formatMoney(novoSaldo)}${body}\n\nDisponíveis agora: ${progressState.ready}/${progressState.total}${lastList}${etaText}\n⏰ *Links válidos por 7 dias*`;

        await bot.editMessageText(text, {
          chat_id: chatId,
          message_id: statusMessageId,
          parse_mode: 'Markdown'
        }).catch(() => {});
      };

      let salvos = 0;
      const tituloSerie = state?.data?.title || 'Série';
      const seriesId = state?.id || state?.data?.id || null;
      const episodeIndexById = new Map(
        (episodios || []).map((ep, idx) => [String(ep.id), idx + 1])
      );
      const totalEpisodes = Array.isArray(episodios) ? episodios.length : null;
      for (const ep of restantes) {
        try {
          const saved = await salvarConteudoComprado(chatId, ep.id, 'series', tituloSerie, 0, ep.name, season, {
            seriesId,
            episodeIndex: episodeIndexById.get(String(ep.id)) || null,
            totalEpisodes
          });
          if (saved?.token) {
            salvos++;
            bunnyCacheService.enqueue(saved.purchase, {
              onReady: async () => {
                progressState.ready += 1;
                const epName = ep?.name ? decodificarHTML(ep.name) : `Episódio ${progressState.ready}`;
                if (epName) {
                  progressState.lastReleased.unshift(epName);
                  progressState.lastReleased = progressState.lastReleased.slice(0, 3);
                }
                await updateProgressMessage(progressState.ready >= progressState.total);
              },
              onError: async () => {
                await updateProgressMessage(true);
              }
            });
          }
        } catch (e) {
          console.error('Erro ao salvar episódio:', e.message);
        }
      }

      await bot.sendMessage(chatId,
        `✅ *Compra concluída!*\n\n📦 ${salvos} de ${restantes.length} episódios salvos em "Meu Conteúdo"\n⏳ Se algum ainda estiver em processamento, liberamos assim que ficar pronto.\n\nAcesse em "📦 Meu Conteúdo" para acompanhar!`,
        {
          parse_mode: 'Markdown',
          reply_markup: {
            inline_keyboard: [
              [{ text: '📦 Ver Meu Conteúdo', callback_data: 'my_content' }],
              [{ text: '🏠 Menu Principal', callback_data: 'back_main' }]
            ]
          }
        }
      );
      return;
    }

  } catch (error) {
    console.error('Erro ao processar callback query:', error);
    bot.answerCallbackQuery(query.id, { text: 'Erro ao processar ação' }).catch(() => {});
    bot.sendMessage(chatId, '❌ Erro ao processar sua solicitação.').catch(() => {});
  }
});


// ============================
// TRATAMENTO DE ERROS
// ============================
bot.on('polling_error', (error) => {
  if (error.code === 'ETELEGRAM') {
    const errorCode = error.response?.body?.error_code;
    const errorMsg = error.response?.body?.description || error.message;
    
    // Ignorar erros comuns que não precisam ser tratados como crash
    if (errorCode === 409) {
      // conflito de polling (2 bots rodando)
      return;
    }
    
    if (errorCode === 400 && errorMsg?.includes('query')) {
      // query muito antiga - Telegram descarta, é normal
      return;
    }
    
    console.error('Erro de polling do bot (ETELEGRAM):', errorCode, errorMsg);
  } else {
    console.error('Erro de polling do bot:', error.message);
  }
});

// ============================
// LIMPEZA PERIÓDICA
// ============================
setInterval(() => {
  const agora = Date.now();
  const TEMPO_EXPIRACAO = 15 * 60 * 1000;
  for (const [paymentId, payment] of Object.entries(pendingPayments)) {
    if (agora - payment.timestamp > TEMPO_EXPIRACAO) {
      delete pendingPayments[paymentId];
      if (paymentCheckIntervals[paymentId]) {
        clearInterval(paymentCheckIntervals[paymentId]);
        delete paymentCheckIntervals[paymentId];
      }
    }
  }
}, 5 * 60 * 1000);

setInterval(async () => {
  try {
    if (!PurchasedContentModel || typeof PurchasedContentModel.deleteMany !== 'function') return;
    await PurchasedContentModel.deleteMany({ expiresAt: { $lt: new Date() } });
  } catch (error) {
    console.error('Erro ao limpar conteúdos expirados:', error);
  }
}, 60 * 60 * 1000);

setInterval(verificarConteudosExpirando, 60 * 60 * 1000);
setTimeout(verificarConteudosExpirando, 30000);

// ============================
// FUNÇÃO: Notificar Falha de Cache ao Usuário
// ============================
async function notificarFalhaCacheAoUsuario(userId, purchase) {
  if (!bot || typeof bot.sendMessage !== 'function') return;
  
  try {
    const titulo = sanitizarTexto(purchase.title || 'Conteúdo');
    const erro = sanitizarTexto(purchase.cacheError || 'Erro desconhecido');
    
    const texto = `
⚠️ *Problema ao baixar conteúdo*

Título: ${titulo}
Erro: ${erro}

O arquivo ficou incompleto (${purchase.cacheProgress || 0}%). 

*O que fazer:*
Você não foi cobrado novamente. Clique no botão abaixo para retentar o download:

/requeue_${purchase._id}

Precisar de ajuda? Entre em contato com o suporte.
    `.trim();
    
    await bot.sendMessage(userId, texto, { parse_mode: 'Markdown' }).catch((err) => {
      console.error('Erro ao notificar usuário sobre falha de cache:', err.message);
    });
  } catch (error) {
    console.error('Erro em notificarFalhaCacheAoUsuario:', error.message);
  }
}

// ============================
// EXPORTS
// ============================
module.exports = {
  bot,
  setModels,
  initBot,
  processarPagamentoAprovado,
  getUserCredits,
  addCredits,
  dispararCampanhaTelegram,
  notificarFalhaCacheAoUsuario
};
