// bot/controllers/content.controller.js
const fs = require('fs');
const bot = require('../instance');
const config = require('../config');
const state = require('../state');
const db = require('../services/db.service');
const contentService = require('../services/content.service');
const paymentService = require('../services/payment.service');
const userService = require('../services/user.service');
const { formatMoney, formatTimeRemaining, normalizeTitle, paginateList, buildPaginationRow } = require('../utils/formatters');
const { calcularPrecoFinal } = require('../utils/pricing');
const { toTelegramUrl, toAbsoluteUrl } = require('../utils/urls');
const { decodificarHTML, escaparMarkdownSeguro, sanitizarTexto } = require('../../src/services/text-utils.service');
const bunnyCacheService = require('../../src/services/bunny-cache.service');
const logger = require('../../src/lib/logger');

class ContentController {

  async handleDetails(query) {
    const chatId = query.message.chat.id;
    const msgId = query.message.message_id;
    const [, id, type] = query.data.split('_');

    bot.answerCallbackQuery(query.id, { text: '🔄 A carregar...' });
    
    const loadingMsg = await bot.sendMessage(chatId, '🔍 *A carregar detalhes...*\n\nAguarde um segundo enquanto procuro as informações...', { parse_mode: 'Markdown' });
    bot.deleteMessage(chatId, msgId).catch(() => {});

    if (type === 'livetv' || type === 'live') {
      bot.deleteMessage(chatId, loadingMsg.message_id).catch(() => {});
      
      const cache = await contentService.getCacheSafe();
      const canal = (cache.livetv || []).find(item => String(item.id) === String(id));
      
      if (!canal) {
        return bot.sendMessage(chatId, '❌ Canal não localizado no catálogo atual.');
      }
      
      const tituloCanal = decodificarHTML(canal.name || canal.title || `Canal ${id}`);
      const saldoAtual = await paymentService.getUserCredits(chatId);
      const precoCanal = config.PRECO_LIVETV_FIXO || 5; 
      
      let mensagemCanal = `📡 *${escaparMarkdownSeguro(tituloCanal)}*\n\n`;
      mensagemCanal += `📺 *Categoria:* Ao Vivo\n`;
      mensagemCanal += `💰 *Preço para libertar:* ${formatMoney(precoCanal)}\n`;
      mensagemCanal += `💳 *O teu saldo:* ${formatMoney(saldoAtual)}`;
      
      const keyboardCanal = [];
      if (saldoAtual < precoCanal) {
        keyboardCanal.push([{ text: '💰 Adicionar Créditos', callback_data: 'menu_add_credits' }]);
      } else {
        keyboardCanal.push([{ text: `▶️ Assistir Agora - ${formatMoney(precoCanal)}`, callback_data: `watch_live_${id}_${precoCanal}` }]);
      }
      keyboardCanal.push([{ text: '🏠 Menu Principal', callback_data: 'back_main' }]);
      
      const imgUrl = canal.coverUrl || canal.logo || canal.logoUrl || canal.capa || '';
      if (imgUrl) {
        try {
          const urlAbsoluta = imgUrl.startsWith('http') ? imgUrl : `${String(config.dynamic.DOMINIO_PUBLICO).replace(/\/$/, '')}${imgUrl}`;
          await bot.sendPhoto(chatId, urlAbsoluta, { caption: `📡 Canal: ${tituloCanal}` }).catch(() => {});
        } catch (e) {}
      }
      
      return bot.sendMessage(chatId, mensagemCanal, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: keyboardCanal } });
    }

    const buscarDetalhes = contentService.vouverService.buscarDetalhes;
    if (!buscarDetalhes) {
      bot.deleteMessage(chatId, loadingMsg.message_id).catch(() => {});
      return bot.sendMessage(chatId, '❌ Serviço de detalhes indisponível no momento.');
    }

    const detalhes = await buscarDetalhes(id, type);
    if (!detalhes) {
      bot.deleteMessage(chatId, loadingMsg.message_id).catch(() => {});
      return bot.sendMessage(chatId, '❌ Erro ao carregar detalhes do conteúdo.');
    }

    bot.deleteMessage(chatId, loadingMsg.message_id).catch(() => {});
    await state.setUserState(chatId, { step: 'details', data: detalhes, id, type });

    const saldoAtual = await paymentService.getUserCredits(chatId);
    const tituloSeguro = escaparMarkdownSeguro(detalhes.title);

    let mensagem = `🎬 *${tituloSeguro}*\n\n`;
    if (detalhes.info?.genero) mensagem += `🎭 ${escaparMarkdownSeguro(detalhes.info.genero)}\n`;
    if (detalhes.info?.ano) mensagem += `📅 ${detalhes.info.ano}\n`;
    if (detalhes.info?.imdb) mensagem += `⭐ IMDB: ${detalhes.info.imdb}\n`;
    if (detalhes.info?.sinopse) mensagem += `\n${escaparMarkdownSeguro(String(detalhes.info.sinopse).substring(0, 400))}\n\n`;

    const keyboard = [];

    if (detalhes.mediaType === 'movie') {
      let minutos = parseInt(detalhes.info?.duracaoMinutos || detalhes.info?.duracao || 0, 10);
      if (!Number.isFinite(minutos) || minutos <= 0) {
        minutos = await contentService.vouverService.estimarDuracao('movie', id);
      }

      const pricing = calcularPrecoFinal({ mediaType: 'movie', duracaoMinutos: minutos });
      mensagem += `⏱️ Duração: ~${pricing.duracaoMinutos}min\n💰 Preço: ${formatMoney(pricing.precoFinal)}\n⏰ Válido por: 24 horas\n💳 O teu saldo: ${formatMoney(saldoAtual)}`;

      if (saldoAtual < pricing.precoFinal) {
        keyboard.push([{ text: '💰 Adicionar Créditos', callback_data: 'menu_add_credits' }]);
      } else {
        keyboard.push([{ text: `▶️ Assistir - ${formatMoney(pricing.precoFinal)}`, callback_data: `watch_movie_${id}_${pricing.precoFinal}_${pricing.duracaoMinutos}` }]);
      }
    } else {
      mensagem += `📺 *Temporadas disponíveis:*\n\n⏰ Válido por: 7 dias\n💳 O teu saldo: ${formatMoney(saldoAtual)}\n\n`;
      Object.keys(detalhes.seasons || {}).forEach((seasonKey) => {
        const eps = detalhes.seasons[seasonKey] || [];
        keyboard.push([{ text: `Temporada ${seasonKey} (${eps.length} ep)`, callback_data: `season_${id}_${String(seasonKey)}` }]);
      });
    }

    keyboard.push([{ text: '🏠 Menu Principal', callback_data: 'back_main' }]);

    let fotoEnviada = false;
    try {
      if (config.dynamic.DOMINIO_PUBLICO && detalhes.coverUrl) {
        const urlAbsoluta = detalhes.coverUrl.startsWith('http')
          ? detalhes.coverUrl
          : `${String(config.dynamic.DOMINIO_PUBLICO).replace(/\/$/, '')}${detalhes.coverUrl}`;

        await bot.sendPhoto(chatId, urlAbsoluta, { 
          caption: detalhes.title ? `🎬 Detalhes: ${detalhes.title}` : 'Detalhes' 
        });
        fotoEnviada = true;
      }
    } catch (urlErr) {
      console.warn('⚠️ Falha ao carregar capa via URL pública obscurecida:', urlErr.message);
    }

    if (!fotoEnviada && detalhes.coverPath && fs.existsSync(detalhes.coverPath)) {
      await bot.sendPhoto(chatId, fs.createReadStream(detalhes.coverPath), { 
        caption: detalhes.title ? `🎬 Detalhes: ${detalhes.title}` : 'Detalhes' 
      }).then(() => { fotoEnviada = true; }).catch((err) => console.error('❌ Erro no fallback Stream:', err.message));
    }

    if (!fotoEnviada) {
      const fallbackWebUrl = toTelegramUrl(toAbsoluteUrl(detalhes.coverUrl || detalhes.capa_url || detalhes.capa || ''));
      if (fallbackWebUrl) {
        await bot.sendPhoto(chatId, fallbackWebUrl, { 
          caption: detalhes.title ? `🎬 Detalhes: ${detalhes.title}` : 'Detalhes' 
        }).catch(() => {});
      }
    }

    await bot.sendMessage(chatId, mensagem, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: keyboard } });
  }

  async handleWatchMovie(query) {
    const chatId = query.message.chat.id;
    const parts = query.data.split('_');
    const id = parts[2];
    const precoNum = parseInt(parts[3], 10);
    const minutosReais = parts[4] ? parseInt(parts[4], 10) : 110;
    
    // 🚀 MUTEX: Bloqueio de Duplo Clique (5 segundos)
    const actionLock = await bunnyCacheService.redisConnection.set(`lock:btn:${chatId}:${id}`, '1', 'EX', 5, 'NX');
    if (!actionLock) {
      return bot.answerCallbackQuery(query.id, { text: '⏳ A processar... Aguarde.', show_alert: true });
    }

    const currentState = await state.getUserState(chatId);
    bot.answerCallbackQuery(query.id);

    const saldoAtual = await paymentService.getUserCredits(chatId);
    if (saldoAtual < precoNum) {
      return bot.sendMessage(chatId, `❌ *Saldo Insuficiente*\n\nPossuis: ${formatMoney(saldoAtual)}\nNecessário: ${formatMoney(precoNum)}`, {
        parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: '💰 Adicionar Créditos', callback_data: 'menu_add_credits' }]] }
      });
    }

    const deducaoSucesso = await paymentService.deductCredits(chatId, precoNum);
    if (!deducaoSucesso) return bot.sendMessage(chatId, '❌ Erro ao processar pagamento. Tenta novamente.');

    const titulo = currentState?.data?.title || 'Filme';
    const saved = await contentService.salvarConteudoComprado(chatId, id, 'movie', titulo, precoNum);
    
    if (!saved?.token) {
      await paymentService.addCredits(chatId, precoNum);
      return bot.sendMessage(chatId, '❌ Erro ao gerar link. Créditos devolvidos.');
    }

    const novoSaldo = await paymentService.getUserCredits(chatId);
    await bot.sendMessage(chatId, `✅ *Pagamento Confirmado!*\n\n🎬 Duração: ${minutosReais}min\n💰 -${formatMoney(precoNum)}\n💳 Novo saldo: ${formatMoney(novoSaldo)}\n\n⏰ Link válido por *24 horas*`, { parse_mode: 'Markdown' });

    this._iniciarCacheComNotificacao(chatId, saved.purchase, `🎬 ${titulo} (${minutosReais}min)`, 'movie');
  }

  async handleSeason(query) {
    const chatId = query.message.chat.id;
    const msgId = query.message.message_id;
    const parts = query.data.split('_');
    const id = parts[1];
    const season = String(parts[2]);
    
    let page = 1;
    if (parts.length >= 5 && parts[3] === 'page') {
      page = parseInt(parts[4], 10) || 1;
    }

    const currentState = await state.getUserState(chatId);
    if (!currentState || !currentState.data || !currentState.data.seasons) {
      return bot.answerCallbackQuery(query.id, { text: 'Sessão perdida.' });
    }

    let episodios = currentState.data.seasons[season] || currentState.data.seasons[Number(season)] || [];
    if (!Array.isArray(episodios) || episodios.length === 0) {
      return bot.answerCallbackQuery(query.id, { text: 'Temporada vazia ou inválida.' });
    }

    bot.answerCallbackQuery(query.id);

    const EPISODES_PER_PAGE = 10;
    const pageData = paginateList(episodios, page, EPISODES_PER_PAGE);

    const episodeIds = episodios.map(ep => String(ep.id));
    const ownedEpisodes = await userService.getOwnedEpisodesSet(chatId, currentState.data.title, season, episodeIds);

    let precoTotal = 0;
    let restantes = 0;
    const estimarDuracao = contentService.vouverService.estimarDuracao;

    for (const ep of episodios) {
      if (ownedEpisodes.has(String(ep.id))) continue;
      let min = await estimarDuracao('series', ep.id);
      if (!Number.isFinite(min) || min <= 0) min = 24;
      const p = calcularPrecoFinal({ mediaType: 'series', duracaoMinutos: min });
      precoTotal += p.precoFinal;
      restantes += 1;
    }

    const saldoAtual = await paymentService.getUserCredits(chatId);
    const keyboard = [];

    for (let i = 0; i < pageData.items.length; i++) {
      const ep = pageData.items[i];
      const globalIndex = (pageData.current - 1) * EPISODES_PER_PAGE + i;
      const name = decodificarHTML(ep.name || `Episódio ${globalIndex + 1}`);
      const owned = ownedEpisodes.has(String(ep.id));
      const prefix = owned ? '✅ ' : '';
      keyboard.push([{
        text: `${prefix}${globalIndex + 1}. ${name.substring(0, 45)}`,
        callback_data: `episode_${ep.id}_${season}`
      }]);
    }

    const navRow = buildPaginationRow(`season_${id}_${season}_page`, pageData.current, pageData.totalPages);
    if (navRow.length > 0) keyboard.push(navRow);

    if (restantes === 0) {
      keyboard.push([{ text: '✅ Temporada inteira já adquirida', callback_data: 'noop' }]);
    } else if (saldoAtual >= precoTotal) {
      keyboard.push([{ text: `📥 Comprar Temporada (${restantes} ep) - ${formatMoney(precoTotal)}`, callback_data: `buy_season_${id}_${season}_${precoTotal}` }]);
    } else {
      keyboard.push([{ text: `⚠️ Saldo Insuficiente - Faltam ${formatMoney(precoTotal - saldoAtual)}`, callback_data: 'menu_add_credits' }]);
    }

    keyboard.push([{ text: '⬅️ Voltar aos Detalhes', callback_data: `details_${id}_series` }]);
    keyboard.push([{ text: '🏠 Menu Principal', callback_data: 'back_main' }]);

    bot.deleteMessage(chatId, msgId).catch(() => {});

    await bot.sendMessage(chatId,
      `📺 *${escaparMarkdownSeguro(currentState.data.title)}*\n*Temporada ${season}*\n\nTotal: ${episodios.length} episódios\n📋 Página ${pageData.current} de ${pageData.totalPages}\n💰 Valor restante da Temporada: ${formatMoney(precoTotal)}\n💳 O teu Saldo: ${formatMoney(saldoAtual)}\n\nSelecione um episódio para assistir:`,
      { parse_mode: 'Markdown', reply_markup: { inline_keyboard: keyboard } }
    );
  }

  async handleEpisode(query) {
    const chatId = query.message.chat.id;
    const msgId = query.message.message_id;
    const [, epId, season] = query.data.split('_');
    
    const currentState = await state.getUserState(chatId);

    if (!currentState || !currentState.data || !currentState.data.seasons) {
      return bot.answerCallbackQuery(query.id, { text: 'Sessão perdida.' });
    }

    let episodios = currentState.data.seasons[season] || currentState.data.seasons[Number(season)] || [];
    const episodio = episodios.find(e => String(e.id) === String(epId));
    if (!episodio) return bot.answerCallbackQuery(query.id, { text: 'Episódio não localizado.' });

    bot.answerCallbackQuery(query.id);

    const min = await contentService.vouverService.estimarDuracao('series', epId);
    const pricing = calcularPrecoFinal({ mediaType: 'series', duracaoMinutos: min });
    const saldoAtual = await paymentService.getUserCredits(chatId);

    bot.deleteMessage(chatId, msgId).catch(() => {});

    const PurchasedContentModel = db.getPurchasedContentModel();
    const ownedEpisode = await PurchasedContentModel.findOne({
      userId: chatId, mediaType: 'series', videoId: String(epId),
      ...userService.getPurchaseVisibilityFilter({ expiresAt: { $gt: new Date() } })
    });

    let mensagem = `📺 *${escaparMarkdownSeguro(currentState.data.title)}*\n*Temporada ${season} - ${escaparMarkdownSeguro(episodio.name)}*\n\n⏱️ Duração: ~${pricing.duracaoMinutos}min\n⏰ Validade: 7 dias\n💳 O teu saldo: ${formatMoney(saldoAtual)}`;
    const keyboard = [];

    if (ownedEpisode) {
      mensagem += `\n\n✅ Já possuis acesso ativo a este episódio!`;
      keyboard.push([{ text: '▶️ Assistir Agora', url: `${config.dynamic.DOMINIO_PUBLICO}/player/${ownedEpisode.token}` }]);
    } else if (saldoAtual < pricing.precoFinal) {
      mensagem += `\n💰 Preço: ${formatMoney(pricing.precoFinal)}\n\n⚠️ Saldo insuficiente! Faltam ${formatMoney(pricing.precoFinal - saldoAtual)}`;
      keyboard.push([{ text: '💰 Adicionar Créditos', callback_data: 'menu_add_credits' }]);
    } else {
      mensagem += `\n💰 Preço: ${formatMoney(pricing.precoFinal)}`;
      keyboard.push([{ text: `▶️ Comprar e Assistir - ${formatMoney(pricing.precoFinal)}`, callback_data: `watch_ep_${epId}_${pricing.precoFinal}_${season}` }]);
    }

    keyboard.push([{ text: '⬅️ Voltar à Temporada', callback_data: `season_${currentState.id}_${season}` }]);
    keyboard.push([{ text: '🏠 Menu Principal', callback_data: 'back_main' }]);

    await bot.sendMessage(chatId, mensagem, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: keyboard } });
  }

  async handleWatchEpisode(query) {
    const chatId = query.message.chat.id;
    const [, , epId, preco, season] = query.data.split('_');
    const precoNum = parseInt(preco, 10);
    
    // 🚀 MUTEX: Bloqueio de Duplo Clique (5 segundos)
    const actionLock = await bunnyCacheService.redisConnection.set(`lock:btn:${chatId}:${epId}`, '1', 'EX', 5, 'NX');
    if (!actionLock) return bot.answerCallbackQuery(query.id, { text: '⏳ A processar... Aguarde.', show_alert: true });

    const currentState = await state.getUserState(chatId);
    bot.answerCallbackQuery(query.id);

    const saldoAtual = await paymentService.getUserCredits(chatId);
    if (saldoAtual < precoNum) return bot.sendMessage(chatId, '❌ Saldo insuficiente.');

    const deducaoSucesso = await paymentService.deductCredits(chatId, precoNum);
    if (!deducaoSucesso) return bot.sendMessage(chatId, '❌ Erro no processamento do saldo.');

    let nomeEpisodio = 'Episódio';
    let episodeIndex = null;
    let totalEpisodes = null;
    let seriesId = currentState?.id || null;

    if (currentState?.data?.seasons?.[season]) {
      const list = currentState.data.seasons[season];
      const idx = list.findIndex(e => String(e.id) === String(epId));
      if (idx >= 0) {
        nomeEpisodio = list[idx].name || nomeEpisodio;
        episodeIndex = idx + 1;
        totalEpisodes = list.length;
      }
    }

    const tituloSerie = currentState?.data?.title || 'Série';
    const saved = await contentService.salvarConteudoComprado(chatId, epId, 'series', tituloSerie, precoNum, nomeEpisodio, season, { seriesId, episodeIndex, totalEpisodes });

    if (!saved?.token) {
      await paymentService.addCredits(chatId, precoNum);
      return bot.sendMessage(chatId, '❌ Erro ao libertar o link.');
    }

    const novoSaldo = await paymentService.getUserCredits(chatId);
    await bot.sendMessage(chatId, `✅ *Pagamento Confirmado!*\n\n📺 Episódio: ${escaparMarkdownSeguro(nomeEpisodio)}\n💰 -${formatMoney(precoNum)}\n💳 Novo saldo: ${formatMoney(novoSaldo)}`, { parse_mode: 'Markdown' });

    this._iniciarCacheComNotificacao(chatId, saved.purchase, `📺 ${nomeEpisodio}`, 'series');
  }

  async handleBuySeason(query) {
    const chatId = query.message.chat.id;
    const [, , id, season, preco] = query.data.split('_');
    const precoNum = parseInt(preco, 10);
    
    // 🚀 MUTEX: Bloqueio de Duplo Clique (5 segundos)
    const actionLock = await bunnyCacheService.redisConnection.set(`lock:btn:${chatId}:season:${season}`, '1', 'EX', 5, 'NX');
    if (!actionLock) return bot.answerCallbackQuery(query.id, { text: '⏳ A processar... Aguarde.', show_alert: true });

    const currentState = await state.getUserState(chatId);
    bot.answerCallbackQuery(query.id);

    let episodios = currentState?.data?.seasons?.[season] || [];
    if (episodios.length === 0) return bot.sendMessage(chatId, '❌ Falha ao recuperar episódios.');

    const episodeIds = episodios.map(ep => String(ep.id));
    const ownedEpisodes = await userService.getOwnedEpisodesSet(chatId, currentState.data.title, season, episodeIds);
    const restantes = episodios.filter(ep => !ownedEpisodes.has(String(ep.id)));

    if (restantes.length === 0) return bot.sendMessage(chatId, '✅ Já tens todos os episódios ativos!');

    const saldoAtual = await paymentService.getUserCredits(chatId);
    if (saldoAtual < precoNum) return bot.sendMessage(chatId, '❌ Saldo insuficiente.');

    const deducaoSucesso = await paymentService.deductCredits(chatId, precoNum);
    if (!deducaoSucesso) return bot.sendMessage(chatId, '❌ Falha ao processar débito.');

    const novoSaldo = await paymentService.getUserCredits(chatId);
    const statusMsg = await bot.sendMessage(chatId, `✅ *Compra Confirmada!*\n\n💰 -${formatMoney(precoNum)}\n💳 Novo saldo: ${formatMoney(novoSaldo)}\n\n⏳ A libertar ${restantes.length} episódios na fila...\nDisponíveis agora: 0/${restantes.length}`, { parse_mode: 'Markdown' });

    const bulkStateId = `season-${id}-${season}-${Date.now()}`;
    
    await bunnyCacheService.redisConnection.set(`bulk:${bulkStateId}:total`, restantes.length);
    await bunnyCacheService.redisConnection.set(`bulk:${bulkStateId}:ready`, 0);

    const tituloSerie = currentState?.data?.title || 'Série';
    const seriesId = currentState?.id || null;
    const totalEpisodes = episodios.length;

    for (let i = 0; i < restantes.length; i++) {
      const ep = restantes[i];
      const episodeIndex = episodios.findIndex(e => String(e.id) === String(ep.id)) + 1;

      const saved = await contentService.salvarConteudoComprado(chatId, ep.id, 'series', tituloSerie, 0, ep.name, season, { seriesId, episodeIndex, totalEpisodes });
      
      if (saved?.token) {
        // 🚀 MUTEX: Bloqueio de Infraestrutura de Massa (Anti-Double FFmpeg para a mesma série)
        const lockKey = `lock:transcode:${ep.id}`;
        const lockAdquirido = await bunnyCacheService.redisConnection.set(lockKey, '1', 'EX', 900, 'NX');
        
        if (lockAdquirido) {
          bunnyCacheService.enqueue(saved.purchase, {
            chatId: chatId,
            statusMessageId: statusMsg.message_id,
            bulkStateId: bulkStateId,
            episodeName: ep.name
          });
        }
      }
    }
  }

  async handleWatchLive(query) {
    const chatId = query.message.chat.id;
    const [, , id, preco] = query.data.split('_');
    const precoNum = parseInt(preco, 10);

    // 🚀 MUTEX: Bloqueio de Duplo Clique (5 segundos)
    const actionLock = await bunnyCacheService.redisConnection.set(`lock:btn:${chatId}:live:${id}`, '1', 'EX', 5, 'NX');
    if (!actionLock) return bot.answerCallbackQuery(query.id, { text: '⏳ A processar... Aguarde.', show_alert: true });

    bot.answerCallbackQuery(query.id);
    const saldoAtual = await paymentService.getUserCredits(chatId);

    if (saldoAtual < precoNum) return bot.sendMessage(chatId, '❌ Saldo insuficiente.');

    const deducaoSucesso = await paymentService.deductCredits(chatId, precoNum);
    if (!deducaoSucesso) return bot.sendMessage(chatId, '❌ Erro ao deduzir créditos.');

    const cache = await contentService.getCacheSafe();
    const canal = (cache.livetv || []).find(item => String(item.id) === String(id));
    const tituloCanal = decodificarHTML(canal?.name || `Canal ${id}`);

    const saved = await contentService.salvarConteudoComprado(chatId, id, 'livetv', tituloCanal, precoNum);
    if (!saved?.token) {
      await paymentService.addCredits(chatId, precoNum);
      return bot.sendMessage(chatId, '❌ Falha ao processar link de transmissão.');
    }

    const novoSaldo = await paymentService.getUserCredits(chatId);
    await bot.sendMessage(chatId, `✅ *Pagamento Confirmado!*\n\n📡 Canal: ${escaparMarkdownSeguro(tituloCanal)}\n💰 -${formatMoney(precoNum)}\n💳 Novo Saldo: ${formatMoney(novoSaldo)}`, { parse_mode: 'Markdown' });

    this._enviarVideoComLink(chatId, saved.token, `📡 ${tituloCanal}`, precoNum, tituloCanal, 'livetv');
  }

  async mostrarMeuConteudo(chatId) {
    try {
      const PurchasedContentModel = db.getPurchasedContentModel();
      const conteudos = await PurchasedContentModel.find({
        userId: chatId, ...userService.getPurchaseVisibilityFilter({ expiresAt: { $gt: new Date() } })
      }).sort({ purchaseDate: -1 });

      if (conteudos.length === 0) {
        return bot.sendMessage(chatId, `📦 *O Meu Conteúdo*\n\nNão possuis nenhum conteúdo ativo.`, {
          parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: '🔍 Buscar Filmes', callback_data: 'retry_search_movies' }], [{ text: '🏠 Menu', callback_data: 'back_main' }]] }
        });
      }

      const groups = this._buildMeuConteudoGroups(conteudos);
      await state.setUserState(chatId, { myContent: groups });

      const buttons = [];
      if (groups.movies.length > 0) buttons.push([{ text: `🎬 Filmes (${groups.movies.length})`, callback_data: 'mycontent_movies' }]);
      if (groups.series.length > 0) buttons.push([{ text: `📺 Séries (${groups.series.length})`, callback_data: 'mycontent_series' }]);
      if (groups.livetv.length > 0) buttons.push([{ text: `📡 Canais (${groups.livetv.length})`, callback_data: 'mycontent_live' }]);
      buttons.push([{ text: '🏠 Menu Principal', callback_data: 'back_main' }]);

      await bot.sendMessage(chatId, `📦 *O Meu Conteúdo*\n\nEscolhe uma categoria abaixo:`, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: buttons } });
    } catch (e) {
      bot.sendMessage(chatId, '❌ Erro ao abrir o conteúdo.');
    }
  }

  async mostrarMeuConteudoFilmes(chatId, page = 1) {
    const currentState = await state.getUserState(chatId);
    const myContent = currentState?.myContent;
    if (!myContent) return this.mostrarMeuConteudo(chatId);

    const pageData = paginateList(myContent.movies, page, 10);
    const buttons = pageData.items.map(item => [{
      text: `🎬 ${item.title.substring(0, 40)} | ${formatTimeRemaining(item.expiresAt)}`,
      callback_data: `mycontent_details_${item._id}`
    }]);

    const navRow = buildPaginationRow('mycontent_movies_page', pageData.current, pageData.totalPages);
    if (navRow.length > 0) buttons.push(navRow);
    buttons.push([{ text: '⬅️ Voltar', callback_data: 'my_content' }]);

    await bot.sendMessage(chatId, `🎬 *Os Meus Filmes Ativos*`, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: buttons } });
  }

  async mostrarMeuConteudoSeries(chatId, page = 1) {
    const currentState = await state.getUserState(chatId);
    const myContent = currentState?.myContent;
    if (!myContent) return this.mostrarMeuConteudo(chatId);

    const pageData = paginateList(myContent.series, page, 10);
    const buttons = pageData.items.map((serie, idx) => [{
      text: `📺 ${serie.title.substring(0, 40)} (${serie.totalEpisodes} ep)`,
      callback_data: `myseries_${(pageData.current - 1) * 10 + idx}`
    }]);

    const navRow = buildPaginationRow('mycontent_series_page', pageData.current, pageData.totalPages);
    if (navRow.length > 0) buttons.push(navRow);
    buttons.push([{ text: '⬅️ Voltar', callback_data: 'my_content' }]);

    await bot.sendMessage(chatId, `📺 *As Minhas Séries Ativas*`, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: buttons } });
  }

  async mostrarMeuConteudoLive(chatId, page = 1) {
    const currentState = await state.getUserState(chatId);
    const myContent = currentState?.myContent;
    if (!myContent) return this.mostrarMeuConteudo(chatId);

    const pageData = paginateList(myContent.livetv, page, 10);
    const buttons = pageData.items.map(item => [{
      text: `📡 ${item.title.substring(0, 40)} | ${formatTimeRemaining(item.expiresAt)}`,
      callback_data: `mycontent_details_${item._id}`
    }]);

    const navRow = buildPaginationRow('mycontent_live_page', pageData.current, pageData.totalPages);
    if (navRow.length > 0) buttons.push(navRow);
    buttons.push([{ text: '⬅️ Voltar', callback_data: 'my_content' }]);

    await bot.sendMessage(chatId, `📡 *Os Meus Canais Ativos*`, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: buttons } });
  }

  async mostrarMeuConteudoSerieDetalhes(chatId, index, page = 1) {
    const currentState = await state.getUserState(chatId);
    const myContent = currentState?.myContent;
    if (!myContent) return this.mostrarMeuConteudo(chatId);
    
    const serie = myContent.series[index];
    if (!serie) return this.mostrarMeuConteudoSeries(chatId);

    const episodeEntries = [];
    for (const [seasonKey, episodes] of serie.seasons.entries()) {
      for (const ep of episodes) {
        episodeEntries.push({ season: seasonKey, label: `▶️ ${ep.episodeName || 'Episódio'}`, expiresAt: ep.expiresAt, id: ep._id });
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
      buttons.push([{ text: `${entry.label} | ${formatTimeRemaining(entry.expiresAt)}`, callback_data: `mycontent_details_${entry.id}` }]);
    }

    const navRow = buildPaginationRow(`myseries_${index}_page`, pageData.current, pageData.totalPages);
    if (navRow.length > 0) buttons.push(navRow);
    buttons.push([{ text: '⬅️ Voltar', callback_data: 'mycontent_series' }]);

    await bot.sendMessage(chatId, `📺 *${escaparMarkdownSeguro(serie.title)}*`, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: buttons } });
  }

  async mostrarDetalhesConteudo(chatId, contentId) {
    if (!contentId || contentId === 'undefined') {
      return bot.sendMessage(chatId, '❌ Este conteúdo expirou ou é inválido.\n\nRetorna ao menu e efetua a compra novamente.', {
        reply_markup: { inline_keyboard: [[{ text: '🏠 Menu Principal', callback_data: 'back_main' }]] }
      });
    }

    try {
      const PurchasedContentModel = db.getPurchasedContentModel();
      const content = await PurchasedContentModel.findById(contentId);
      if (!content) return bot.sendMessage(chatId, '❌ Conteúdo indisponível.');

      const playerUrl = `${config.dynamic.DOMINIO_PUBLICO}/player/${content.token}`;
      
      let disclaimer = `⚠️ *AVISO DE STREAMING FASTTV* ⚠️\n`;
      disclaimer += `• _Para correr sem travamentos, utiliza uma ligação Wi-Fi/Rede Estável._\n`;
      disclaimer += `• _Recomendamos abrir o link no Google Chrome ou Safari._\n`;
      disclaimer += `• _Se o player encravar no início, atualiza (F5) a página._\n\n`;

      const msg = `${disclaimer}🎯 *Link Libertado*\n\n🍿 Conteúdo: *${escaparMarkdownSeguro(content.title)}*\n${content.episodeName ? `📺 Ep: ${escaparMarkdownSeguro(content.episodeName)}\n` : ''}\n⏰ Tempo restante: ${formatTimeRemaining(content.expiresAt)}`;
      
      await bot.sendMessage(chatId, msg, {
        parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: [[{ text: '▶️ Assistir Agora', url: playerUrl }], [{ text: '📦 Voltar', callback_data: 'my_content' }]] }
      });
    } catch (error) {
      logger.error(`[ContentController] Erro ao buscar ID do conteúdo: ${contentId}`, error);
      bot.sendMessage(chatId, '❌ Erro ao procurar informações do conteúdo na base de dados.');
    }
  }

  _buildMeuConteudoGroups(conteudos) {
    const movies = [];
    const livetv = [];
    const seriesMap = new Map();

    for (const item of conteudos) {
      const title = decodificarHTML(item.title || '');
      const purchaseDate = item.purchaseDate ? new Date(item.purchaseDate) : new Date(0);
      const plainItem = item.toObject ? item.toObject() : item;

      if (item.mediaType === 'movie') { movies.push({ ...plainItem, title, purchaseDate }); continue; }
      if (item.mediaType === 'livetv' || item.mediaType === 'live') { livetv.push({ ...plainItem, title, purchaseDate }); continue; }

      const key = normalizeTitle(title || plainItem.title || '');
      if (!seriesMap.has(key)) seriesMap.set(key, { title: title || plainItem.title, seasons: new Map(), totalEpisodes: 0, lastPurchaseDate: purchaseDate });
      
      const group = seriesMap.get(key);
      if (purchaseDate > group.lastPurchaseDate) group.lastPurchaseDate = purchaseDate;
      const seasonKey = String(plainItem.season || '1');
      if (!group.seasons.has(seasonKey)) group.seasons.set(seasonKey, []);
      group.seasons.get(seasonKey).push({ ...plainItem, episodeName: plainItem.episodeName, expiresAt: plainItem.expiresAt, _id: plainItem._id });
      group.totalEpisodes += 1;
    }
    
    return { movies, livetv, series: Array.from(seriesMap.values()) };
  }

  // 🚀 MUTEX: Bloqueio de Infraestrutura (15 Minutos) para Transcodes Paralelos
  async _iniciarCacheComNotificacao(chatId, purchase, caption, mediaType) {
    const videoId = purchase.videoId;
    const lockKey = `lock:transcode:${videoId}`;
    
    // Tenta adquirir o bloqueio por 15 minutos (900 segundos) para impedir downloads simultâneos do mesmo vídeo
    const lockAdquirido = await bunnyCacheService.redisConnection.set(lockKey, '1', 'EX', 900, 'NX');

    if (!lockAdquirido) {
      // Outro utilizador já ativou a preparação deste conteúdo! Evitamos enviar para o BullMQ de novo.
      await bot.sendMessage(chatId, `🍿 *Infraestrutura Ativa!*\n\nEste conteúdo já está a ser descarregado e preparado neste exato momento (outro utilizador solicitou há pouco tempo).\n\nGarantiste um atalho! Vai à tua aba 📦 *O Meu Conteúdo* dentro de alguns minutos para assistires.`, { parse_mode: 'Markdown' });
      return;
    }

    // Se a tranca foi adquirida com sucesso, a infraestrutura prossegue normalmente
    const msg = await bot.sendMessage(chatId, `⏳ *A preparar o teu conteúdo no servidor...*\n\nA tua solicitação entrou na fila de processamento automático do Redis.`, { parse_mode: 'Markdown' }).catch(() => null);

    bunnyCacheService.enqueue(purchase, {
      chatId: chatId,
      statusMessageId: msg ? msg.message_id : null,
      caption: caption,
      mediaType: mediaType
    });
  }

  async _enviarVideoComLink(chatId, token, caption, precoNum, videoInfo, mediaType = 'movie') {
    const playerUrl = `${config.dynamic.DOMINIO_PUBLICO}/player/${token}`;
    
    let disclaimer = `⚠️ *AVISO DE STREAMING FASTTV* ⚠️\n`;
    disclaimer += `• _Para correr sem travamentos, utiliza uma ligação Wi-Fi/Rede Estável._\n`;
    disclaimer += `• _Recomendamos abrir o link no Google Chrome ou Safari._\n`;
    disclaimer += `• _Se o player encravar no início, atualiza (F5) a página._\n\n`;

    await bot.sendMessage(chatId, `${disclaimer}✅ *Libertado! Clica no player para assistir:*\n\n${escaparMarkdownSeguro(caption)}`, {
      parse_mode: 'Markdown',
      reply_markup: { inline_keyboard: [[{ text: '▶️ Assistir Agora', url: playerUrl }], [{ text: '📦 O Meu Conteúdo', callback_data: 'my_content' }]] }
    });
  }
}

module.exports = new ContentController();