const axios = require('axios');
const { CookieJar } = require('tough-cookie');
const { wrapper } = require('axios-cookiejar-support');
const { HttpProxyAgent } = require('http-proxy-agent');

const env = require('../config/env');
const logger = require('../lib/logger');
const { setSessionCookiesRaw, atualizarCache } = require('./content-cache.service');

const BASE_URL = env.BASE_URL || 'http://vouver.me';
const CF_CLEARANCE = env.CF_CLEARANCE || '';

const RES_PROXY_ENABLED = String(env.RES_PROXY_ENABLED || 'false')
  .replace(/['"]/g, '')
  .trim()
  .toLowerCase() === 'true';

const RES_PROXY_HOST = (env.RES_PROXY_HOST || '').trim();
const RES_PROXY_PORT = parseInt(String(env.RES_PROXY_PORT || '0').trim(), 10);
const RES_PROXY_USER = env.RES_PROXY_USER || '';
const RES_PROXY_PASS = env.RES_PROXY_PASS || '';

let residentialProxyAgent = null;
if (RES_PROXY_ENABLED && RES_PROXY_HOST && RES_PROXY_PORT && RES_PROXY_USER && RES_PROXY_PASS) {
  const proxyUrl = `http://${encodeURIComponent(RES_PROXY_USER)}:${encodeURIComponent(RES_PROXY_PASS)}@${RES_PROXY_HOST}:${RES_PROXY_PORT}`;
  residentialProxyAgent = new HttpProxyAgent(proxyUrl);
}

const jar = new CookieJar();
const client = wrapper(axios.create({ jar, withCredentials: true }));
const clientNoJar = axios.create({ withCredentials: false });

const HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  Accept:
    'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
  'Accept-Language': 'pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7',
  Connection: 'keep-alive'
};

function shouldUseResidentialProxy(url) {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return host === 'vouver.me' || host.endsWith('.vouver.me');
  } catch {
    return false;
  }
}

function withOptionalResidentialProxy(axiosConfig = {}, url = '') {
  if (residentialProxyAgent && shouldUseResidentialProxy(url)) {
    return { ...axiosConfig, httpAgent: residentialProxyAgent, httpsAgent: residentialProxyAgent, proxy: false };
  }
  return axiosConfig;
}

function getHttpClientForUrl(url) {
  if (residentialProxyAgent && shouldUseResidentialProxy(url)) return clientNoJar;
  return client;
}

async function refreshSessionCookiesFromJar() {
  const cookiesHttp = await jar.getCookies(BASE_URL);
  const cookiesHttps = await jar.getCookies(BASE_URL.replace(/^http:\/\//i, 'https://'));
  const merged = new Map();
  [...cookiesHttp, ...cookiesHttps].forEach((c) => merged.set(c.key, c.value));
  return Array.from(merged.entries()).map(([k, v]) => `${k}=${v}`).join('; ');
}

async function fazerLoginVouver(username, password, tentativa = 1) {
  const MAX_TENTATIVAS = 3;
  if (tentativa > MAX_TENTATIVAS) return false;

  try {
    await jar.removeAllCookies();

    if (CF_CLEARANCE) {
      await jar.setCookie(`cf_clearance=${CF_CLEARANCE}; Path=/`, BASE_URL);
      await jar.setCookie(`cf_clearance=${CF_CLEARANCE}; Path=/`, BASE_URL.replace(/^http:\/\//i, 'https://'));
    }

    const loginUrl = `${BASE_URL}/index.php?page=login`;
    const loginClient = getHttpClientForUrl(loginUrl);

    const loginPageResponse = await loginClient.get(
      loginUrl,
      withOptionalResidentialProxy(
        {
          headers: { ...HEADERS },
          timeout: 30000,
          maxRedirects: 5,
          validateStatus: (s) => s < 500
        },
        loginUrl
      )
    );

    const htmlPage = String(loginPageResponse.data || '');
    const csrfMatch =
      htmlPage.match(/name=["']csrf_token["']\s+value=["']([\w-]+)["']/i) ||
      htmlPage.match(/csrf_token["']\s+value=["']([a-f0-9-]+)["']/i) ||
      htmlPage.match(/name=["']csrf_token["'][^>]*value=["']([a-f0-9-]+)["']/i);

    const csrfToken = csrfMatch ? csrfMatch[1] : '';

    const formData = new URLSearchParams({
      username,
      sifre: password,
      beni_hatirla: 'on',
      csrf_token: csrfToken,
      recaptcha_response: '',
      login: 'Acessar'
    });

    await loginClient.post(
      loginUrl,
      formData.toString(),
      withOptionalResidentialProxy(
        {
          headers: {
            ...HEADERS,
            'Content-Type': 'application/x-www-form-urlencoded',
            Origin: BASE_URL,
            Referer: `${BASE_URL}/index.php?page=login`
          },
          timeout: 30000,
          maxRedirects: 5,
          validateStatus: (s) => s < 500
        },
        loginUrl
      )
    );

    const ajaxUrl = `${BASE_URL}/ajax/login.php`;
    const ajaxData = new URLSearchParams({
      username,
      password,
      csrf_token: csrfToken,
      type: '1'
    });

    await loginClient.post(
      ajaxUrl,
      ajaxData.toString(),
      withOptionalResidentialProxy(
        {
          headers: {
            ...HEADERS,
            'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
            'X-Requested-With': 'XMLHttpRequest',
            Origin: BASE_URL,
            Referer: `${BASE_URL}/index.php?page=login`
          },
          timeout: 30000,
          maxRedirects: 5,
          validateStatus: (s) => s < 500
        },
        ajaxUrl
      )
    );

    const homepageUrl = `${BASE_URL}/index.php?page=homepage`;
    const homepageResponse = await loginClient.get(
      homepageUrl,
      withOptionalResidentialProxy(
        {
          headers: { ...HEADERS, Referer: `${BASE_URL}/index.php?page=login` },
          timeout: 30000,
          maxRedirects: 5
        },
        homepageUrl
      )
    );

    const homepageHtml = String(homepageResponse.data || '');
    const ok = homepageHtml.includes('Meu Perfil') || homepageHtml.includes('Sair') || homepageHtml.includes('sair');

    if (!ok) {
      logger.warn({ msg: 'Login não confirmado, tentando novamente', tentativa });
      return fazerLoginVouver(username, password, tentativa + 1);
    }

    const cookies = await refreshSessionCookiesFromJar();
    setSessionCookiesRaw(cookies);

    await atualizarCache(true);

    logger.info({ msg: 'Login Vouver realizado com sucesso' });
    return true;
  } catch (error) {
    logger.error({ msg: 'Erro no login Vouver', tentativa, err: error.message });
    if (tentativa < 3) return fazerLoginVouver(username, password, tentativa + 1);
    return false;
  }
}

module.exports = { fazerLoginVouver };