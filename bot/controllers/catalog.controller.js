// bot/controllers/catalog.controller.js
const bot = require('../instance');
const config = require('../config');
const state = require('../state');
const contentService = require('../services/content.service');
const userService = require('../services/user.service');
const { formatMoney } = require('../utils/formatters');
const { decodificarHTML, escaparMarkdownSeguro, removerAcentos } = require('../../src/services/text-utils.service');

class CatalogController {
  showMainMenu(chatId, text = '🏠 *Menu Principal*') {
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

  mostrarAlfabeto(chatId, tipo) {
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
    bot.sendMessage(chatId, `🔤 *${tipoTexto} por Letra*\n\nSelecione a primeira letra:`, { 
      parse_mode: 'Markdown', reply_markup: { inline_keyboard: keyboard } 
    });
  }

  async listarPorLetra(chatId, tipo, letra, pagina = 1) {
    try {
      const ITENS_POR_PAGINA = 20;
      await contentService.ensureCacheLoaded();
      const cache = contentService.getCacheSafe();
      const lista = cache[tipo] || [];
      const isAdulto = (nome) => /[\[\(]xxx|\+18|adulto|hentai|playboy|brasileirinhas/i.test(nome || '');

      let resultados;
      if (letra === '#') {
        resultados = lista.filter(i => !isAdulto(i.name) && /^[^a-zA-Z]/.test(decodificarHTML(i.name || '')));
      } else {
        resultados = lista.filter(i => !isAdulto(i.name) && decodificarHTML(i.name || '').toUpperCase().startsWith(letra));
      }

      const totalItens = resultados.length;
      if (totalItens === 0) {
        return bot.sendMessage(chatId, `❌ *Nenhum resultado encontrado com "${letra}"*`, {
          parse_mode: 'Markdown',
          reply_markup: {
            inline_keyboard: [
              [{ text: '🔤 Escolher Outra Letra', callback_data: `alphabet_${tipo}` }],
              [{ text: '🏠 Menu Principal', callback_data: 'back_main' }]
            ]
          }
        });
      }

      const totalPaginas = Math.max(1, Math.ceil(totalItens / ITENS_POR_PAGINA));
      const paginaAtual = Math.min(Math.max(1, pagina), totalPaginas);
      const inicio = (paginaAtual - 1) * ITENS_POR_PAGINA;
      const itensPagina = resultados.slice(inicio, inicio + ITENS_POR_PAGINA);

      let ownedMovieIds = new Set();
      if (tipo === 'movies') {
        ownedMovieIds = await userService.getOwnedMoviesSet(chatId, itensPagina.map(r => r.id));
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
      const notice = tipo === 'movies' ? '\n\n✅ = você já possui (válido)' : '';

      await bot.sendMessage(chatId,
        `🔤 *${tipoTexto} - Letra "${letra}"*\n\n📋 Mostrando ${inicio + 1}-${Math.min(inicio + ITENS_POR_PAGINA, totalItens)} de ${totalItens} resultado${totalItens > 1 ? 's' : ''}${notice}`,
        { parse_mode: 'Markdown', reply_markup: { inline_keyboard: buttons } }
      );
    } catch (error) {
      console.error('Erro ao listar por letra:', error);
      await bot.sendMessage(chatId, '❌ Erro ao buscar conteúdo. Tente novamente.');
    }
  }

  iniciarBusca(chatId, tipo) {
    state.clearUserState(chatId);
    state.setUserState(chatId, { step: `search_${tipo}` });

    const rotulo = tipo === 'movies' ? 'Filme' : tipo === 'series' ? 'Série' : 'Canal';
    const icone = tipo === 'movies' ? '🎥' : tipo === 'series' ? '📺' : '📡';

    bot.sendMessage(chatId, `${icone} *Busca de ${rotulo}*\n\nDigite o nome ou parte do título do conteúdo que você quer encontrar:`, {
      parse_mode: 'Markdown',
      reply_markup: { force_reply: true }
    });
  }

  async renderBuscaPaginada(chatId, termoOriginal, tipo, pagina = 1, msgId = null) {
    try {
      const ITENS_POR_PAGINA = 20;
      await contentService.ensureCacheLoaded();
      const cache = contentService.getCacheSafe();
      const lista = cache[tipo] || [];
      
      const termoBusca = removerAcentos(String(termoOriginal || '').trim()).toLowerCase();
      const isAdulto = (nome) => /[\[\(]xxx|\+18|adulto|hentai|playboy|brasileirinhas/i.test(nome || '');

      const resultados = lista.filter(item => {
        const nomeNormalizado = removerAcentos(decodificarHTML(item?.name || '')).toLowerCase();
        return !isAdulto(item.name) && nomeNormalizado.includes(termoBusca);
      });

      if (resultados.length === 0) {
        const msgErro = `❌ *Nenhum resultado encontrado para:* "${escaparMarkdownSeguro(termoOriginal)}"`;
        const btnErro = { inline_keyboard: [[{ text: '🔄 Tentar Novamente', callback_data: `retry_search_${tipo}` }], [{ text: '🏠 Menu', callback_data: 'back_main' }]] };
        
        if (msgId) {
          return bot.editMessageText(msgErro, { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: btnErro }).catch(() => {});
        }
        return bot.sendMessage(chatId, msgErro, { parse_mode: 'Markdown', reply_markup: btnErro });
      }

      const totalItens = resultados.length;
      const totalPaginas = Math.max(1, Math.ceil(totalItens / ITENS_POR_PAGINA));
      const paginaAtual = Math.min(Math.max(1, pagina), totalPaginas);
      const inicio = (paginaAtual - 1) * ITENS_POR_PAGINA;
      const itensPagina = resultados.slice(inicio, inicio + ITENS_POR_PAGINA);

      state.setUserState(chatId, { step: 'viewing_search', searchTerm: termoOriginal, searchType: tipo });

      let ownedMovieIds = new Set();
      if (tipo === 'movies') {
        ownedMovieIds = await userService.getOwnedMoviesSet(chatId, itensPagina.map(r => r.id));
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
      if (paginaAtual > 1) navRow.push({ text: '◀️ Anterior', callback_data: `searchpage_${paginaAtual - 1}` });
      if (totalPaginas > 1) navRow.push({ text: `📄 ${paginaAtual}/${totalPaginas}`, callback_data: 'noop' });
      if (paginaAtual < totalPaginas) navRow.push({ text: 'Próximo ▶️', callback_data: `searchpage_${paginaAtual + 1}` });
      if (navRow.length > 0) buttons.push(navRow);

      buttons.push([
        { text: '🔎 Nova Busca', callback_data: `retry_search_${tipo}` },
        { text: '🏠 Menu', callback_data: 'back_main' }
      ]);

      const tipoTexto = tipo === 'movies' ? 'Filmes' : 'Séries';
      const textoFinal = `🔎 *Resultados de ${tipoTexto} para:* "${escaparMarkdownSeguro(termoOriginal)}"\n\n📋 Mostrando ${inicio + 1}-${Math.min(inicio + ITENS_POR_PAGINA, totalItens)} de ${totalItens} itens encontrados.`;

      if (msgId) {
        bot.deleteMessage(chatId, msgId).catch(() => {});
      }
      
      await bot.sendMessage(chatId, textoFinal, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: buttons } });

    } catch (error) {
      console.error('Erro ao renderizar busca paginada:', error);
      bot.sendMessage(chatId, '❌ Erro ao processar sua busca.');
    }
  }

  async listarCanaisAoVivo(chatId, pagina = 1) {
    try {
      await contentService.ensureCacheLoaded();
      const canais = contentService.getCacheSafe().livetv || [];

      if (canais.length === 0) {
        return bot.sendMessage(chatId, '❌ *Nenhum canal ao vivo disponível no momento.*', {
          parse_mode: 'Markdown',
          reply_markup: { inline_keyboard: [[{ text: '🔎 Buscar Canais', callback_data: 'retry_search_livetv' }], [{ text: '🏠 Menu Principal', callback_data: 'back_main' }]] }
        });
      }

      const ITENS_POR_PAGINA = 20;
      const totalPaginas = Math.max(1, Math.ceil(canais.length / ITENS_POR_PAGINA));
      const paginaAtual = Math.min(Math.max(1, pagina), totalPaginas);
      const inicio = (paginaAtual - 1) * ITENS_POR_PAGINA;
      const itensPagina = canais.slice(inicio, inicio + ITENS_POR_PAGINA);

      // 🚀 CORREÇÃO AQUI: Mudando de live_details_ID para details_ID_livetv
      const buttons = itensPagina.map((item) => {
        const name = decodificarHTML(item.name || `Canal ${item.id}`);
        return [{ text: `📡 ${name.substring(0, 54)}${name.length > 54 ? '...' : ''}`, callback_data: `details_${item.id}_livetv` }];
      });

      const navRow = [];
      if (paginaAtual > 1) navRow.push({ text: '◀️ Anterior', callback_data: `livepage_${paginaAtual - 1}` });
      if (totalPaginas > 1) navRow.push({ text: `📄 ${paginaAtual}/${totalPaginas}`, callback_data: 'noop' });
      if (paginaAtual < totalPaginas) navRow.push({ text: 'Próximo ▶️', callback_data: `livepage_${paginaAtual + 1}` });
      if (navRow.length > 0) buttons.push(navRow);

      buttons.push([
        { text: '🔎 Buscar Canais', callback_data: 'retry_search_livetv' },
        { text: '🏠 Menu', callback_data: 'back_main' }
      ]);

      await bot.sendMessage(chatId,
        `📡 *Canais ao Vivo*\n\n💰 Valor fixo por canal: ${formatMoney(config.PRECO_LIVETV_FIXO)}\n⏰ Validade do acesso: 24 horas\n\n📋 Mostrando ${inicio + 1}-${Math.min(inicio + ITENS_POR_PAGINA, canais.length)} de ${canais.length} canais`,
        { parse_mode: 'Markdown', reply_markup: { inline_keyboard: buttons } }
      );
    } catch (error) {
      console.error('Erro ao listar canais:', error);
      bot.sendMessage(chatId, '❌ Erro ao listar canais.');
    }
  }

  async renderBuscaCanaisPaginada(chatId, termoOriginal, pagina = 1, msgId = null) {
    await contentService.ensureCacheLoaded();
    const canais = contentService.getCacheSafe().livetv || [];
    const termoBusca = removerAcentos(String(termoOriginal || '').trim()).toLowerCase();
    const resultados = canais.filter(item => removerAcentos(decodificarHTML(item?.name || '')).toLowerCase().includes(termoBusca));

    if (resultados.length === 0) {
      const txtErro = `❌ *Nenhum canal encontrado para:* ${escaparMarkdownSeguro(termoOriginal)}`;
      const btnErro = { inline_keyboard: [[{ text: '🔄 Buscar novamente', callback_data: 'retry_search_livetv' }], [{ text: '🏠 Menu', callback_data: 'back_main' }]] };
      if (msgId) {
        return bot.editMessageText(txtErro, { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: btnErro }).catch(() => {});
      }
      return bot.sendMessage(chatId, txtErro, { parse_mode: 'Markdown', reply_markup: btnErro });
    }

    const ITENS_POR_PAGINA = 20;
    const totalPaginas = Math.max(1, Math.ceil(resultados.length / ITENS_POR_PAGINA));
    const paginaAtual = Math.min(Math.max(1, pagina), totalPaginas);
    const inicio = (paginaAtual - 1) * ITENS_POR_PAGINA;
    const itensPagina = resultados.slice(inicio, inicio + ITENS_POR_PAGINA);

    state.setUserState(chatId, { step: 'viewing_search', searchTerm: termoOriginal, searchType: 'livetv' });

    // 🚀 CORREÇÃO AQUI: Mudando de live_details_ID para details_ID_livetv
    const buttons = itensPagina.map((item) => {
      const name = decodificarHTML(item.name || `Canal ${item.id}`);
      return [{ text: `📡 ${name.substring(0, 54)}${name.length > 54 ? '...' : ''}`, callback_data: `details_${item.id}_livetv` }];
    });

    const navRow = [];
    if (paginaAtual > 1) navRow.push({ text: '◀️ Anterior', callback_data: `livesearchpage_${paginaAtual - 1}` });
    if (totalPaginas > 1) navRow.push({ text: `📄 ${paginaAtual}/${totalPaginas}`, callback_data: 'noop' });
    if (paginaAtual < totalPaginas) navRow.push({ text: 'Próximo ▶️', callback_data: `livesearchpage_${paginaAtual + 1}` });
    if (navRow.length > 0) buttons.push(navRow);

    buttons.push([{ text: '🔎 Nova busca', callback_data: 'retry_search_livetv' }, { text: '📡 Lista completa', callback_data: 'list_livetv' }]);
    buttons.push([{ text: '🏠 Menu Principal', callback_data: 'back_main' }]);

    const textoFinal = `🔎 *Busca de Canais para:* "${escaparMarkdownSeguro(termoOriginal)}"\n\n📋 Mostrando ${inicio + 1}-${Math.min(inicio + ITENS_POR_PAGINA, resultados.length)} de ${resultados.length} resultados`;

    if (msgId) {
      bot.deleteMessage(chatId, msgId).catch(() => {});
    }
    await bot.sendMessage(chatId, textoFinal, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: buttons } });
  }
}

module.exports = new CatalogController();