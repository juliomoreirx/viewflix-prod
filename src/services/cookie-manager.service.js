// src/services/cookie-manager.service.js
// Gerencia renovaÃ§Ã£o automÃ¡tica de cookies Cloudflare e sessÃ£o

const axios = require('axios');
const { CookieJar } = require('tough-cookie');
const { wrapper } = require('axios-cookiejar-support');
const { HttpProxyAgent } = require('http-proxy-agent');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const env = require('../config/env');

class CookieManagerService {
  constructor(config = {}) {
    this.logger = config.logger || console;
    this.envFilePath = config.envFilePath || path.join(__dirname, '../../.env');
    
    // ConfiguraÃ§Ãµes
    this.targetUrl = config.targetUrl || 'http://vouver.me'; // URL que requer cookies
    this.checkInterval = config.checkInterval || 300000; // 5 minutos
    this.refreshThreshold = config.refreshThreshold || 86400000; // 24 horas antes de expirar
    this.maxRetries = config.maxRetries || 3;
    this.timeout = config.timeout || 30000;
    this.requireCfClearance = config.requireCfClearance !== false;
    this.homepageUrl = `${this.targetUrl}/index.php?page=homepage`;
    this.loginUrl = `${this.targetUrl}/index.php?page=login`;
    this.ajaxLoginUrl = `${this.targetUrl}/ajax/login.php`;
    this.residentialProxyAgent = this.buildResidentialProxyAgent();

    // Estado
    this.sessionCookies = process.env.SESSION_COOKIES || '';
    this.cfClearance = process.env.CF_CLEARANCE || '';
    this.hydrateCfFromSessionCookies();
    this.lastCheck = null;
    this.checkIntervalId = null;
  }

  /**
   * Inicia o monitoramento automÃ¡tico de cookies
   */
  startMonitoring() {
    this.logger.info('[CookieManager] Iniciando monitoramento automÃ¡tico de cookies');
    
    // Fazer check imediato
    this.checkAndRefreshCookies();
    
    // Agendar check periÃ³dico
    this.checkIntervalId = setInterval(
      () => this.checkAndRefreshCookies(),
      this.checkInterval
    );
  }

  /**
   * Para o monitoramento
   */
  stopMonitoring() {
    if (this.checkIntervalId) {
      clearInterval(this.checkIntervalId);
      this.checkIntervalId = null;
      this.logger.info('[CookieManager] Monitoramento de cookies pausado');
    }
  }

  /**
   * Verifica e renova cookies se necessÃ¡rio
   */
  async checkAndRefreshCookies() {
    try {
      this.logger.info('[CookieManager] Verificando validade dos cookies...');
      
      const isValid = await this.validateCookies();
      
      if (!isValid) {
        this.logger.warn('[CookieManager] Cookies invÃ¡lidos ou expirados! Tentando renovar...');
        const refreshed = await this.refreshCookies();
        
        if (refreshed) {
          this.logger.info('[CookieManager] âœ… Cookies renovados com sucesso!');
          this.lastCheck = new Date();
          return true;
        } else {
          this.logger.warn('[CookieManager] âš ï¸ Falha ao renovar cookies. Continuando com cookies antigos por fallback.');
          // Permitir continuar com cookies expirados como fallback
          this.lastCheck = new Date();
          return this.hasRequiredCookies();
        }
      } else {
        this.logger.info('[CookieManager] âœ… Cookies vÃ¡lidos');
        this.lastCheck = new Date();
        return true;
      }
    } catch (error) {
      this.logger.error('[CookieManager] Erro ao verificar cookies:', error.message);
      // Fallback: permitir continuar se jÃ¡ tem cookies configurados
      return this.hasRequiredCookies();
    }
  }

