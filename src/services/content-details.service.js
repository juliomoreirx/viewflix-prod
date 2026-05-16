// src/services/content-details.service.js
const axios = require('axios');
const cheerio = require('cheerio');
const iconv = require('iconv-lite');
const env = require('../config/env');
const logger = require('../lib/logger');
const { getSessionCookiesRaw, CACHE_CONTEUDO } = require('./content-cache.service');
const { getLocalContentByTitle } = require('./local-content.service');
const { limparTexto } = require('./text-utils.service');

const BASE_URL = env.BASE_URL;

// ==========================================
// MÓDULO 1: REDE E SEGURANÇA
// ==========================================
function isBlockedPage(html = '') {
  const t = String(html).toLowerCase();
  return (
    t.includes('you are unable to access') ||
    t.includes('attention required') ||
    t.includes('cf-browser-verification') ||
    t.includes('ray id') ||
    t.includes('access denied')
  );
}

function decodeHtml(buffer) {
  for (const enc of ['ISO-8859-1', 'Windows-1252', 'UTF-8', 'latin1']) {
    try {
      const decoded = iconv.decode(Buffer.from(buffer), enc);
      if (!decoded.includes('Ã¢â‚¬') && !decoded.includes('?Ã¢â‚¬')) return decoded;
    } catch {}
  }
  return iconv.decode(Buffer.from(buffer), 'ISO-8859-1');
}

async function fetchDetailHtml(detailUrl) {
  try {
    const sessionCookies = getSessionCookiesRaw();
    const headers = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'pt-BR,pt;q=0.9,en-US;q=0.8',
      Referer: `${BASE_URL}/index.php?page=homepage`,
      Connection: 'keep-alive'
    };

    if (sessionCookies) headers.Cookie = sessionCookies;

    const response = await axios.get(detailUrl, {
      headers,
      responseType: 'arraybuffer',
      timeout: 15000,
      maxRedirects: 3,
      validateStatus: (s) => s < 500
    });

    const html = decodeHtml(response.data);
    if (isBlockedPage(html)) return null;
    return html;
  } catch (error) {
    logger.warn({ msg: 'Falha na requisição HTTP do detalhe', url: detailUrl, error: error.message });
    return null;
  }
}

// ==========================================
// MÓDULO 2: PARSERS E EXTRATORES (DOM)
// ==========================================
function extractDataFromDom(html, id) {
  const $ = cheerio.load(html, { decodeEntities: false });
  
  const selectors = {
    title: '.left-wrap h2',
    synopsis: '.left-wrap p',
    episodeTab: '.tab_episode',
    episodeLink: 'a.ep-list-min',
    episodeTitle: '.ep-title'
  };

  const data = { seasons: {}, info: {} };
  data.title = limparTexto($(selectors.title).first().text());
  data.info.sinopse = limparTexto($(selectors.synopsis).first().text());
  data.mediaType = $(selectors.episodeTab).length > 0 ? 'series' : 'movie';

  if (data.mediaType === 'series') {
    $(selectors.episodeTab).each((i, el) => {
      const seasonNum = i + 1;
      const episodes = [];
      $(el).find(selectors.episodeLink).each((j, link) => {
        const epId = $(link).attr('data-id');
        const epName = limparTexto($(link).find(selectors.episodeTitle).text());
        if (epId && epName) episodes.push({ name: epName, id: epId });
      });
      if (episodes.length > 0) data.seasons[seasonNum] = episodes;
    });
  } else {
    data.seasons.Filme = [{ name: data.title || 'Filme Completo', id }];
  }

  return data;
}

// ==========================================
// MÓDULO 3: FALLBACKS LOCAIS E MESCLAGEM
// ==========================================
function buildLocalDetails(local, type, id) {
  if (!local) return null;
  const meta = local.meta || {};
  const data = {
    title: local.title || meta.titulo,
    mediaType: type === 'movies' ? 'movie' : 'series',
    info: {
      sinopse: meta.sinopse,
      genero: meta.genero,
      ano: meta.ano,
      duracao: meta.duracao,
      elenco: meta.elenco,
      diretor: meta.diretor,
      qualidade: meta.qualidade
    },
    seasons: {},
    coverUrl: local.coverUrl || null,
    coverPath: local.absoluteCoverPath || null
  };

  Object.keys(data.info).forEach(key => data.info[key] === undefined && delete data.info[key]);

  if (data.mediaType === 'series' && Array.isArray(meta.temporadas)) {
    meta.temporadas.forEach((season, idx) => {
      const match = String(season.temporada || '').match(/(\d+)/);
      const seasonNum = match ? parseInt(match[1], 10) : idx + 1;
      const episodes = (season.episodios || []).map((ep) => ({
        name: ep.codigo || `E${String(ep.numero || '').padStart(2, '0')}`,
        id: `${data.title || 'serie'}-s${seasonNum}-e${ep.numero || ''}`
      }));
      if (episodes.length > 0) data.seasons[seasonNum] = episodes;
    });
  } else {
    data.seasons.Filme = [{ name: data.title || 'Filme Completo', id }];
  }

  return data;
}

// ==========================================
// FUNÇÃO PRINCIPAL EXPORTADA
// ==========================================
async function buscarDetalhes(id, type) {
  try {
    const cacheList = type === 'movies' ? CACHE_CONTEUDO.movies : CACHE_CONTEUDO.series;
    const cacheMatch = (cacheList || []).find((item) => String(item.id) === String(id));
    const titleHint = cacheMatch?.name || null;

    const localData = titleHint ? await getLocalContentByTitle(titleHint, type) : null;

    let html = await fetchDetailHtml(`${BASE_URL}/index.php?page=${type === 'movies' ? 'moviedetail' : 'seriesdetail'}&id=${id}`);

    if (!html && type !== 'movies') {
      html = await fetchDetailHtml(`${BASE_URL}/index.php?page=moviedetail&id=${id}`);
    }

    if (!html) {
      if (localData) return buildLocalDetails(localData, type, id);
      logger.warn({ msg: 'Bloqueado pelo Cloudflare e sem dados locais', id, type });
      return null;
    }

    let scrapedData = extractDataFromDom(html, id);

    if (scrapedData.mediaType === 'movie' && type === 'series') {
      const htmlFallback = await fetchDetailHtml(`${BASE_URL}/index.php?page=moviedetail&id=${id}`);
      if (htmlFallback) scrapedData = extractDataFromDom(htmlFallback, id);
    }

    if (!scrapedData.title || scrapedData.title.length < 2) {
      logger.warn({ msg: 'O site alvo mudou o layout ou devolveu página inválida', id });
      return localData ? buildLocalDetails(localData, type, id) : null;
    }

    if (localData) {
      const localFormatted = buildLocalDetails(localData, type, id);
      if (localFormatted) {
        scrapedData.title = localFormatted.title || scrapedData.title;
        scrapedData.info = { ...scrapedData.info, ...localFormatted.info };
        scrapedData.coverUrl = localFormatted.coverUrl || null;
        scrapedData.coverPath = localFormatted.coverPath || null;

        if (scrapedData.mediaType === 'series' && Object.keys(scrapedData.seasons || {}).length === 0) {
          scrapedData.seasons = localFormatted.seasons || {};
        }
      }
    }

    return scrapedData;
  } catch (error) {
    logger.error({ msg: 'Erro crítico no buscarDetalhes', id, type, err: error.message });
    return null;
  }
}

// Exportação unificada estrita
module.exports = { buscarDetalhes };