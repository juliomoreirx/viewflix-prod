const axios = require('axios');
const fs = require('fs-extra');
const path = require('path');
const cheerio = require('cheerio');
const iconv = require('iconv-lite');
const { CookieJar } = require('tough-cookie');
const { wrapper } = require('axios-cookiejar-support');
const { HttpProxyAgent } = require('http-proxy-agent');

const env = require('../config/env');
const logger = require('../lib/logger');

const BASE_URL = env.BASE_URL || 'http://vouver.me';
const CLOUDFLARE_WORKER_URL = env.CLOUDFLARE_WORKER_URL || '';
const CF_CLEARANCE = env.CF_CLEARANCE || '';
const SESSION_COOKIES_ENV = env.SESSION_COOKIES || '';

const WORKER_CACHE_ENABLED = String(env.WORKER_CACHE_ENABLED || 'false')
  .replace(/['"]/g, '')
  .trim()
  .toLowerCase() === 'true';

const RES_PROXY_ENABLED = String(env.RES_PROXY_ENABLED || 'false')
  .replace(/['"]/g, '')
  .trim()
  .toLowerCase() === 'true';

const RES_PROXY_HOST = (env.RES_PROXY_HOST || '').trim();
const RES_PROXY_PORT = parseInt(String(env.RES_PROXY_PORT || '0').trim(), 10);
const RES_PROXY_USER = env.RES_PROXY_USER || '';
const RES_PROXY_PASS = env.RES_PROXY_PASS || '';

logger.info({
  msg: 'Boot env check',
  hasSessionCookiesEnv: !!SESSION_COOKIES_ENV,
  sessionEnvLength: SESSION_COOKIES_ENV ? SESSION_COOKIES_ENV.length : 0
});

let residentialProxyAgent = null;
if (RES_PROXY_ENABLED && RES_PROXY_HOST && RES_PROXY_PORT && RES_PROXY_USER && RES_PROXY_PASS) {
  const proxyUrl = `http://${encodeURIComponent(RES_PROXY_USER)}:${encodeURIComponent(RES_PROXY_PASS)}@${RES_PROXY_HOST}:${RES_PROXY_PORT}`;
  residentialProxyAgent = new HttpProxyAgent(proxyUrl);
  logger.info({ msg: 'Proxy residencial ativa', host: RES_PROXY_HOST, port: RES_PROXY_PORT });
} else {
  logger.info({ msg: 'Proxy residencial inativa' });
}

const jar = new CookieJar();
const client = wrapper(axios.create({ jar, withCredentials: true }));
const clientNoJar = axios.create({ withCredentials: false });

const CACHE_CONTEUDO = { movies: [], series: [], livetv: [], lastUpdated: 0 };
let SESSION_COOKIES = '';

function sortByName(list = []) {
  return [...list].sort((a, b) => String(a?.name || '').localeCompare(String(b?.name || '')));
}

const HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  Accept: 'application/json, text/javascript, */*; q=0.01',
  Referer: `${BASE_URL}/index.php?page=homepage`,
  'X-Requested-With': 'XMLHttpRequest'
};

function shouldUseResidentialProxy(url) {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return (
      host === 'vouver.me' ||
      host.endsWith('.vouver.me') ||
      host === 'goplay.icu' ||
      host.endsWith('.goplay.icu')
    );
  } catch {
    return false;
  }
}

function withOptionalResidentialProxy(axiosConfig = {}, url = '') {
  if (residentialProxyAgent && shouldUseResidentialProxy(url)) {
    return {
      ...axiosConfig,
      httpAgent: residentialProxyAgent,
      httpsAgent: residentialProxyAgent,
      proxy: false
    };
  }
  return axiosConfig;
}

function getHttpClientForUrl(url) {
  if (residentialProxyAgent && shouldUseResidentialProxy(url)) return clientNoJar;
  return client;
}

function buildCookieHeader() {
  let cookies = (SESSION_COOKIES || '').trim();
  if (CF_CLEARANCE && !cookies.includes('cf_clearance=')) {
    cookies = cookies ? `${cookies}; cf_clearance=${CF_CLEARANCE}` : `cf_clearance=${CF_CLEARANCE}`;
  }
  return cookies;
}

async function hydrateJarFromCookieString(cookieStr, baseUrl) {
  if (!cookieStr) return;
  const parts = cookieStr.split(';').map((s) => s.trim()).filter(Boolean);
  for (const part of parts) {
    const idx = part.indexOf('=');
    if (idx <= 0) continue;
    const name = part.substring(0, idx).trim();
    const value = part.substring(idx + 1).trim();
    try {
      await jar.setCookie(`${name}=${value}; Path=/`, baseUrl);
      await jar.setCookie(`${name}=${value}; Path=/`, baseUrl.replace(/^http:\/\//i, 'https://'));
    } catch {
      logger.warn({ msg: 'Falha ao setar cookie no jar', cookie: name });
    }
  }
}

async function refreshSessionCookiesFromJar() {
  try {
    const cookiesHttp = await jar.getCookies(BASE_URL);
    const cookiesHttps = await jar.getCookies(BASE_URL.replace(/^http:\/\//i, 'https://'));
    const merged = new Map();
    [...cookiesHttp, ...cookiesHttps].forEach((c) => merged.set(c.key, c.value));

    if (merged.size === 0) return SESSION_COOKIES;

    SESSION_COOKIES = Array.from(merged.entries())
      .map(([k, v]) => `${k}=${v}`)
      .join('; ');

    return SESSION_COOKIES;
  } catch (e) {
    logger.error({ msg: 'Erro ao ler cookies do jar', err: e.message });
    return SESSION_COOKIES;
  }
}

async function ensureSessionHydrated() {
  if (SESSION_COOKIES) return;

  if (SESSION_COOKIES_ENV) {
    await hydrateJarFromCookieString(SESSION_COOKIES_ENV, BASE_URL);
    await refreshSessionCookiesFromJar();
  }

  if (!SESSION_COOKIES && SESSION_COOKIES_ENV) {
    SESSION_COOKIES = SESSION_COOKIES_ENV.trim();
  }

  if (CF_CLEARANCE && !SESSION_COOKIES.includes('cf_clearance=')) {
    SESSION_COOKIES = SESSION_COOKIES
      ? `${SESSION_COOKIES}; cf_clearance=${CF_CLEARANCE}`
      : `cf_clearance=${CF_CLEARANCE}`;
  }
}

async function setSessionCookiesRaw(raw) {
  SESSION_COOKIES = String(raw || '').trim();

  if (SESSION_COOKIES) {
    await hydrateJarFromCookieString(SESSION_COOKIES, BASE_URL);
    await refreshSessionCookiesFromJar();
  }
}

function getSessionCookiesRaw() {
  return SESSION_COOKIES;
}

async function carregarDoArquivo(contentPath) {
  if (!(await fs.pathExists(contentPath))) return false;

  try {
    const fileContent = await fs.readFile(contentPath, 'utf8');
    const cacheData = JSON.parse(fileContent);

    let rawMovies = [];
    let rawSeries = [];
    let rawLiveTv = [];

    if (cacheData.data) {
      rawMovies = cacheData.data.movies || [];
      rawSeries = cacheData.data.series || [];
      rawLiveTv = cacheData.data.livetv || cacheData.data.liveTv || cacheData.data.live_tv || cacheData.data.channels || [];
    } else if (cacheData.movies) {
      rawMovies = cacheData.movies || [];
      rawSeries = cacheData.series || [];
      rawLiveTv = cacheData.livetv || cacheData.liveTv || cacheData.live_tv || cacheData.channels || [];
    }

    if (rawMovies.length > 0 || rawSeries.length > 0 || rawLiveTv.length > 0) {
      CACHE_CONTEUDO.movies = sortByName(rawMovies);
      CACHE_CONTEUDO.series = sortByName(rawSeries);
      CACHE_CONTEUDO.livetv = sortByName(rawLiveTv);
      CACHE_CONTEUDO.lastUpdated = Date.now();
      logger.info({
        msg: 'Cache carregado de arquivo',
        movies: CACHE_CONTEUDO.movies.length,
        series: CACHE_CONTEUDO.series.length,
        livetv: CACHE_CONTEUDO.livetv.length
      });
      return true;
    }
    return false;
  } catch (e) {
    logger.warn({ msg: 'Falha ao ler content.json', err: e.message });
    return false;
  }
}

async function carregarViaWorker(contentPath) {
  if (!WORKER_CACHE_ENABLED || !CLOUDFLARE_WORKER_URL || !SESSION_COOKIES) return false;

  try {
    const response = await axios.post(
      `${CLOUDFLARE_WORKER_URL}/cache-direct`,
      { cookies: SESSION_COOKIES },
      { timeout: 30000 }
    );

    const data = response.data;
    if (!data?.success || !data?.data) return false;

    const rawMovies = data.data?.data?.movies || data.data?.movies || [];
    const rawSeries = data.data?.data?.series || data.data?.series || [];
    const rawLiveTv =
      data.data?.data?.livetv ||
      data.data?.livetv ||
      data.data?.data?.liveTv ||
      data.data?.liveTv ||
      data.data?.data?.live_tv ||
      data.data?.live_tv ||
      data.data?.data?.channels ||
      data.data?.channels ||
      [];

    if (rawMovies.length === 0 && rawSeries.length === 0 && rawLiveTv.length === 0) return false;

    CACHE_CONTEUDO.movies = sortByName(rawMovies);
    CACHE_CONTEUDO.series = sortByName(rawSeries);
    CACHE_CONTEUDO.livetv = sortByName(rawLiveTv);
    CACHE_CONTEUDO.lastUpdated = Date.now();

    await fs.writeFile(contentPath, JSON.stringify(data.data, null, 2), 'utf8');

    logger.info({
      msg: 'Cache carregado via worker',
      movies: CACHE_CONTEUDO.movies.length,
      series: CACHE_CONTEUDO.series.length,
      livetv: CACHE_CONTEUDO.livetv.length
    });

    return true;
  } catch (e) {
    logger.warn({ msg: 'Worker cache-direct falhou', err: e.message });
    return false;
  }
}

async function carregarViaApiDireta(contentPath) {
  if (!SESSION_COOKIES) return false;

  const searchUrl = `${BASE_URL}/ajax/search.php?q=a`;
  const httpClient = getHttpClientForUrl(searchUrl);
  const manualCookie = httpClient === clientNoJar;

  try {
    await refreshSessionCookiesFromJar();

    const resp = await httpClient.get(
      searchUrl,
      withOptionalResidentialProxy(
        {
          headers: {
            ...HEADERS,
            ...(manualCookie ? { Cookie: buildCookieHeader() } : {})
          },
          timeout: 60000,
          validateStatus: (s) => s < 500
        },
        searchUrl
      )
    );

    const cacheData = resp.data || {};
    const rawMovies = cacheData?.data?.movies || cacheData?.movies || [];
    const rawSeries = cacheData?.data?.series || cacheData?.series || [];
    const rawLiveTv =
      cacheData?.data?.livetv ||
      cacheData?.livetv ||
      cacheData?.data?.liveTv ||
      cacheData?.liveTv ||
      cacheData?.data?.live_tv ||
      cacheData?.live_tv ||
      cacheData?.data?.channels ||
      cacheData?.channels ||
      [];

    if (rawMovies.length === 0 && rawSeries.length === 0 && rawLiveTv.length === 0) {
      logger.warn({ msg: 'API direta respondeu sem catálogo' });
      return false;
    }

    CACHE_CONTEUDO.movies = sortByName(rawMovies);
    CACHE_CONTEUDO.series = sortByName(rawSeries);
    CACHE_CONTEUDO.livetv = sortByName(rawLiveTv);
    CACHE_CONTEUDO.lastUpdated = Date.now();

    await fs.writeFile(contentPath, JSON.stringify(cacheData, null, 2), 'utf8');

    logger.info({
      msg: 'Cache carregado via API direta',
      movies: CACHE_CONTEUDO.movies.length,
      series: CACHE_CONTEUDO.series.length,
      livetv: CACHE_CONTEUDO.livetv.length
    });

    return true;
  } catch (e) {
    logger.error({ msg: 'Erro na API direta de catálogo', err: e.message });
    return false;
  }
}

async function atualizarCache(forceDownload = false) {
  const contentPath = path.join(process.cwd(), 'content.json');

  try {
    await ensureSessionHydrated();

    if (forceDownload && (await fs.pathExists(contentPath))) {
      await fs.remove(contentPath);
      logger.info({ msg: 'content.json removido por forceDownload' });
    }

    if (await carregarDoArquivo(contentPath)) return CACHE_CONTEUDO;
    if (await carregarViaWorker(contentPath)) return CACHE_CONTEUDO;
    if (await carregarViaApiDireta(contentPath)) return CACHE_CONTEUDO;

    logger.error({
      msg: 'Cache não pôde ser carregado por nenhum método',
      hasSessionCookies: !!SESSION_COOKIES,
      hasWorker: !!CLOUDFLARE_WORKER_URL,
      workerCacheEnabled: WORKER_CACHE_ENABLED
    });

    return CACHE_CONTEUDO;
  } catch (error) {
    logger.error({ msg: 'Erro fatal em atualizarCache', err: error.message });
    return CACHE_CONTEUDO;
  }
}

// ============================
// DETALHES E DURAÇÃO
// ============================
function extrairPrimeiro(texto, regex, fallback = '') {
  const m = texto.match(regex);
  return m?.[1]?.trim() || fallback;
}

function limparHtml(html = '') {
  return String(html)
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function hhmmssParaMinutos(valor = '') {
  if (!valor || !/^\d{2}:\d{2}:\d{2}$/.test(valor)) return 0;
  const [h, m] = valor.split(':').map(Number);
  return (h * 60) + m;
}

/**
 * Busca detalhes do conteúdo no endpoint de detalhes.
 * Retorna shape compatível com telegram-bot:
 * {
 *   id, title, mediaType,
 *   info: { genero, ano, imdb, sinopse, duracaoTexto, duracaoMinutos },
 *   seasons: { [season]: [{id, name}] }
 * }
 */

function corrigirCaracteresEspeciais(texto = '') {
  return String(texto)
    .replace(/â€™/g, '’')
    .replace(/â€œ/g, '“')
    .replace(/â€/g, '”')
    .replace(/â€"/g, '—')
    .replace(/Ã¡/g, 'á')
    .replace(/Ã /g, 'à')
    .replace(/Ã¢/g, 'â')
    .replace(/Ã£/g, 'ã')
    .replace(/Ã©/g, 'é')
    .replace(/Ãª/g, 'ê')
    .replace(/Ã­/g, 'í')
    .replace(/Ã³/g, 'ó')
    .replace(/Ã´/g, 'ô')
    .replace(/Ãµ/g, 'õ')
    .replace(/Ãº/g, 'ú')
    .replace(/Ã§/g, 'ç');
}

function limparTexto(txt = '') {
  return corrigirCaracteresEspeciais(String(txt).replace(/\s+/g, ' ').trim());
}

async function logCurrentCookies(tag = 'cookies') {
  try {
    const c = await refreshSessionCookiesFromJar();
    logger.info({ msg: `Cookies atuais (${tag})`, size: c ? c.length : 0 });
  } catch {}
}

async function buscarDetalhes(id, type) {
  const pageType = type === 'movies' ? 'moviedetail' : 'seriesdetail';

  const isBlockedPage = (html = '') => {
    const t = String(html).toLowerCase();
    return (
      t.includes('you are unable to access') || t.includes('attention required') ||
      t.includes('cf-browser-verification') ||
      (t.includes('cloudflare') && t.includes('ray id')) || t.includes('access denied')
    );
  };

  const decodeHtml = (buffer) => {
    let html = null;
    for (const encoding of ['ISO-8859-1', 'Windows-1252', 'UTF-8', 'latin1']) {
      try {
        const decoded = iconv.decode(Buffer.from(buffer), encoding);
        if (!decoded.includes('â€') && !decoded.includes('?â€')) { html = decoded; break; }
      } catch {}
    }
    if (!html) {
      html = iconv.decode(Buffer.from(buffer), 'ISO-8859-1');
      html = corrigirCaracteresEspeciais(html);
    }
    return html;
  };

  const fetchDetailHtml = async (pType, pId, pMediaType) => {
    const detailUrl = `${BASE_URL}/index.php?page=${pType}&id=${pId}`;
    const httpClient = getHttpClientForUrl(detailUrl);
    const manualCookie = httpClient === clientNoJar;
    try {
      const r = await httpClient.get(detailUrl, withOptionalResidentialProxy({
        headers: {
          ...HEADERS,
          'Sec-Fetch-Site': 'same-origin',
          'Sec-Fetch-Mode': 'navigate',
          Referer: `${BASE_URL}/index.php?page=homepage`,
          ...(manualCookie ? { Cookie: buildCookieHeader() } : {})
        },
        responseType: 'arraybuffer',
        timeout: 30000,
        maxRedirects: 5,
        validateStatus: s => s < 500
      }, detailUrl));
      const html = decodeHtml(r.data);
      if (isBlockedPage(html)) { console.log(`⚠️ Página bloqueada (${pType}/${pId})`); return null; }
      return html;
    } catch (e) { console.error(`❌ Erro ao buscar HTML (${pType}/${pId}):`, e.message); return null; }
  };

  try {
    if (WORKER_CACHE_ENABLED && CLOUDFLARE_WORKER_URL && SESSION_COOKIES) {
      console.log(`🔍 Buscando detalhes via Worker: ${type}/${id}...`);
      try {
        const response = await axios.post(
          `${CLOUDFLARE_WORKER_URL}/details-direct`,
          { id, type, cookies: SESSION_COOKIES },
          { timeout: 15000 }
        );
        const data = response.data;
        if (data.success && data.data) {
          const d = data.data;
          const titulo = String(d.title || '').toLowerCase();
          const sinopse = String(d.info?.sinopse || '').toLowerCase();
          const bloqueado = titulo.includes('you are unable to access') || titulo.includes('cloudflare') || sinopse.includes('cloudflare');
          const invalido = !d.title || d.title.length < 2 || (!d.seasons && !d.info);
          if (!bloqueado && !invalido) {
            console.log('✅ Detalhes obtidos via Worker');
            return d;
          }
          console.log('⚠️ Worker retornou conteúdo inválido/bloqueio, tentando direto...');
        }
      } catch (workerError) {
        console.log('⚠️ Worker falhou:', workerError.message);
      }
    }

    console.log(`🌐 Buscando detalhes diretamente: ${type}/${id}...`);
    await refreshSessionCookiesFromJar();
    await logCurrentCookies(`detalhes-${type}-${id}`);

    let html = await fetchDetailHtml(pageType, id, type === 'movies' ? 'movies' : 'series');
    if (!html) { console.error(`❌ Não foi possível obter HTML de detalhes (${type}/${id})`); return null; }

    let $ = cheerio.load(html, { decodeEntities: false });

    if ($('.tab_episode').length === 0 && type !== 'movies') {
      const html2 = await fetchDetailHtml('moviedetail', id, 'series');
      if (html2) $ = cheerio.load(html2, { decodeEntities: false });
    }

    const data = { seasons: {}, info: {} };
    data.title = limparTexto($('.left-wrap h2').first().text());
    data.info.sinopse = limparTexto($('.left-wrap p').first().text());
    data.mediaType = $('.tab_episode').length > 0 ? 'series' : 'movie';

    if (data.mediaType === 'movie') {
      const tags = [];
      $('.left-wrap .tag').each((i, el) => {
        const t = limparTexto($(el).text());
        if (t) tags.push(t);
      });

      const imdbText = limparTexto($('.left-wrap .rnd').first().text());
      const imdbMatch = imdbText.match(/IMDB\s+([\d.]+)/i);
      if (imdbMatch) data.info.imdb = parseFloat(imdbMatch[1]);

      for (const tag of tags) {
        if (/^\d{4}$/.test(tag)) data.info.ano = parseInt(tag, 10);

        const duracaoMatch = tag.match(/^(\d{1,2}):(\d{2}):(\d{2})$/);
        if (duracaoMatch) {
          const horas = parseInt(duracaoMatch[1], 10);
          const minutos = parseInt(duracaoMatch[2], 10);
          const segundos = parseInt(duracaoMatch[3], 10);
          data.info.duracaoMinutos = (horas * 60) + minutos + Math.ceil(segundos / 60);
          data.info.duracaoTexto = tag;
          console.log(`✅ [FILME] Duração: ${tag} = ${data.info.duracaoMinutos}min`);
        }

        if (!tag.includes(':') && isNaN(tag) && !/^\d{4}$/.test(tag)) {
          if (!data.info.genero) data.info.genero = tag;
        }
      }
    }

    if (data.mediaType === 'series') {
      $('.tab_episode').each((i, el) => {
        const seasonNum = i + 1;
        const episodes = [];
        $(el).find('a.ep-list-min').each((j, link) => {
          const epId = $(link).attr('data-id');
          const epName = limparTexto($(link).find('.ep-title').text());
          if (epId && epName) episodes.push({ name: epName, id: epId });
        });
        if (episodes.length > 0) data.seasons[seasonNum] = episodes;
      });
    } else {
      data.seasons['Filme'] = [{ name: data.title || 'Filme Completo', id }];
    }

    if (!data.title || data.title.length < 2) {
      console.log('⚠️ HTML retornado sem título válido (possível bloqueio/sessão inválida)');
      return null;
    }

    return data;
  } catch (error) {
    console.error('❌ Erro ao buscar detalhes:', error.message);
    return null;
  }
}

async function estimarDuracao(mediaType, id, duracaoDoHTML = null) {
  try {
    if (mediaType === 'movie' && duracaoDoHTML && duracaoDoHTML > 0) {
      return duracaoDoHTML;
    }
    return mediaType === 'movie' ? 110 : 42;
  } catch {
    return mediaType === 'movie' ? 110 : 42;
  }
}

module.exports = {
  CACHE_CONTEUDO,
  atualizarCache,
  buscarDetalhes,
  estimarDuracao,
  setSessionCookiesRaw,
  getSessionCookiesRaw
};