  /**
   * Valida se os cookies atuais funcionam fazendo uma requisiÃ§Ã£o test
   */
  async validateCookies() {
    if (!this.hasRequiredCookies()) {
      this.logger.warn('[CookieManager] Cookies obrigatÃ³rios nÃ£o configurados');
      return false;
    }

    try {
      const headers = this.buildHeaders();
      const response = await axios.get(this.homepageUrl, {
        ...this.withOptionalResidentialProxy({}, this.homepageUrl),
        headers,
        timeout: this.timeout,
        validateStatus: (status) => status < 500
      });

      const responseBody = typeof response.data === 'string' ? response.data : String(response.data || '');
      const looksLoggedIn = /Meu Perfil|Sair|sair|perfil/i.test(responseBody);
      const isValid = response.status >= 200 && response.status < 400 && looksLoggedIn;
      
      if (!isValid) {
        this.logger.warn(`[CookieManager] ValidaÃ§Ã£o retornou status ${response.status}`, {
          looksLoggedIn,
          bodyPreview: responseBody.substring(0, 120)
        });
      }

      return isValid;
    } catch (error) {
      this.logger.error('[CookieManager] Erro ao validar cookies:', error.message);
      return false;
    }
  }

  /**
   * Tenta renovar os cookies fazendo login via AJAX
   */
  async refreshCookies() {
    for (let attempt = 1; attempt <= this.maxRetries; attempt++) {
      try {
        this.logger.info(`[CookieManager] Tentativa ${attempt}/${this.maxRetries} de renovar cookies`);

        const jar = new CookieJar();
        const seedCookieString = this.buildHeaders().Cookie || '';
        const seededCookies = this.parseCookieString(seedCookieString);

        for (const [name, value] of seededCookies.entries()) {
          await jar.setCookie(`${name}=${value}; Path=/`, this.targetUrl);
          await jar.setCookie(`${name}=${value}; Path=/`, this.targetUrl.replace(/^http:\/\//i, 'https://'));
        }

        if (this.cfClearance) {
          const cfCookieValue = this.cfClearance.startsWith('cf_clearance=')
            ? this.cfClearance
            : `cf_clearance=${this.cfClearance}`;
          await jar.setCookie(`${cfCookieValue}; Path=/`, this.targetUrl);
          await jar.setCookie(`${cfCookieValue}; Path=/`, this.targetUrl.replace(/^http:\/\//i, 'https://'));
        }

        const client = wrapper(axios.create({ jar, withCredentials: true }));

        const loginPageResponse = await client.get(this.loginUrl, {
          ...this.withOptionalResidentialProxy({}, this.loginUrl),
          headers: this.buildBrowserHeaders(),
          timeout: this.timeout,
          maxRedirects: 5,
          validateStatus: (status) => status < 500
        });

        const loginPageHtml = String(loginPageResponse.data || '');
        const csrfMatch =
          loginPageHtml.match(/name=["']csrf_token["']\s+value=["']([\w-]+)["']/i) ||
          loginPageHtml.match(/csrf_token["']\s+value=["']([a-f0-9-]+)["']/i) ||
          loginPageHtml.match(/name=["']csrf_token["'][^>]*value=["']([a-f0-9-]+)["']/i);
        const csrfToken = csrfMatch ? csrfMatch[1] : '';

        if (!csrfToken) {
          this.logger.warn('[CookieManager] CSRF token nÃ£o encontrado na pÃ¡gina de login');
        }

        await client.post(
          this.loginUrl,
          new URLSearchParams({
            username: process.env.LOGIN_USER || '',
            sifre: process.env.LOGIN_PASS || '',
            beni_hatirla: 'on',
            csrf_token: csrfToken,
            recaptcha_response: '',
            login: 'Acessar'
          }).toString(),
          {
            ...this.withOptionalResidentialProxy({}, this.loginUrl),
            headers: {
              ...this.buildBrowserHeaders(),
              'Content-Type': 'application/x-www-form-urlencoded',
              Origin: this.targetUrl,
              Referer: this.loginUrl
            },
            timeout: this.timeout,
            maxRedirects: 5,
            validateStatus: (status) => status < 500
          }
        );

        // Aguardar para permitir sessão ser estabelecida no servidor (800ms mínimo)
        await new Promise(resolve => setTimeout(resolve, 800));

        const response = await client.post(
          this.ajaxLoginUrl,
          new URLSearchParams({
            username: process.env.LOGIN_USER || '',
            password: process.env.LOGIN_PASS || '',
            csrf_token: csrfToken,
            type: '1'
          }).toString(),
          {
            ...this.withOptionalResidentialProxy({}, this.ajaxLoginUrl),
            headers: {
              ...this.buildBrowserHeaders(),
              'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
              'X-Requested-With': 'XMLHttpRequest',
              Origin: this.targetUrl,
              Referer: this.loginUrl
            },
            timeout: this.timeout,
            validateStatus: () => true,
            maxRedirects: 5
          }
        );

        const responsePreview = typeof response.data === 'string' ? response.data : JSON.stringify(response.data || '');
        this.logger.debug(`[CookieManager] Login response status: ${response.status}, data: ${responsePreview.substring(0, 200)}`);

        // Extrair cookies da resposta
        let setCookieHeaders = response.headers['set-cookie'] || [];
        if (!Array.isArray(setCookieHeaders)) {
          setCookieHeaders = [setCookieHeaders];
        }

        if (setCookieHeaders.length > 0) {
          const newCookies = this.parseCookiesFromHeaders(setCookieHeaders);
          const mergedSessionCookies = this.ensureEssentialSessionCookies(
            this.mergeSessionCookies(this.sessionCookies, newCookies.sessionCookies),
            this.cfClearance || newCookies.cfClearance || this.resolveCfClearanceFallback()
          );
          
          if (newCookies.cfClearance) {
            this.cfClearance = newCookies.cfClearance;
            process.env.CF_CLEARANCE = newCookies.cfClearance;
            this.logger.info('[CookieManager] âœ… CF_CLEARANCE renovado');
          } else if (!this.cfClearance) {
            const fallbackCf = this.resolveCfClearanceFallback();
            if (fallbackCf) {
              this.cfClearance = fallbackCf;
              process.env.CF_CLEARANCE = fallbackCf;
              this.logger.info('[CookieManager] âœ… CF_CLEARANCE mantido por fallback');
            }
          }

          if (mergedSessionCookies) {
            this.sessionCookies = mergedSessionCookies;
            process.env.SESSION_COOKIES = mergedSessionCookies;
            this.logger.info('[CookieManager] âœ… SESSION_COOKIES renovados');
          }

          // Validar se os cookies extraÃ­dos contÃªm PHPSESSID (crÃ­tico)
          const hasCriticalCookies = this.sessionCookies && this.sessionCookies.includes('PHPSESSID=');
          if (!this.cfClearance) {
            this.cfClearance = this.resolveCfClearanceFallback();
            if (this.cfClearance) {
              process.env.CF_CLEARANCE = this.cfClearance;
              this.logger.info('[CookieManager] âœ… CF_CLEARANCE aplicado por fallback');
            }
          }
          const hasRequiredCf = !this.requireCfClearance || !!this.cfClearance;
          
          if (hasCriticalCookies && hasRequiredCf) {
            // Salvar no .env
            await this.updateEnvFile({
              SESSION_COOKIES: this.sessionCookies,
              CF_CLEARANCE: this.cfClearance
            });
            return true;
          } else {
            this.logger.warn(`[CookieManager] Cookies incompletos na tentativa ${attempt}`, {
              hasPhpSessId: !!hasCriticalCookies,
              hasCfClearance: !!this.cfClearance,
              requireCfClearance: this.requireCfClearance
            });
          }
        } else {
          this.logger.warn(`[CookieManager] Nenhum Set-Cookie header recebido na tentativa ${attempt}. Status: ${response.status}, body preview: ${JSON.stringify(response.data).substring(0, 300)}`);
        }
      } catch (error) {
        this.logger.warn(`[CookieManager] Tentativa ${attempt} falhou: ${error.message}`);
      }

      // Aguardar antes de prÃ³xima tentativa com exponential backoff
      if (attempt < this.maxRetries) {
        const delayMs = 1000 * Math.pow(2, attempt - 1); // 1s, 2s, 4s
        this.logger.info(`[CookieManager] Aguardando ${delayMs}ms antes da prÃ³xima tentativa...`);
        await this.delay(delayMs);
      }
    }

    // Fallback: tentar disparar o worker Puppeteer se tudo falhou
    this.logger.warn('[CookieManager] Todos os retries falharam. Tentando fallback com worker Puppeteer...');
    try {
      await this.triggerWorkerFallback();
    } catch (workerError) {
      this.logger.error('[CookieManager] Erro ao tentar fallback do worker:', workerError.message);
    }

    return false;
  }

  /**
   * Preflight para capturar cookies iniciais (incluindo cf_clearance quando disponÃ­vel)
   */
  async fetchCookiesFromHomePage() {
    try {
      const response = await axios.get(`${this.targetUrl}/`, {
        timeout: this.timeout,
        validateStatus: () => true,
        maxRedirects: 5,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'pt-BR,pt;q=0.9,en-US;q=0.8'
        }
      });

      const setCookieHeaders = response.headers['set-cookie'];
      if (!setCookieHeaders || !Array.isArray(setCookieHeaders)) {
        return { cfClearance: null, sessionCookies: null };
      }

      return this.parseCookiesFromHeaders(setCookieHeaders);
    } catch (error) {
      this.logger.warn(`[CookieManager] Preflight sem cookies: ${error.message}`);
      return { cfClearance: null, sessionCookies: null };
    }
  }

  /**
   * Extrai cookies dos headers Set-Cookie
   */
  parseCookiesFromHeaders(setCookieHeaders) {
    const cookies = {
      cfClearance: null,
      sessionCookies: new Map() // Usar Map para evitar duplicatas
    };

    // Lista de cookies de sessÃ£o importantes
    const sessionCookieNames = ['PHPSESSID', 'vouverme', 'username', 'password'];

    for (const setCookie of setCookieHeaders) {
      // Parse: "name=value; Path=/; HttpOnly; Secure"
      const parts = setCookie.split(';');
      const firstPart = parts[0].trim();
      const [name, value] = firstPart.split('=');

      if (!name || !value) continue;

      const trimmedName = name.trim();
      const trimmedValue = value.trim();

      // Tratar cf_clearance especialmente
      if (trimmedName.toLowerCase() === 'cf_clearance') {
        cookies.cfClearance = trimmedValue;
        this.logger.info(`[CookieManager] CF_CLEARANCE extraÃ­do`);
      }

      // Adicionar cookies de sessÃ£o ao Map (evita duplicatas)
      if (sessionCookieNames.includes(trimmedName)) {
        cookies.sessionCookies.set(trimmedName, `${trimmedName}=${trimmedValue}`);
        this.logger.info(`[CookieManager] Cookie extraÃ­do: ${trimmedName}`);
      }
    }

    // Consolidar session cookies em uma string
    let sessionCookiesString = null;
    if (cookies.sessionCookies.size > 0) {
      sessionCookiesString = Array.from(cookies.sessionCookies.values()).join('; ');
    }

    return {
      cfClearance: cookies.cfClearance,
      sessionCookies: sessionCookiesString
    };
  }

  /**
   * Converte string de cookies (k=v; k2=v2) em Map
   */
  parseCookieString(cookieString) {
    const map = new Map();

    if (!cookieString || typeof cookieString !== 'string') {
      return map;
    }

    const parts = cookieString
      .split(';')
      .map((item) => item.trim())
      .filter(Boolean);

    for (const item of parts) {
      const separatorIndex = item.indexOf('=');
      if (separatorIndex <= 0) continue;

      const name = item.slice(0, separatorIndex).trim();
      const value = item.slice(separatorIndex + 1).trim();

      if (!name || !value) continue;
      map.set(name, value);
    }

    return map;
  }

  /**
   * Faz merge seguro dos cookies atuais + novos
   * Evita perder cookies quando o servidor retorna apenas PHPSESSID
   */
  mergeSessionCookies(currentCookies, incomingCookies) {
    const currentMap = this.parseCookieString(currentCookies);
    const incomingMap = this.parseCookieString(incomingCookies);

    for (const [name, value] of incomingMap.entries()) {
      currentMap.set(name, value);
    }

    if (currentMap.size === 0) {
      return null;
    }

    return Array.from(currentMap.entries())
      .map(([name, value]) => `${name}=${value}`)
      .join('; ');
  }

  /**
   * Garante cookies essenciais de sessÃ£o mesmo quando o backend retorna parcial
   */
  ensureEssentialSessionCookies(cookieString, cfClearanceValue = '') {
    const cookieMap = this.parseCookieString(cookieString);

    if (!cookieMap.get('username') && process.env.LOGIN_USER) {
      cookieMap.set('username', process.env.LOGIN_USER);
    }

    if (!cookieMap.get('password') && process.env.LOGIN_PASS) {
      cookieMap.set('password', process.env.LOGIN_PASS);
    }

    if (cfClearanceValue) {
      cookieMap.set('cf_clearance', cfClearanceValue.replace(/^cf_clearance=/i, '').trim());
    }

    if (cookieMap.size === 0) {
      return null;
    }

    return this.serializeSessionCookies(cookieMap);
  }

  /**
   * Serializa cookies na ordem esperada pelo backend, mantendo cf_clearance no corpo.
   */
  serializeSessionCookies(cookieMap) {
    const orderedKeys = ['PHPSESSID', 'vouverme', 'username', 'password', 'cf_clearance'];

    return orderedKeys
      .filter((key) => cookieMap.has(key))
      .map((key) => `${key}=${cookieMap.get(key)}`)
      .join('; ');
  }

  /**
   * Se CF_CLEARANCE estiver embutido em SESSION_COOKIES, normaliza para campo dedicado
   */
  hydrateCfFromSessionCookies() {
    if (this.cfClearance) {
      return;
    }

    const cookieMap = this.parseCookieString(this.sessionCookies);
    const cfFromSession = cookieMap.get('cf_clearance');

    if (cfFromSession) {
      this.cfClearance = cfFromSession;
      process.env.CF_CLEARANCE = cfFromSession;
      this.logger.info('[CookieManager] CF_CLEARANCE hidratado a partir de SESSION_COOKIES');
    }
  }

  /**
   * Resolve fallback de CF_CLEARANCE quando Cloudflare nÃ£o envia Set-Cookie
   */
  resolveCfClearanceFallback() {
    if (this.cfClearance) {
      return this.cfClearance;
    }

    if (process.env.CF_CLEARANCE_FALLBACK) {
      return process.env.CF_CLEARANCE_FALLBACK;
    }

    const fromSession = this.parseCookieString(this.sessionCookies).get('cf_clearance');
    if (fromSession) {
      return fromSession;
    }

    return '';
  }

  hasRequiredCookies() {
    const hasSession = !!(this.sessionCookies && this.sessionCookies.includes('PHPSESSID='));
    const hasCf = !!this.cfClearance;
    return hasSession && (!this.requireCfClearance || hasCf);
  }

  /**
   * Atualiza o arquivo .env com novos cookies
   */
  async updateEnvFile(updates) {
    try {
      const originalContent = fs.readFileSync(this.envFilePath, 'utf8');
      let envContent = originalContent;

      // Substituir ou adicionar SESSION_COOKIES
      if (updates.SESSION_COOKIES) {
        const sessionRegex = /^SESSION_COOKIES=.*/m;
        if (sessionRegex.test(envContent)) {
          envContent = envContent.replace(sessionRegex, `SESSION_COOKIES=${updates.SESSION_COOKIES}`);
        } else {
          envContent += `\nSESSION_COOKIES=${updates.SESSION_COOKIES}`;
        }
      }

      // Substituir ou adicionar CF_CLEARANCE
      if (updates.CF_CLEARANCE) {
        const cfRegex = /^CF_CLEARANCE=.*/m;
        if (cfRegex.test(envContent)) {
          envContent = envContent.replace(cfRegex, `CF_CLEARANCE=${updates.CF_CLEARANCE}`);
        } else {
          envContent += `\nCF_CLEARANCE=${updates.CF_CLEARANCE}`;
        }
      }

      const originalHash = crypto.createHash('sha1').update(originalContent).digest('hex');
      const nextHash = crypto.createHash('sha1').update(envContent).digest('hex');
      const changed = originalHash !== nextHash;

      if (changed) {
        fs.writeFileSync(this.envFilePath, envContent, 'utf8');
      }
      
      // Recarregar variÃ¡veis no process.env
      Object.assign(process.env, updates);

      if (changed) {
        this.logger.info('[CookieManager] âœ… Arquivo .env atualizado com novos cookies', {
          envFilePath: this.envFilePath,
          previousLength: originalContent.length,
          nextLength: envContent.length
        });
      } else {
        this.logger.info('[CookieManager] â„¹ï¸ .env sem alteraÃ§Ãµes (valores jÃ¡ estavam iguais)', {
          envFilePath: this.envFilePath
        });
      }

      return true;
    } catch (error) {
      this.logger.error('[CookieManager] Erro ao atualizar .env:', error.message);
      return false;
    }
  }

  /**
   * ConstrÃ³i headers com cookies atuais
   */
  buildHeaders() {
    const headers = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'pt-BR,pt;q=0.9,en-US;q=0.8',
      'Cache-Control': 'max-age=0'
    };

    if (this.sessionCookies) {
      headers['Cookie'] = this.sessionCookies;
    }

    const sessionHasCfClearance = !!this.parseCookieString(this.sessionCookies).get('cf_clearance');

    if (this.cfClearance && !sessionHasCfClearance) {
      const cfCookieValue = this.cfClearance.startsWith('cf_clearance=')
        ? this.cfClearance
        : `cf_clearance=${this.cfClearance}`;

      headers['Cookie'] = headers['Cookie']
        ? `${headers['Cookie']}; ${cfCookieValue}`
        : cfCookieValue;
    }

    return headers;
  }

  buildBrowserHeaders() {
    return {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
      'Accept-Language': 'pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7',
      Connection: 'keep-alive'
    };
  }

  buildResidentialProxyAgent() {
    const proxyEnabled = String(env.RES_PROXY_ENABLED || process.env.RES_PROXY_ENABLED || 'false')
      .replace(/['"]/g, '')
      .trim()
      .toLowerCase() === 'true';
    const proxyHost = (env.RES_PROXY_HOST || process.env.RES_PROXY_HOST || '').trim();
    const proxyPort = parseInt(String(env.RES_PROXY_PORT || process.env.RES_PROXY_PORT || '0').trim(), 10);
    const proxyUser = env.RES_PROXY_USER || process.env.RES_PROXY_USER || '';
    const proxyPass = env.RES_PROXY_PASS || process.env.RES_PROXY_PASS || '';

    if (!proxyEnabled || !proxyHost || !proxyPort || !proxyUser || !proxyPass) {
      return null;
    }

    const proxyUrl = `http://${encodeURIComponent(proxyUser)}:${encodeURIComponent(proxyPass)}@${proxyHost}:${proxyPort}`;
    return new HttpProxyAgent(proxyUrl);
  }

  shouldUseResidentialProxy(url = '') {
    try {
      const host = new URL(url).hostname.toLowerCase();
      return host === 'vouver.me' || host.endsWith('.vouver.me');
    } catch {
      return false;
    }
  }

  withOptionalResidentialProxy(axiosConfig = {}, url = '') {
    if (this.residentialProxyAgent && this.shouldUseResidentialProxy(url)) {
      return {
        ...axiosConfig,
        httpAgent: this.residentialProxyAgent,
        httpsAgent: this.residentialProxyAgent,
        proxy: false
      };
    }

    return axiosConfig;
  }

  /**
   * Aplica cookies recebidos externamente (webhook/browser) e persiste no .env
   */
  async applyExternalCookies(payload = {}) {
    const incomingSessionRaw = String(payload.sessionCookies || payload.cookie || '').trim();
    const incomingCfRaw = String(payload.cfClearance || payload.cf_clearance || '').trim();

    const incomingCf = incomingCfRaw
      ? incomingCfRaw.replace(/^cf_clearance=/i, '').trim()
      : this.resolveCfClearanceFallback();

    const normalizedSession = this.ensureEssentialSessionCookies(
      this.mergeSessionCookies(this.sessionCookies, incomingSessionRaw),
      incomingCf || this.cfClearance
    );

    const normalizedCf = incomingCf;

    if (normalizedSession) {
      this.sessionCookies = normalizedSession;
      process.env.SESSION_COOKIES = normalizedSession;
    }

    if (normalizedCf) {
      this.cfClearance = normalizedCf;
      process.env.CF_CLEARANCE = normalizedCf;
    }

    this.sessionCookies = this.ensureEssentialSessionCookies(this.sessionCookies, this.cfClearance);
    process.env.SESSION_COOKIES = this.sessionCookies;

    const ready = this.hasRequiredCookies();

    await this.updateEnvFile({
      SESSION_COOKIES: this.sessionCookies,
      CF_CLEARANCE: this.cfClearance
    });

    return {
      ready,
      hasSessionCookies: !!this.sessionCookies,
      hasCfClearance: !!this.cfClearance,
      sessionLength: this.sessionCookies ? this.sessionCookies.length : 0,
      cfLength: this.cfClearance ? this.cfClearance.length : 0
    };
  }

  /**
   * Obter status atual dos cookies
   */
  getStatus() {
    return {
      lastCheck: this.lastCheck,
      hasSessionCookies: !!this.sessionCookies,
      hasCfClearance: !!this.cfClearance,
      monitoring: !!this.checkIntervalId,
      checkInterval: this.checkInterval,
      refreshThreshold: this.refreshThreshold
    };
  }

  /**
   * Dispara o worker Puppeteer em background para obter cookies via browser
   * NÃ£o bloqueia o fluxo principal; retorna uma promise que resolve rapidamente
   */
  async triggerWorkerFallback() {
    const { spawn } = require('child_process');
    const workerPath = path.join(__dirname, '../../viewflix-worker/index.js');

    if (!fs.existsSync(workerPath)) {
      this.logger.warn('[CookieManager] Worker nÃ£o encontrado em', workerPath);
      return;
    }

    this.logger.info('[CookieManager] Disparando worker Puppeteer para renovar cookies...');

    // Spawn em background, nÃ£o aguarda
    const workerProcess = spawn('node', [workerPath], {
      detached: true,
      stdio: 'ignore',
      cwd: path.dirname(workerPath)
    });

    // Permite que o processo pai encerre sem esperar pelo worker
    workerProcess.unref();

    this.logger.info('[CookieManager] Worker disparado com PID:', workerProcess.pid);
  }

  /**
   * Delay auxiliar
   */
  delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

module.exports = CookieManagerService;

