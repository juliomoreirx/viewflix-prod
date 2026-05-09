#!/usr/bin/env node
/**
 * Script para testar login via proxy residencial com logs detalhados
 * Uso: node test-proxy-login.js [usa-proxy?]
 * Exemplo: node test-proxy-login.js true
 */

require('dotenv').config();
const axios = require('axios');
const { CookieJar } = require('tough-cookie');
const { wrapper } = require('axios-cookiejar-support');
const { HttpProxyAgent } = require('http-proxy-agent');

const useProxy = process.argv[2] === 'true' || process.argv[2] === '1';

const BASE_URL = process.env.BASE_URL || 'http://vouver.me';
const LOGIN_USER = process.env.LOGIN_USER || '85119rbz';
const LOGIN_PASS = process.env.LOGIN_PASS || 'cyd16156';

// Quando useProxy=true, força uso da proxy mesmo que RES_PROXY_ENABLED esteja desabilitada
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

async function testProxy() {
  try {
    log('info', '=== TESTE DE PROXY E LOGIN ===');
    log('info', `Usando proxy: ${PROXY_ENABLED ? 'SIM' : 'NÃO'}`);
    log('info', `Base URL: ${BASE_URL}`);
    log('info', `Usuário: ${LOGIN_USER}`);
    
    if (PROXY_ENABLED) {
      log('info', `Proxy Host: ${PROXY_HOST}:${PROXY_PORT}`);
      log('info', `Proxy User: ${PROXY_USER ? '***' : 'não configurado'}`);
    }

    // Criar cliente com ou sem proxy
    let clientConfig = {
      headers,
      timeout: 30000,
      validateStatus: () => true,
      maxRedirects: 5
    };

    // Adicionar proxy se habilitada (sem jar para evitar conflito com agents)
    if (PROXY_ENABLED && PROXY_USER && PROXY_PASS) {
      const proxyUrl = `http://${encodeURIComponent(PROXY_USER)}:${encodeURIComponent(PROXY_PASS)}@${PROXY_HOST}:${PROXY_PORT}`;
      const httpAgent = new HttpProxyAgent(proxyUrl);
      clientConfig.httpAgent = httpAgent;
      clientConfig.httpsAgent = httpAgent;
      log('info', '✓ Proxy configurada nos agents');
    }

    const client = axios.create(clientConfig);

    // STEP 1: GET login page
    log('info', '📍 Step 1: Acessando página de login...');
    const loginUrl = `${BASE_URL}/index.php?page=login`;
    
    try {
      const loginPageRes = await client.get(loginUrl);
      log('info', `  Status: ${loginPageRes.status}`, {
        contentLength: loginPageRes.data ? String(loginPageRes.data).length : 0,
        headers: loginPageRes.headers
      });

      const loginHtml = String(loginPageRes.data || '');
      const csrfMatch = loginHtml.match(/name=["']csrf_token["']\s+value=["']([\w-]+)["']/i) ||
                       loginHtml.match(/csrf_token["']\s+value=["']([a-f0-9-]+)["']/i) ||
                       loginHtml.match(/name=["']csrf_token["'][^>]*value=["']([a-f0-9-]+)["']/i);
      
      const csrfToken = csrfMatch ? csrfMatch[1] : '';
      log('info', `  CSRF Token encontrado: ${csrfToken ? 'SIM (' + csrfToken.substring(0, 10) + '...)' : 'NÃO'}`);

      if (!csrfToken) {
        log('warn', `  ⚠️ CSRF token não encontrado. HTML preview: ${loginHtml.substring(0, 300)}`);
      }

      // STEP 2: POST para a página de login
      log('info', '📍 Step 2: Fazendo POST do formulário de login...');
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
            Referer: loginUrl
          }
        }
      );

      log('info', `  Status: ${loginFormRes.status}`, {
        contentLength: loginFormRes.data ? String(loginFormRes.data).length : 0
      });

      // STEP 3: POST para AJAX login
      log('info', '📍 Step 3: Fazendo POST do AJAX login...');
      const ajaxLoginUrl = `${BASE_URL}/ajax/login.php`;
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
            Referer: loginUrl
          }
        }
      );

      log('info', `  Status: ${ajaxRes.status}`, {
        contentType: ajaxRes.headers['content-type'],
        contentLength: ajaxRes.data ? String(ajaxRes.data).length : 0,
        setCookie: ajaxRes.headers['set-cookie'] ? (Array.isArray(ajaxRes.headers['set-cookie']) ? ajaxRes.headers['set-cookie'].length : 1) : 0
      });

      const ajaxBody = String(ajaxRes.data || '');
      log('info', `  AJAX Response: ${ajaxBody.substring(0, 200)}`);
      
      // Interpretar código de resposta
      const responseCode = parseInt(ajaxBody.trim(), 10);
      let responseInterpretation = '';
      switch (responseCode) {
        case 1: responseInterpretation = 'Login bem-sucedido ✅'; break;
        case 2: responseInterpretation = 'Usuário ou senha incorretos'; break;
        case 3: responseInterpretation = 'Conta bloqueada/suspensa'; break;
        case 4: responseInterpretation = 'Erro de validação/CSRF ou credenciais inválidas'; break;
        case 5: responseInterpretation = 'Erro de servidor'; break;
        default: responseInterpretation = 'Código desconhecido';
      }
      log('info', `  Interpretação: [${responseCode}] ${responseInterpretation}`, {
        setCookieCount: ajaxRes.headers['set-cookie'] ? (Array.isArray(ajaxRes.headers['set-cookie']) ? ajaxRes.headers['set-cookie'].length : 1) : 0
      });

      // STEP 4: GET homepage para validar
      log('info', '📍 Step 4: Acessando homepage para validar login...');
      const homepageUrl = `${BASE_URL}/index.php?page=homepage`;
      const homepageRes = await client.get(homepageUrl);

      log('info', `  Status: ${homepageRes.status}`, {
        contentLength: homepageRes.data ? String(homepageRes.data).length : 0
      });

      const homepageHtml = String(homepageRes.data || '');
      const isLoggedIn = /Meu Perfil|Sair|sair|perfil/i.test(homepageHtml);

      log('info', `  Login validado: ${isLoggedIn ? '✅ SIM' : '❌ NÃO'}`);
      
      if (!isLoggedIn) {
        log('warn', `  ⚠️ Página não mostra indicadores de login. HTML preview: ${homepageHtml.substring(0, 300)}`);
      }

      // STEP 5: Listar cookies
      log('info', '📍 Step 5: Cookies obtidos:');
      
      // Extrair cookies dos headers set-cookie
      const setCookieHeaders = ajaxRes.headers['set-cookie'];
      if (setCookieHeaders) {
        const setCookieArray = Array.isArray(setCookieHeaders) ? setCookieHeaders : [setCookieHeaders];
        setCookieArray.forEach((setCookie) => {
          const match = setCookie.match(/^([^=]+)=([^;]+)/);
          if (match) {
            log('info', `  ${match[1]}=${match[2].substring(0, 30)}...`, {
              full: setCookie.substring(0, 80)
            });
          }
        });
      } else {
        log('warn', '  ⚠️ Nenhum Set-Cookie header recebido!');
      }

      log('info', '=== TESTE CONCLUÍDO ===', {
        sucesso: ajaxRes.status < 400 && isLoggedIn,
        statusAjax: ajaxRes.status,
        statusHomepage: homepageRes.status,
        loggedIn: isLoggedIn
      });

    } catch (requestError) {
      log('error', `Erro na requisição: ${requestError.message}`, {
        code: requestError.code,
        errno: requestError.errno
      });
    }

  } catch (error) {
    log('error', `Erro fatal: ${error.message}`, {
      stack: error.stack
    });
    process.exit(1);
  }
}

// Executar
testProxy().catch(err => {
  log('error', 'Erro não capturado:', err);
  process.exit(1);
});
