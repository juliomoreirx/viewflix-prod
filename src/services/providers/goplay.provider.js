// src/services/providers/goplay.provider.js
// Provider para o GoPlay (streaming de conteúdo)

const BaseProvider = require('./base.provider');

class GoPlayProvider extends BaseProvider {
  constructor(config = {}) {
    super(config);
    this.baseUrl = config.baseUrl || 'http://goplay.icu/api';
    this.timeout = config.timeout || 25000;
  }

  /**
   * Obtém link de streaming para um conteúdo
   */
  async getStreamLink(contentId, mediaType = 'movie', options = {}) {
    return this.requestWithRetry(
      async () => {
        const params = new URLSearchParams({
          id: contentId,
          type: mediaType,
          quality: options.quality || 'auto',
          ...options
        });

        const response = await this.httpGet(
          `${this.baseUrl}/stream?${params}`
        );

        if (response.status !== 200 || !response.data?.url) {
          throw new Error(`HTTP ${response.status}: Link de streaming não disponível`);
        }

        return {
          url: response.data.url,
          quality: response.data.quality || 'auto',
          expiresIn: response.data.expiresIn || 3600,
          headers: response.data.headers || {}
        };
      },
      `getStreamLink(${contentId})`
    );
  }

  /**
   * Valida um link de streaming
   */
  async validateStreamLink(streamUrl) {
    return this.requestWithRetry(
      async () => {
        const response = await this.httpGet(streamUrl, {
          'Range': 'bytes=0-0'
        });

        return response.status === 206 || response.status === 200;
      },
      `validateStreamLink`
    );
  }

  /**
   * Obtém informações de um episódio (para séries)
   */
  async getEpisodeInfo(contentId, season, episode) {
    return this.requestWithRetry(
      async () => {
        const response = await this.httpGet(
          `${this.baseUrl}/episode/${contentId}/s${season}e${episode}`
        );

        if (response.status !== 200) {
          throw new Error(`HTTP ${response.status}: Episódio não encontrado`);
        }

        return response.data;
      },
      `getEpisodeInfo(${contentId}:s${season}e${episode})`
    );
  }

  /**
   * Testa conexão com o provider
   */
  async healthCheck() {
    try {
      const response = await this.httpGet(`${this.baseUrl}/health`);
      return response.status === 200;
    } catch {
      return false;
    }
  }
}

module.exports = GoPlayProvider;
