#!/usr/bin/env node
/**
 * Script avançado para testar login via proxy com mais detalhes de debug
 * Analisa cada step do fluxo de autenticação
 */

require('dotenv').config();
const axios = require('axios');
const { HttpProxyAgent } = require('http-proxy-agent');

const useProxy = process.argv[2] === 'true' || process.argv[2] === '1';

const BASE_URL = process.env.BASE_URL || 'http://vouver.me';
const LOGIN_USER = process.env.LOGIN_USER || '85119rbz';
const LOGIN_PASS = process.env.LOGIN_PASS || 'cyd16156';

const PROXY_ENABLED = useProxy;
const PROXY_HOST = process.env.RES_PROXY_HOST || 'brd.superproxy.io';
const PROXY_PORT = parseInt(process.env.RES_PROXY_PORT || '33335', 10);
const PROXY_USER = process.env.RES_PROXY_USER || '';
const PROXY_PASS = process.env.RES_PROXY_PASS || '';

const headers = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
  'Accept-Language': 'pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7',
  Connection: 'keep-alive'
};

function log(level, message, data = {}) {
  const timestamp = new Date().toISOString();
  const prefix = `[${timestamp}] [${level.toUpperCase()}]`;
  console.log(prefix, message);
  if (Object.keys(data).length > 0) {
    console.log('  ', JSON.stringify(data, null, 2));
  }
}

