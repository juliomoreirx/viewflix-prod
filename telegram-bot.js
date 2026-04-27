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
  console.warn('⚠️ AVISO: MP_ACCESS_TOKEN não definido - pagamentos PIX não funcionarão');
}

console.log('✅ [Bot] Variáveis de ambiente carregadas');

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

  console.log('✅ [Bot] Models injetados:', {
    hasUser: !!UserModel,
    hasPurchasedContent: !!PurchasedContentModel
  });
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

  console.log('✅ Bot do Telegram inicializado com sucesso e a escutar!');
  console.log(`🌐 Domínio configurado: ${DOMINIO_PUBLICO}`);
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

async function getUserCredits(userId) {
  return await paymentAdapter.getUserCredits(userId);
}

async function addCredits(userId, centavos) {
  return await paymentAdapter.addCredits(userId, centavos);
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

async function salvarConteudoComprado(userId, videoId, mediaType, title, price, episodeName = null, season = null) {
  try {
    const token = gerarTokenAcesso(userId, videoId, mediaType);
    if (!token) return null;

    const purchaseDate = new Date();
    const horasExpiracao = mediaType === 'series' ? (7 * 24) : 24;
    const expiresAt = new Date(purchaseDate.getTime() + (horasExpiracao * 60 * 60 * 1000));
    const sessionToken = crypto.randomBytes(32).toString('hex');

    const purchase = new PurchasedContentModel({
      userId, videoId, mediaType, title, episodeName, season,
      purchaseDate, expiresAt, token, price, sessionToken
    });

    await purchase.save();
    return token;
  } catch (error) {
    console.error('Erro ao salvar conteúdo comprado:', error);
    return null;
  }
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
    const buttons = itensPagina.map(item => {
      const name = decodificarHTML(item.name || '');
      return [{
        text: `${name.substring(0, 60)}${name.length > 60 ? '...' : ''}`,
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
    await bot.sendMessage(
      chatId,
      `🔤 *${tipoTexto} - Letra "${letra}"*\n\n📋 Mostrando ${inicio + 1}-${Math.min(fim, totalItens)} de ${totalItens} resultado${totalItens > 1 ? 's' : ''}`,
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
      expiresAt: { $gt: new Date() }
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

    // APLICANDO DECODER EM "MEU CONTEÚDO"
    const buttons = conteudos.map(item => {
      const title = decodificarHTML(item.title || '');
      const epName = item.episodeName ? decodificarHTML(item.episodeName) : '';
      const nome = epName ? `${title} - ${epName}` : title;
      const timer = formatTimeRemaining(item.expiresAt);
      const emoji = item.mediaType === 'movie' ? '🎬' : (item.mediaType === 'livetv' ? '📡' : '📺');
      
      return [{
        text: `${emoji} ${nome.substring(0, 45)} | ${timer}`,
        callback_data: `mycontent_${item._id}`
      }];
    });

    buttons.push([{ text: '🏠 Menu Principal', callback_data: 'back_main' }]);

    await bot.sendMessage(chatId,
      `📦 *Meu Conteúdo*\n\nVocê tem ${conteudos.length} conteúdo${conteudos.length > 1 ? 's' : ''} disponível${conteudos.length > 1 ? 'is' : ''}:\n\n💡 *Dica:* Filmes e Canais expiram em 24h, Séries em 7 dias`,
      { parse_mode: 'Markdown', reply_markup: { inline_keyboard: buttons } }
    );
  } catch (error) {
    console.error('Erro ao mostrar conteúdo:', error);
    await bot.sendMessage(chatId, '❌ Erro ao carregar seu conteúdo. Tente novamente.');
  }
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
      expiresAt: { $gt: agora, $lte: daquiA2Horas },
      notificationSent: false
    });

    const seriesExpirando = await PurchasedContentModel.find({
      mediaType: 'series',
      expiresAt: { $gt: agora, $lte: daquiA24Horas },
      notificationSent: false
    });

    const canaisExpirando = await PurchasedContentModel.find({
      mediaType: 'livetv',
      expiresAt: { $gt: agora, $lte: daquiA2Horas },
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

    const cache = getCacheSafe();
    const totalFilmes = cache.movies.length;
    const totalSeries = cache.series.length;
    const totalCanais = (cache.livetv || []).length;
    const totalConteudo = totalFilmes + totalSeries + totalCanais;
    const saldo = user.credits;
    const nomeSeguro = sanitizarTexto(user.firstName);

    const welcome = isNew
      ? `🎉 *Bem-vindo ao FastTV, ${nomeSeguro}!*\n\n✅ Conta criada com sucesso!\n\n📊 Catálogo:\n🎥 ${totalFilmes.toLocaleString('pt-BR')} filmes\n📺 ${totalSeries.toLocaleString('pt-BR')} séries\n📡 ${totalCanais.toLocaleString('pt-BR')} canais ao vivo\n📦 ${totalConteudo.toLocaleString('pt-BR')} conteúdos\n\n💰 Saldo: ${formatMoney(saldo)}`
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
    const buttons = resultados.map(item => {
      const name = decodificarHTML(item.name || '');
      if (state.step === 'search_livetv') {
        return [{ text: `📡 ${name.substring(0, 54)}${name.length > 54 ? '...' : ''}`, callback_data: `live_details_${item.id}` }];
      }
      const tipo = (cache.movies || []).find(m => m.id === item.id) ? 'movies' : 'series';
      return [{ text: `${name.substring(0, 60)}${name.length > 60 ? '...' : ''}`, callback_data: `details_${item.id}_${tipo}` }];
    });
    buttons.push([{ text: '🏠 Menu Principal', callback_data: 'back_main' }]);

    bot.sendMessage(chatId,
      `📋 *${resultados.length} resultado${resultados.length > 1 ? 's' : ''} encontrado${resultados.length > 1 ? 's' : ''}:*\n\nSelecione para ver detalhes:`,
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
    console.log('📲 CALLBACK:', data);

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

      let precoTotal = 0;
      const estimarDuracao = typeof vouverService?.estimarDuracao === 'function'
        ? vouverService.estimarDuracao
        : async () => 24;

      for (const ep of episodios) {
        let min = await estimarDuracao('series', ep.id);
        if (!Number.isFinite(min) || min <= 0) min = 24;
        const p = calcularPrecoFinal({ mediaType: 'series', duracaoMinutos: min });
        precoTotal += p.precoFinal;
      }

      const saldoAtual = await getUserCredits(chatId);
      const keyboard = [];

      // APLICANDO DECODER NOS BOTÕES DOS EPISÓDIOS DA TEMPORADA
      for (let i = 0; i < episodios.length; i++) {
        const ep = episodios[i];
        const name = decodificarHTML(ep.name || `Episódio ${i + 1}`);
        keyboard.push([{
          text: `${i + 1}. ${name.substring(0, 50)}${name.length > 50 ? '...' : ''}`,
          callback_data: `episode_${ep.id}_${season}`
        }]);
      }

      if (saldoAtual >= precoTotal) {
        keyboard.push([{
          text: `📥 Comprar Temporada Completa - ${formatMoney(precoTotal)}`,
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
          `Preço da temporada: ${formatMoney(precoTotal)}\n` +
          `⏰ Válido por: 7 dias\n` +
          `💳 Seu saldo: ${formatMoney(saldoAtual)}\n\n` +
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

      let mensagem =
        `📺 *${escaparMarkdownSeguro(state.data.title)}*\n` +
        `*Temporada ${season} - ${escaparMarkdownSeguro(episodio.name || 'Episódio')}*\n\n` +
        `⏱️ Duração: ~${pricing.duracaoMinutos}min\n` +
        `💰 Preço: ${formatMoney(pricing.precoFinal)}\n` +
        `⏰ Válido por: 7 dias\n` +
        `💳 Seu saldo: ${formatMoney(saldoAtual)}`;

      const keyboard = [];
      if (saldoAtual < pricing.precoFinal) {
        mensagem += `\n\n⚠️ *Saldo insuficiente!* Faltam ${formatMoney(pricing.precoFinal - saldoAtual)}`;
        keyboard.push([{ text: '💰 Adicionar Créditos', callback_data: 'menu_add_credits' }]);
      } else {
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
      const token = await salvarConteudoComprado(chatId, id, 'movie', titulo, precoNum);
      if (!token) {
        await addCredits(chatId, precoNum);
        bot.sendMessage(chatId, '❌ Erro ao gerar link. Créditos devolvidos.');
        return;
      }

      const novoSaldo = await getUserCredits(chatId);
      await bot.sendMessage(chatId,
        `✅ *Pagamento Confirmado!*\n\n🎬 Duração: ${minutosReais}min\n💰 -${formatMoney(precoNum)}\n💳 Novo saldo: ${formatMoney(novoSaldo)}\n\n⏰ Link válido por *24 horas*`,
        { parse_mode: 'Markdown' }
      );

      await enviarVideoComLink(chatId, token, `🎬 ${titulo} (${minutosReais}min)`, precoNum, titulo, 'movie');
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

      const token = await salvarConteudoComprado(chatId, id, 'livetv', tituloCanal, precoNum);
      if (!token) {
        await addCredits(chatId, precoNum);
        await bot.sendMessage(chatId, '❌ Erro ao gerar link. Créditos devolvidos.');
        return;
      }

      const novoSaldo = await getUserCredits(chatId);
      await bot.sendMessage(chatId,
        `✅ *Pagamento Confirmado!*\n\n📡 Canal: ${escaparMarkdownSeguro(tituloCanal)}\n💰 -${formatMoney(precoNum)}\n💳 Novo saldo: ${formatMoney(novoSaldo)}\n\n⏰ Link válido por *24 horas*`,
        { parse_mode: 'Markdown' }
      );

      await enviarVideoComLink(chatId, token, `📡 ${tituloCanal}`, precoNum, tituloCanal, 'livetv');
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
      if (state?.data?.seasons) {
        for (const s of Object.values(state.data.seasons)) {
          const ep = (s || []).find(e => String(e.id) === String(epId));
          if (ep) { nomeEpisodio = ep.name; break; }
        }
      }

      const tituloSerie = state?.data?.title || 'Série';
      const token = await salvarConteudoComprado(chatId, epId, 'series', tituloSerie, precoNum, nomeEpisodio, season);

      if (!token) {
        await addCredits(chatId, precoNum);
        bot.sendMessage(chatId, '❌ Erro ao gerar link. Créditos devolvidos.');
        return;
      }

      const novoSaldo = await getUserCredits(chatId);
      await bot.sendMessage(chatId,
        `✅ *Pagamento Confirmado!*\n\n📺 Episódio: ${escaparMarkdownSeguro(nomeEpisodio)}\n💰 -${formatMoney(precoNum)}\n💳 Novo saldo: ${formatMoney(novoSaldo)}\n\n⏰ Link válido por *7 dias*`,
        { parse_mode: 'Markdown' }
      );

      await enviarVideoComLink(chatId, token, `📺 ${nomeEpisodio}`, precoNum, nomeEpisodio, 'series');
      return;
    }

    if (data.startsWith('buy_season_')) {
      const [, , id, season, preco] = data.split('_');
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

      const deducaoSucesso = await deductCredits(chatId, precoNum);
      if (!deducaoSucesso) {
        bot.sendMessage(chatId, '❌ Erro ao processar pagamento. Tente novamente.');
        return;
      }

      const novoSaldo = await getUserCredits(chatId);
      await bot.sendMessage(chatId,
        `✅ *Temporada ${season} Liberada!*\n\n-${formatMoney(precoNum)}\n💳 Novo saldo: ${formatMoney(novoSaldo)}\n\n📤 Salvando ${episodios.length} episódios em "Meu Conteúdo"...\n\n⏰ *Links válidos por 7 dias*`,
        { parse_mode: 'Markdown' }
      );

      let salvos = 0;
      const tituloSerie = state?.data?.title || 'Série';
      for (const ep of episodios) {
        try {
          const token = await salvarConteudoComprado(chatId, ep.id, 'series', tituloSerie, 0, ep.name, season);
          if (token) salvos++;
        } catch (e) {
          console.error('Erro ao salvar episódio:', e.message);
        }
      }

      await bot.sendMessage(chatId,
        `✅ *Temporada ${season} Completa!*\n\n📦 ${salvos} de ${episodios.length} episódios salvos\n⏰ Válidos por 7 dias\n\nAcesse em "📦 Meu Conteúdo" para assistir!`,
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
  if (error.code === 'ETELEGRAM' && error.response?.body?.error_code === 409) {
    console.warn('⚠️ Conflito de polling — outra instância do bot está rodando');
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
// EXPORTS
// ============================
module.exports = {
  bot,
  setModels,
  initBot,
  processarPagamentoAprovado,
  getUserCredits,
  addCredits
};
