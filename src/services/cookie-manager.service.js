// src/services/cookie-manager.service.js
// Gerencia renovação automática de cookies Cloudflare e sessão

const axios = require('axios');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

class CookieManagerService {
  constructor(config = {}) {
    this.logger = config.logger || console;
    this.envFilePath = config.envFilePath || path.join(__dirname, '../../.env');
    
    // Configurações
    this.targetUrl = config.targetUrl || 'http://vouver.me'; // URL que requer cookies
    this.checkInterval = config.checkInterval || 3600000; // 1 hora
    this.refreshThreshold = config.refreshThreshold || 86400000; // 24 horas antes de expirar
    this.maxRetries = config.maxRetries || 3;
    this.timeout = config.timeout || 30000;
    this.requireCfClearance = config.requireCfClearance !== false;

    // Estado
    this.sessionCookies = process.env.SESSION_COOKIES || '';
    this.cfClearance = process.env.CF_CLEARANCE || '';
    this.hydrateCfFromSessionCookies();
    this.lastCheck = null;
    this.checkIntervalId = null;
  }

  /**
   * Inicia o monitoramento automático de cookies
   */
  startMonitoring() {
    this.logger.info('[CookieManager] Iniciando monitoramento automático de cookies');
    
    // Fazer check imediato
    this.checkAndRefreshCookies();
    
    // Agendar check periódico
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
   * Verifica e renova cookies se necessário
   */
  async checkAndRefreshCookies() {
    try {
      this.logger.info('[CookieManager] Verificando validade dos cookies...');
      
      const isValid = await this.validateCookies();
      
      if (!isValid) {
        this.logger.warn('[CookieManager] Cookies inválidos ou expirados! Tentando renovar...');
        const refreshed = await this.refreshCookies();
        
        if (refreshed) {
          this.logger.info('[CookieManager] ✅ Cookies renovados com sucesso!');
          this.lastCheck = new Date();
          return true;
        } else {
          this.logger.error('[CookieManager] ❌ Falha ao renovar cookies. Sistema pode estar instável.');
          return false;
        }
      } else {
        this.logger.info('[CookieManager] ✅ Cookies válidos');
        this.lastCheck = new Date();
        return true;
      }
    } catch (error) {
      this.logger.error('[CookieManager] Erro ao verificar cookies:', error.message);
      return false;
    }
  }

  /**
   * Valida se os cookies atuais funcionam fazendo uma requisição test
   */
  async validateCookies() {
    if (!this.hasRequiredCookies()) {
      this.logger.warn('[CookieManager] Cookies obrigatórios não configurados');
      return false;
    }

    try {
      const headers = this.buildHeaders();
      const response = await axios.get(`${this.targetUrl}/api/test`, {
        headers,
        timeout: this.timeout,
        validateStatus: (status) => status < 500
      });

      // Status 200-299 = válido, 301-399 = redirect (pode ser válido), 403-429 = bloqueado (cookie inválido)
      const isValid = response.status < 400 && response.status !== 403 && response.status !== 429;
      
      if (!isValid) {
        this.logger.warn(`[CookieManager] Validação retornou status ${response.status}`);
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

        const preflightCookies = await this.fetchCookiesFromHomePage();
        if (preflightCookies.cfClearance && !this.cfClearance) {
          this.cfClearance = preflightCookies.cfClearance;
          process.env.CF_CLEARANCE = preflightCookies.cfClearance;
          this.logger.info('[CookieManager] ✅ CF_CLEARANCE obtido no preflight');
        }

        if (preflightCookies.sessionCookies) {
          this.sessionCookies = this.ensureEssentialSessionCookies(
            this.mergeSessionCookies(this.sessionCookies, preflightCookies.sessionCookies),
            this.cfClearance || preflightCookies.cfClearance || this.resolveCfClearanceFallback()
          );
          if (this.sessionCookies) {
            process.env.SESSION_COOKIES = this.sessionCookies;
          }
        }

        const payload = new URLSearchParams({
          username: process.env.LOGIN_USER || '',
          password: process.env.LOGIN_PASS || '',
          remember: '1',
          type: '1'
        }).toString();

        // POST para ajax/login.php com credenciais
        const response = await axios.post(`${this.targetUrl}/ajax/login.php`, 
          payload,
          {
            headers: {
              'Content-Type': 'application/x-www-form-urlencoded',
              'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
              'X-Requested-With': 'XMLHttpRequest',
              'Referer': `${this.targetUrl}/`,
              ...(this.buildHeaders().Cookie ? { Cookie: this.buildHeaders().Cookie } : {})
            },
            timeout: this.timeout,
            validateStatus: () => true,
            maxRedirects: 5
          }
        );

        // Extrair cookies da resposta
        let setCookieHeaders = response.headers['set-cookie'] || [];
        if (!Array.isArray(setCookieHeaders)) {
          setCookieHeaders = [setCookieHeaders];
        }

        if (setCookieHeaders.length > 0) {
          const newCookies = this.parseCookiesFromHeaders(setCookieHeaders);
          const mergedSessionCookies = this.ensureEssentialSessionCookies(
            this.mergeSessionCookies(this.sessionCookies, newCookies.sessionCookies),
            this.cfClearance || newCookies.cfClearance || preflightCookies.cfClearance || this.resolveCfClearanceFallback()
          );
          
          if (newCookies.cfClearance) {
            this.cfClearance = newCookies.cfClearance;
            process.env.CF_CLEARANCE = newCookies.cfClearance;
            this.logger.info('[CookieManager] ✅ CF_CLEARANCE renovado');
          } else if (preflightCookies.cfClearance && !this.cfClearance) {
            this.cfClearance = preflightCookies.cfClearance;
            process.env.CF_CLEARANCE = preflightCookies.cfClearance;
            this.logger.info('[CookieManager] ✅ CF_CLEARANCE mantido do preflight');
          }

          if (mergedSessionCookies) {
            this.sessionCookies = mergedSessionCookies;
            process.env.SESSION_COOKIES = mergedSessionCookies;
            this.logger.info('[CookieManager] ✅ SESSION_COOKIES renovados');
          }

          // Validar se os cookies extraídos contêm PHPSESSID (crítico)
          const hasCriticalCookies = this.sessionCookies && this.sessionCookies.includes('PHPSESSID=');
          if (!this.cfClearance) {
            this.cfClearance = this.resolveCfClearanceFallback();
            if (this.cfClearance) {
              process.env.CF_CLEARANCE = this.cfClearance;
              this.logger.info('[CookieManager] ✅ CF_CLEARANCE aplicado por fallback');
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
          this.logger.warn(`[CookieManager] Nenhum Set-Cookie header recebido na tentativa ${attempt}`);
        }
      } catch (error) {
        this.logger.warn(`[CookieManager] Tentativa ${attempt} falhou: ${error.message}`);
      }

      // Aguardar antes de próxima tentativa com exponential backoff
      if (attempt < this.maxRetries) {
        const delayMs = 1000 * Math.pow(2, attempt - 1); // 1s, 2s, 4s
        this.logger.info(`[CookieManager] Aguardando ${delayMs}ms antes da próxima tentativa...`);
        await this.delay(delayMs);
      }
    }

    return false;
  }

  /**
   * Preflight para capturar cookies iniciais (incluindo cf_clearance quando disponível)
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

    // Lista de cookies de sessão importantes
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
        this.logger.info(`[CookieManager] CF_CLEARANCE extraído`);
      }

      // Adicionar cookies de sessão ao Map (evita duplicatas)
      if (sessionCookieNames.includes(trimmedName)) {
        cookies.sessionCookies.set(trimmedName, `${trimmedName}=${trimmedValue}`);
        this.logger.info(`[CookieManager] Cookie extraído: ${trimmedName}`);
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
   * Garante cookies essenciais de sessão mesmo quando o backend retorna parcial
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
   * Resolve fallback de CF_CLEARANCE quando Cloudflare não envia Set-Cookie
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
      
      // Recarregar variáveis no process.env
      Object.assign(process.env, updates);

      if (changed) {
        this.logger.info('[CookieManager] ✅ Arquivo .env atualizado com novos cookies', {
          envFilePath: this.envFilePath,
          previousLength: originalContent.length,
          nextLength: envContent.length
        });
      } else {
        this.logger.info('[CookieManager] ℹ️ .env sem alterações (valores já estavam iguais)', {
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
   * Constrói headers com cookies atuais
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
   * Delay auxiliar
   */
  delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

module.exports = CookieManagerService;
