const axios = require('axios');
const cheerio = require('cheerio');
const iconv = require('iconv-lite');
const env = require('../config/env');
const logger = require('../lib/logger');
const { getSessionCookiesRaw } = require('./content-cache.service');

// Importa o nosso novo serviço de limpeza
const { limparTexto } = require('./text-utils.service');

const BASE_URL = env.BASE_URL || 'http://vouver.me';



function decodeHtml(buffer) {
  for (const enc of ['ISO-8859-1', 'Windows-1252', 'UTF-8', 'latin1']) {
    try {
      const decoded = iconv.decode(Buffer.from(buffer), enc);
      if (!decoded.includes('â€') && !decoded.includes('?â€')) return decoded;
    } catch {}
  }
  return corrigirCaracteresEspeciais(iconv.decode(Buffer.from(buffer), 'ISO-8859-1'));
}

function isBlockedPage(html = '') {
  const t = String(html).toLowerCase();
  return (
    t.includes('you are unable to access') ||
    t.includes('attention required') ||
    t.includes('cf-browser-verification') ||
    (t.includes('cloudflare') && t.includes('ray id')) ||
    t.includes('access denied')
  );
}

async function fetchDetailHtml(detailUrl) {
  const sessionCookies = getSessionCookiesRaw();

  const headers = {
    'User-Agent':
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7',
    Referer: `${BASE_URL}/index.php?page=homepage`,
    'Sec-Fetch-Site': 'same-origin',
    'Sec-Fetch-Mode': 'navigate',
    Connection: 'keep-alive'
  };

  if (sessionCookies) headers.Cookie = sessionCookies;

  const r = await axios.get(detailUrl, {
    headers,
    responseType: 'arraybuffer',
    timeout: 30000,
    maxRedirects: 5,
    validateStatus: (s) => s < 500
  });

  const html = decodeHtml(r.data);
  if (isBlockedPage(html)) return null;
  return html;
}

async function buscarDetalhes(id, type) {
  try {
    const pageType = type === 'movies' ? 'moviedetail' : 'seriesdetail';
    const detailUrl = `${BASE_URL}/index.php?page=${pageType}&id=${id}`;

    let html = await fetchDetailHtml(detailUrl);

    // fallback do legado: se seriesdetail vier vazio, tenta moviedetail
    if (!html && type !== 'movies') {
      html = await fetchDetailHtml(`${BASE_URL}/index.php?page=moviedetail&id=${id}`);
    }

    if (!html) {
      logger.warn({ msg: 'Detalhes bloqueado/sem html', id, type });
      return null;
    }

    let $ = cheerio.load(html, { decodeEntities: false });

    // outro fallback: página carregou, mas sem episódios para série
    if ($('.tab_episode').length === 0 && type !== 'movies') {
      const html2 = await fetchDetailHtml(`${BASE_URL}/index.php?page=moviedetail&id=${id}`);
      if (html2) $ = cheerio.load(html2, { decodeEntities: false });
    }

    const data = { seasons: {}, info: {} };
    data.title = limparTexto($('.left-wrap h2').first().text());
    data.info.sinopse = limparTexto($('.left-wrap p').first().text());
    data.mediaType = $('.tab_episode').length > 0 ? 'series' : 'movie';

    if (data.mediaType === 'series') {
      $('.tab_episode').each((i, el) => {
        const seasonNum = i + 1;
        const episodes = [];
        $(el)
          .find('a.ep-list-min')
          .each((j, link) => {
            const epId = $(link).attr('data-id');
            const epName = limparTexto($(link).find('.ep-title').text());
            if (epId && epName) episodes.push({ name: epName, id: epId });
          });
        if (episodes.length > 0) data.seasons[seasonNum] = episodes;
      });
    } else {
      data.seasons.Filme = [{ name: data.title || 'Filme Completo', id }];
    }

    if (!data.title || data.title.length < 2) {
      logger.warn({ msg: 'Detalhes sem título válido', id, type });
      return null;
    }

    return data;
  } catch (error) {
    logger.error({ msg: 'Erro ao buscar detalhes', id, type, err: error.message });
    return null;
  }
}

module.exports = { buscarDetalhes };