async function testLogin() {
  try {
    log('info', '=== TESTE DE LOGIN AVANÇADO ===');
    log('info', `Usando proxy: ${PROXY_ENABLED ? 'SIM' : 'NÃO'}`);
    log('info', `Base URL: ${BASE_URL}`);
    log('info', `Usuário: ${LOGIN_USER}`);
    
    // Criar cliente
    let clientConfig = {
      headers,
      timeout: 30000,
      validateStatus: () => true,
      maxRedirects: 5
    };

    if (PROXY_ENABLED && PROXY_USER && PROXY_PASS) {
      const proxyUrl = `http://${encodeURIComponent(PROXY_USER)}:${encodeURIComponent(PROXY_PASS)}@${PROXY_HOST}:${PROXY_PORT}`;
      const httpAgent = new HttpProxyAgent(proxyUrl);
      clientConfig.httpAgent = httpAgent;
      clientConfig.httpsAgent = httpAgent;
      log('info', '✓ Proxy configurada');
    }

    const client = axios.create(clientConfig);
    let cookies = {};

    // STEP 1: GET login page
    log('info', '📍 Step 1: GET /login (obter página e CSRF)');
    const loginUrl = `${BASE_URL}/index.php?page=login`;
    
    const loginPageRes = await client.get(loginUrl);
    log('info', `  Status: ${loginPageRes.status}`);

    const loginHtml = String(loginPageRes.data || '');
    const csrfMatch = loginHtml.match(/name=["']csrf_token["']\s+value=["']([\w-]+)["']/i) ||
                     loginHtml.match(/csrf_token["']\s+value=["']([a-f0-9-]+)["']/i);
    const csrfToken = csrfMatch ? csrfMatch[1] : '';
    log('info', `  CSRF Token: ${csrfToken ? '✓ ' + csrfToken.substring(0, 12) : '✗ Não encontrado'}`);

    // Extrair cookies do SET-COOKIE
    if (loginPageRes.headers['set-cookie']) {
      const setCookies = Array.isArray(loginPageRes.headers['set-cookie']) 
        ? loginPageRes.headers['set-cookie']
        : [loginPageRes.headers['set-cookie']];
      setCookies.forEach(sc => {
        const match = sc.match(/^([^=]+)=([^;]+)/);
        if (match) cookies[match[1]] = match[2];
      });
      log('info', `  Cookies recebidos: ${Object.keys(cookies).join(', ')}`);
    }

    // STEP 2: POST form login (primeira vez)
    log('info', '📍 Step 2: POST /login (submeter formulário)');
    const cookieHeader = Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join('; ');
    
    const loginFormRes = await client.post(
      loginUrl,
      new URLSearchParams({
        username: LOGIN_USER,
        sifre: LOGIN_PASS,
        beni_hatirla: 'on',
        csrf_token: csrfToken,
        recaptcha_response: '',
        login: 'Acessar'
      }).toString(),
      {
        headers: {
          ...headers,
          'Content-Type': 'application/x-www-form-urlencoded',
          Origin: BASE_URL,
          Referer: loginUrl,
          Cookie: cookieHeader
        }
      }
    );

    log('info', `  Status: ${loginFormRes.status}`);
    if (loginFormRes.headers['set-cookie']) {
      const setCookies = Array.isArray(loginFormRes.headers['set-cookie']) 
        ? loginFormRes.headers['set-cookie']
        : [loginFormRes.headers['set-cookie']];
      setCookies.forEach(sc => {
        const match = sc.match(/^([^=]+)=([^;]+)/);
        if (match) cookies[match[1]] = match[2];
      });
      log('info', `  Novos cookies: ${Object.keys(cookies).join(', ')}`);
    }

    // Aguardar um pouco
    await new Promise(r => setTimeout(r, 800));

    // STEP 3: POST AJAX login
    log('info', '📍 Step 3: POST /ajax/login.php (AJAX)');
    const ajaxLoginUrl = `${BASE_URL}/ajax/login.php`;
    const cookieHeaderUpdated = Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join('; ');
    
    const ajaxRes = await client.post(
      ajaxLoginUrl,
      new URLSearchParams({
        username: LOGIN_USER,
        password: LOGIN_PASS,
        csrf_token: csrfToken,
        type: '1'
      }).toString(),
      {
        headers: {
          ...headers,
          'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
          'X-Requested-With': 'XMLHttpRequest',
          Origin: BASE_URL,
          Referer: loginUrl,
          Cookie: cookieHeaderUpdated
        }
      }
    );

    log('info', `  Status: ${ajaxRes.status}`);
    const ajaxBody = String(ajaxRes.data || '').trim();
    log('info', `  Response: "${ajaxBody}"`);

    const responseCode = parseInt(ajaxBody, 10);
    let interpretation = '';
    if (responseCode === 1) interpretation = '✅ Login bem-sucedido!';
    else if (responseCode === 2) interpretation = '❌ Usuário/senha incorretos';
    else if (responseCode === 3) interpretation = '⚠️ Conta bloqueada';
    else if (responseCode === 4) interpretation = '❌ Erro de validação (CSRF/sessão)';
    else if (responseCode === 5) interpretation = '⚠️ Erro do servidor';
    else interpretation = '❓ Código desconhecido';
    
    log('info', `  Significado: [${responseCode}] ${interpretation}`);

    if (ajaxRes.headers['set-cookie']) {
      const setCookies = Array.isArray(ajaxRes.headers['set-cookie']) 
        ? ajaxRes.headers['set-cookie']
        : [ajaxRes.headers['set-cookie']];
      setCookies.forEach(sc => {
        const match = sc.match(/^([^=]+)=([^;]+)/);
        if (match) cookies[match[1]] = match[2];
      });
      log('info', `  Novos cookies: ${Object.keys(cookies).join(', ')}`);
    }

    // STEP 4: GET homepage para validar
    log('info', '📍 Step 4: GET /homepage (validar)');
    const cookieHeaderFinal = Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join('; ');
    
    const homepageRes = await client.get(`${BASE_URL}/index.php?page=homepage`, {
      headers: {
        ...headers,
        Cookie: cookieHeaderFinal
      }
    });

    log('info', `  Status: ${homepageRes.status}`);
    const homepageHtml = String(homepageRes.data || '');
    const isLoggedIn = /Meu Perfil|Sair|sair|perfil/i.test(homepageHtml);
    log('info', `  Login validado: ${isLoggedIn ? '✅ SIM' : '❌ NÃO'}`);

    log('info', '=== RESUMO FINAL ===', {
      proxy: PROXY_ENABLED ? 'Sim' : 'Não',
      ajaxResponseCode: responseCode,
      ajaxInterpretation: interpretation,
      homepageStatusCode: homepageRes.status,
      loggedIn: isLoggedIn,
      cookiesObtidos: Object.keys(cookies)
    });

  } catch (error) {
    log('error', `Erro: ${error.message}`, {
      code: error.code,
      errno: error.errno
    });
    process.exit(1);
  }
}

testLogin().catch(err => {
  log('error', 'Erro não capturado:', err);
  process.exit(1);
});
