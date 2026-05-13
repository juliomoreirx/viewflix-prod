const axios = require('axios');
const cheerio = require('cheerio');
const iconv = require('iconv-lite');
const env = require('../config/env');
const logger = require('../lib/logger');
const { getSessionCookiesRaw, CACHE_CONTEUDO } = require('./content-cache.service');
const { getLocalContentByTitle } = require('./local-content.service');

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

function findTitleById(id, type) {
  const list = type === 'movies' ? CACHE_CONTEUDO.movies : CACHE_CONTEUDO.series;
  const match = (list || []).find((item) => String(item.id) === String(id));
  return match?.name || null;
}

function buildLocalDetails(local, type, id) {
  if (!local) return null;
  const meta = local.meta || {};
  const infoFields = ['sinopse', 'genero', 'ano', 'duracao', 'elenco', 'diretor', 'qualidade', 'total_episodios'];

  const data = {
    title: local.title || meta.titulo,
    mediaType: type === 'movies' ? 'movie' : 'series',
    info: {},
    seasons: {},
    coverUrl: local.coverUrl || null
  };

  for (const key of infoFields) {
    if (meta[key]) data.info[key] = meta[key];
  }

  if (data.mediaType === 'series') {
    if (Array.isArray(meta.temporadas)) {
      meta.temporadas.forEach((season, idx) => {
        const label = String(season.temporada || '').trim();
        const match = label.match(/(\d+)/);
        const seasonNum = match ? parseInt(match[1], 10) : idx + 1;
        const episodes = (season.episodios || []).map((ep) => ({
          name: ep.codigo || `E${String(ep.numero || '').padStart(2, '0')}`,
          id: `${data.title || 'serie'}-s${seasonNum}-e${ep.numero || ''}`
        }));
        if (episodes.length > 0) data.seasons[seasonNum] = episodes;
      });
    }
  } else {
    data.seasons.Filme = [{ name: data.title || 'Filme Completo', id }];
  }

  return data;
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

    const titleHint = findTitleById(id, type);
    const local = titleHint ? await getLocalContentByTitle(titleHint, type) : null;


    let html = await fetchDetailHtml(detailUrl);

    // fallback do legado: se seriesdetail vier vazio, tenta moviedetail
    if (!html && type !== 'movies') {
      html = await fetchDetailHtml(`${BASE_URL}/index.php?page=moviedetail&id=${id}`);
    }

    if (!html) {
      if (local) return buildLocalDetails(local, type, id);
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

    if (local) {
      const localDetails = buildLocalDetails(local, type, id);
      if (localDetails) {
        data.title = localDetails.title || data.title;
        data.info = { ...data.info, ...localDetails.info };
        data.coverUrl = localDetails.coverUrl || null;

        if (data.mediaType === 'series' && Object.keys(data.seasons || {}).length === 0) {
          data.seasons = localDetails.seasons || {};
        }
      }
    }

    return data;
  } catch (error) {
    logger.error({ msg: 'Erro ao buscar detalhes', id, type, err: error.message });
    return null;
  }
}

module.exports = { buscarDetalhes };
