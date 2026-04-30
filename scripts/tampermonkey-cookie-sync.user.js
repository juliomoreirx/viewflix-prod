// ==UserScript==
// @name         ViewFlix Cookie Sync Webhook
// @namespace    viewflix
// @version      1.3.0
// @description  Envia cookies de sessão do Vouver para o webhook da API automaticamente após login, incluindo cf_clearance HttpOnly.
// @match        http://vouver.me/*
// @match        https://vouver.me/*
// @grant        GM_xmlhttpRequest
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_registerMenuCommand
// @grant        GM_cookie
// @connect      *
// ==/UserScript==

(function () {
  'use strict';

  const DEFAULT_INTERVAL_MS = 5000;
  const LOGIN_CAPTURE_WAIT_MS = 10000;
  const KEY_WEBHOOK = 'vf_webhook_url';
  const KEY_TOKEN = 'vf_webhook_token';
  const KEY_CF_FALLBACK = 'vf_cf_clearance_fallback';
  const KEY_LAST_SENT = 'vf_last_sent_cookie';
  const KEY_LAST_SENT_AT = 'vf_last_sent_at';
  const KEY_LAST_STATUS = 'vf_last_status';

  let statusBadge = null;
  let isSending = false;
  let lastRenderedStatus = '';
  let loginDetectedAt = null;
  let loginSessionActive = false;

  function getWebhookUrl() {
    return (GM_getValue(KEY_WEBHOOK, '') || '').trim();
  }

  function getToken() {
    return (GM_getValue(KEY_TOKEN, '') || '').trim();
  }

  function getCfFallback() {
    return (GM_getValue(KEY_CF_FALLBACK, '') || '').trim();
  }

  function getDocumentCookie() {
    return (document.cookie || '').trim();
  }

  // Função assíncrona para buscar o cf_clearance via API do Tampermonkey (ignora HttpOnly)
function getCfClearanceAsync() {
    return new Promise((resolve) => {
      if (typeof GM_cookie === 'undefined' || !GM_cookie.list) {
        console.warn('[VF Cookie Sync] GM_cookie não suportado. Verifique o @grant.');
        resolve('');
        return;
      }

      // Em vez de buscar só pelo nome, buscamos todos os cookies associados à URL atual
      GM_cookie.list({ url: location.href }, (cookies, error) => {
        if (error) {
          console.error('[VF Cookie Sync] Erro na API do GM_cookie:', error);
          resolve('');
          return;
        }

        // Descomente a linha abaixo se quiser ver no console TUDO que o TM está capturando
        // console.log('[VF Cookie Sync] Todos os cookies capturados pelo GM_cookie:', cookies);

        if (cookies && cookies.length > 0) {
          const cfCookie = cookies.find(c => c.name === 'cf_clearance');
          
          if (cfCookie) {
            console.log('[VF Cookie Sync] cf_clearance ENCONTRADO via API:', cfCookie.value);
            resolve(cfCookie.value.trim());
          } else {
            console.warn('[VF Cookie Sync] cf_clearance NÃO está na lista retornada pelo GM_cookie.');
            resolve('');
          }
        } else {
          console.warn('[VF Cookie Sync] A API não retornou nenhum cookie (Lista vazia).');
          resolve('');
        }
      });
    });
  }

  function parseCookieString(cookieString) {
    const map = new Map();
    if (!cookieString) return map;

    const parts = cookieString
      .split(';')
      .map((item) => item.trim())
      .filter(Boolean);

    for (const part of parts) {
      const separatorIndex = part.indexOf('=');
      if (separatorIndex <= 0) continue;

      const name = part.slice(0, separatorIndex).trim();
      const value = part.slice(separatorIndex + 1).trim();
      if (!name || !value) continue;

      map.set(name, value);
    }

    return map;
  }

  function extractSessionCookies(cookieString) {
    if (!cookieString) return '';

    const cookieMap = parseCookieString(cookieString);
    const wanted = new Set(['PHPSESSID', 'vouverme']);
    const order = ['PHPSESSID', 'vouverme'];

    return order
      .filter((name) => wanted.has(name) && cookieMap.has(name))
      .map((name) => `${name}=${cookieMap.get(name)}`)
      .join('; ');
  }

  function isLikelyLoggedIn(cookieString) {
    return /PHPSESSID=/i.test(cookieString);
  }

  function createOrGetBadge() {
    if (statusBadge && document.body.contains(statusBadge)) {
      return statusBadge;
    }

    const badge = document.createElement('div');
    badge.id = 'vf-cookie-sync-status';
    badge.style.position = 'fixed';
    badge.style.right = '16px';
    badge.style.bottom = '16px';
    badge.style.zIndex = '2147483647';
    badge.style.padding = '10px 12px';
    badge.style.borderRadius = '10px';
    badge.style.fontSize = '12px';
    badge.style.fontFamily = 'Segoe UI, Arial, sans-serif';
    badge.style.fontWeight = '600';
    badge.style.color = '#fff';
    badge.style.background = '#3b3b3b';
    badge.style.boxShadow = '0 4px 12px rgba(0,0,0,.25)';
    badge.style.maxWidth = '280px';
    badge.style.lineHeight = '1.3';
    badge.style.opacity = '0.95';
    badge.style.pointerEvents = 'none';

    document.body.appendChild(badge);
    statusBadge = badge;
    return badge;
  }

  function setStatus(kind, message) {
    const statusLine = `${new Date().toISOString()} | ${kind} | ${message}`;
    if (lastRenderedStatus === `${kind}|${message}`) {
      return;
    }

    GM_setValue(KEY_LAST_STATUS, statusLine);
    const badge = createOrGetBadge();
    badge.textContent = `[Cookie Sync] ${message}`;
    lastRenderedStatus = `${kind}|${message}`;

    if (kind === 'ok') badge.style.background = '#167c3a';
    else if (kind === 'warn') badge.style.background = '#a86800';
    else if (kind === 'error') badge.style.background = '#9f1d1d';
    else badge.style.background = '#3b3b3b';
  }

  function buildPayload(cookieString, cfValue) {
    const sessionCookies = extractSessionCookies(cookieString);
    const cfFallback = getCfFallback();

    // Se encontrou o cf_clearance pelo Tampermonkey, concatena ele no cookie de sessão
    let fullSessionCookies = sessionCookies;
    if (cfValue) {
        fullSessionCookies += fullSessionCookies ? `; cf_clearance=${cfValue}` : `cf_clearance=${cfValue}`;
    }

    return {
      source: 'tampermonkey',
      pageUrl: location.href,
      userAgent: navigator.userAgent,
      sentAt: new Date().toISOString(),
      sessionCookies: fullSessionCookies,
      cfClearance: cfValue || cfFallback
    };
  }

  function saveLastSent(rawCookieString, cfValue) {
    const combinedState = `${rawCookieString}|CF:${cfValue}`;
    GM_setValue(KEY_LAST_SENT, combinedState);
    GM_setValue(KEY_LAST_SENT_AT, Date.now());
  }

  function shouldSend(rawCookieString, cfValue) {
    const lastSent = GM_getValue(KEY_LAST_SENT, '');
    const combinedState = `${rawCookieString}|CF:${cfValue}`;
    if (!lastSent) return true;
    return lastSent !== combinedState;
  }

  function sendPayload(payload, rawCookieString, cfValue, readiness) {
    const webhookUrl = getWebhookUrl();
    const token = getToken();

    if (!webhookUrl) {
      console.warn('[VF Cookie Sync] Webhook não configurado. Use o menu Tampermonkey.');
      setStatus('error', 'Webhook não configurado');
      return;
    }

    if (!token) {
      setStatus('warn', 'Token vazio (local funciona, remoto pode falhar)');
    }

    isSending = true;
    const cfMode = readiness?.hasCfInCookie ? 'capturado' : (readiness?.hasCfFallback ? 'fallback' : 'faltando');
    setStatus('info', `Enviando cookies... (cf: ${cfMode})`);

    GM_xmlhttpRequest({
      method: 'POST',
      url: webhookUrl,
      timeout: 15000,
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {})
      },
      data: JSON.stringify(payload),
      onload: (response) => {
        isSending = false;
        if (response.status >= 200 && response.status < 300) {
          console.log('[VF Cookie Sync] Cookies enviados com sucesso:', response.responseText);
          saveLastSent(rawCookieString, cfValue);
          setStatus('ok', `Enviado com sucesso (cf: ${cfMode})`);
        } else {
          console.warn('[VF Cookie Sync] Falha ao enviar cookies:', response.status, response.responseText);
          setStatus('error', `Falha no webhook (${response.status})`);
        }
      },
      onerror: (error) => {
        isSending = false;
        console.error('[VF Cookie Sync] Erro de rede no envio:', error);
        setStatus('error', 'Erro de rede ao enviar webhook');
      },
      ontimeout: () => {
        isSending = false;
        setStatus('error', 'Timeout no envio ao webhook');
      }
    });
  }

  function evaluateCookieReadiness(rawCookie, cfValue) {
    const hasLogin = isLikelyLoggedIn(rawCookie);
    const hasCfInCookie = !!cfValue;
    const hasCfFallback = !!getCfFallback();
    const hasCfAny = hasCfInCookie || hasCfFallback;

    if (!hasLogin) {
      return { ready: false, reason: 'Aguardando login (PHPSESSID)', hasCfInCookie, hasCfFallback };
    }

    if (!hasCfAny) {
      return {
        ready: false,
        reason: 'Missing cf_clearance (aguardando cookie ou fallback)',
        hasCfInCookie,
        hasCfFallback
      };
    }

    return { ready: true, reason: 'Cookies completos detectados', hasCfInCookie, hasCfFallback };
  }

  async function runSyncAttempt() {
    const rawCookie = getDocumentCookie();

    if (!rawCookie) {
      loginSessionActive = false;
      loginDetectedAt = null;
      setStatus('info', 'Aguardando cookies no navegador');
      return;
    }

    const hasLogin = isLikelyLoggedIn(rawCookie);
    if (!hasLogin) {
      loginSessionActive = false;
      loginDetectedAt = null;
      setStatus('warn', 'Aguardando login (PHPSESSID)');
      return;
    }

    if (!loginSessionActive) {
      loginSessionActive = true;
      loginDetectedAt = Date.now();
      setStatus('info', 'Login detectado. Aguardando 10s para capturar cf_clearance...');
      return;
    }

    // Busca o cf_clearance usando a API do Tampermonkey de forma assíncrona
    const cfValue = await getCfClearanceAsync();
    const readiness = evaluateCookieReadiness(rawCookie, cfValue);

    const elapsedSinceLogin = Date.now() - (loginDetectedAt || Date.now());
    const shouldWaitForCf = !readiness.hasCfInCookie && !readiness.hasCfFallback && elapsedSinceLogin < LOGIN_CAPTURE_WAIT_MS;

    if (shouldWaitForCf) {
      const remainingSec = Math.ceil((LOGIN_CAPTURE_WAIT_MS - elapsedSinceLogin) / 1000);
      setStatus('warn', `Missing cf_clearance. Aguardando ${remainingSec}s...`);
      return;
    }

    if (!readiness.ready) {
      setStatus('warn', `${readiness.reason} | cf: faltando`);
      return;
    }

    if (isSending) {
      setStatus('info', 'Enviando cookies para webhook...');
      return;
    }

    if (!shouldSend(rawCookie, cfValue)) {
      const cfMode = readiness.hasCfInCookie ? 'capturado' : 'fallback';
      setStatus('ok', `Sem mudanças, aguardando atualização (cf: ${cfMode})`);
      return;
    }

    const cfMode = readiness.hasCfInCookie ? 'capturado' : 'fallback';
    setStatus('info', `Cookies completos, iniciando envio... (cf: ${cfMode})`);

    const payload = buildPayload(rawCookie, cfValue);
    if (!payload.sessionCookies) return;

    sendPayload(payload, rawCookie, cfValue, readiness);
  }

  function configureWebhook() {
    const current = getWebhookUrl();
    const next = prompt('Webhook URL (ex: https://seu-dominio/cookies/webhook):', current);
    if (next !== null) {
      GM_setValue(KEY_WEBHOOK, next.trim());
      console.log('[VF Cookie Sync] Webhook salvo:', next.trim());
    }
  }

  function configureToken() {
    const current = getToken();
    const next = prompt('Bearer Token (COOKIE_REFRESH_API_KEY):', current);
    if (next !== null) {
      GM_setValue(KEY_TOKEN, next.trim());
      console.log('[VF Cookie Sync] Token salvo.');
    }
  }

  function configureCfFallback() {
    const current = getCfFallback();
    const next = prompt('CF_CLEARANCE fallback (opcional):', current);
    if (next !== null) {
      GM_setValue(KEY_CF_FALLBACK, next.trim());
      console.log('[VF Cookie Sync] CF fallback salvo.');
    }
  }

  async function forceSyncNow() {
    const rawCookie = getDocumentCookie();
    const cfValue = await getCfClearanceAsync();
    const readiness = evaluateCookieReadiness(rawCookie, cfValue);

    if (!readiness.hasCfInCookie && !readiness.hasCfFallback) {
      setStatus('warn', 'Envio manual sem CF: configure fallback ou aguarde cookie');
    }

    const payload = buildPayload(rawCookie, cfValue);

    if (!payload.sessionCookies) {
      alert('Nenhum cookie de sessão acessível encontrado no document.cookie.');
      setStatus('error', 'Sem cookies de sessão para enviar');
      return;
    }

    sendPayload(payload, rawCookie, cfValue, readiness);
  }

  function showDebugStatus() {
    const lastStatus = GM_getValue(KEY_LAST_STATUS, 'Sem status ainda');
    alert(lastStatus);
  }

  GM_registerMenuCommand('ViewFlix: Configurar Webhook', configureWebhook);
  GM_registerMenuCommand('ViewFlix: Configurar Token', configureToken);
  GM_registerMenuCommand('ViewFlix: Configurar CF Fallback', configureCfFallback);
  GM_registerMenuCommand('ViewFlix: Enviar Agora', forceSyncNow);
  GM_registerMenuCommand('ViewFlix: Ver Último Status', showDebugStatus);

  runSyncAttempt();
  setInterval(runSyncAttempt, DEFAULT_INTERVAL_MS);
})();