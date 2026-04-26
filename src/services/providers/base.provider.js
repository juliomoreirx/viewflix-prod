// src/services/providers/base.provider.js
// Classe base com retry automático para todos os providers

const axios = require('axios');

class BaseProvider {
  constructor(config = {}) {
    this.maxRetries = config.maxRetries || 3;
    this.retryDelay = config.retryDelay || 1000;
    this.timeout = config.timeout || 15000;
    this.logger = config.logger || console;
    this.name = this.constructor.name;
  }

  /**
   * Executa uma requisição com retry automático
   */
  async requestWithRetry(fn, context = '') {
    let lastError;

    for (let attempt = 1; attempt <= this.maxRetries; attempt++) {
      try {
        this.logger.info(`[${this.name}] Tentativa ${attempt}/${this.maxRetries} - ${context}`);
        return await fn();
      } catch (error) {
        lastError = error;
        this.logger.warn(
          `[${this.name}] Tentativa ${attempt} falhou: ${error.message}. ` +
          (attempt < this.maxRetries ? `Retentando em ${this.retryDelay * attempt}ms...` : 'Todas as tentativas falharam.')
        );

        if (attempt < this.maxRetries) {
          await this.delay(this.retryDelay * attempt);
        }
      }
    }

    this.logger.error(`[${this.name}] Falha permanente em ${context}:`, lastError.message);
    throw lastError;
  }

  /**
   * Delay auxiliar
   */
  delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Helper para fazer requisições HTTP com timeout
   */
  async httpGet(url, headers = {}) {
    return axios.get(url, {
      headers,
      timeout: this.timeout,
      validateStatus: () => true // Não lança erro em status > 400
    });
  }

  /**
   * Helper para fazer requisições POST
   */
  async httpPost(url, data, headers = {}) {
    return axios.post(url, data, {
      headers,
      timeout: this.timeout,
      validateStatus: () => true
    });
  }
}

module.exports = BaseProvider;
