// ==UserScript==
// @name         ViewFlix Cookie Sync Webhook
// @namespace    viewflix
// @version      1.0.0
// @description  Envia cookies de sessão do Vouver para o webhook da API automaticamente após login.
// @match        http://vouver.me/*
// @match        https://vouver.me/*
// @grant        GM_xmlhttpRequest
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_registerMenuCommand
// @connect      *
// ==/UserScript==

(function () {
  'use strict';

  const DEFAULT_INTERVAL_MS = 15000;
  const KEY_WEBHOOK = 'vf_webhook_url';
  const KEY_TOKEN = 'vf_webhook_token';
  const KEY_CF_FALLBACK = 'vf_cf_clearance_fallback';
  const KEY_LAST_SENT = 'vf_last_sent_cookie';
  const KEY_LAST_SENT_AT = 'vf_last_sent_at';

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

  function extractSessionCookies(cookieString) {
    if (!cookieString) return '';

    const parts = cookieString
      .split(';')
      .map((item) => item.trim())
      .filter(Boolean);

    const wanted = new Set(['PHPSESSID', 'vouverme', 'username', 'password', 'cf_clearance']);
    const keep = [];

    for (const part of parts) {
      const separatorIndex = part.indexOf('=');
      if (separatorIndex <= 0) continue;

      const name = part.slice(0, separatorIndex).trim();
      if (!wanted.has(name)) continue;
      keep.push(part);
    }

    return keep.join('; ');
  }

  function isLikelyLoggedIn(cookieString) {
    return /PHPSESSID=/i.test(cookieString);
  }

  function buildPayload(cookieString) {
    const sessionCookies = extractSessionCookies(cookieString);
    return {
      source: 'tampermonkey',
      pageUrl: location.href,
      userAgent: navigator.userAgent,
      sentAt: new Date().toISOString(),
      sessionCookies,
      cfClearance: getCfFallback()
    };
  }

  function saveLastSent(rawCookieString) {
    GM_setValue(KEY_LAST_SENT, rawCookieString);
    GM_setValue(KEY_LAST_SENT_AT, Date.now());
  }

  function shouldSend(rawCookieString) {
    const lastSent = GM_getValue(KEY_LAST_SENT, '');
    if (!lastSent) return true;
    return lastSent !== rawCookieString;
  }

  function sendPayload(payload) {
    const webhookUrl = getWebhookUrl();
    const token = getToken();

    if (!webhookUrl) {
      console.warn('[VF Cookie Sync] Webhook não configurado. Use o menu Tampermonkey.');
      return;
    }

    GM_xmlhttpRequest({
      method: 'POST',
      url: webhookUrl,
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {})
      },
      data: JSON.stringify(payload),
      onload: (response) => {
        if (response.status >= 200 && response.status < 300) {
          console.log('[VF Cookie Sync] Cookies enviados com sucesso:', response.responseText);
        } else {
          console.warn('[VF Cookie Sync] Falha ao enviar cookies:', response.status, response.responseText);
        }
      },
      onerror: (error) => {
        console.error('[VF Cookie Sync] Erro de rede no envio:', error);
      }
    });
  }

  function runSyncAttempt() {
    const rawCookie = getDocumentCookie();
    if (!rawCookie) return;

    if (!isLikelyLoggedIn(rawCookie)) return;

    if (!shouldSend(rawCookie)) return;

    const payload = buildPayload(rawCookie);
    if (!payload.sessionCookies) return;

    sendPayload(payload);
    saveLastSent(rawCookie);
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

  function forceSyncNow() {
    const rawCookie = getDocumentCookie();
    const payload = buildPayload(rawCookie);

    if (!payload.sessionCookies) {
      alert('Nenhum cookie de sessão acessível encontrado no document.cookie.');
      return;
    }

    sendPayload(payload);
    saveLastSent(rawCookie);
  }

  GM_registerMenuCommand('ViewFlix: Configurar Webhook', configureWebhook);
  GM_registerMenuCommand('ViewFlix: Configurar Token', configureToken);
  GM_registerMenuCommand('ViewFlix: Configurar CF Fallback', configureCfFallback);
  GM_registerMenuCommand('ViewFlix: Enviar Agora', forceSyncNow);

  runSyncAttempt();
  setInterval(runSyncAttempt, DEFAULT_INTERVAL_MS);
})();
