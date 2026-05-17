// src/services/providers/vouver.provider.js
// Provider para o Vouver (catálogo de filmes e séries)

const BaseProvider = require('./base.provider');

class VouverProvider extends BaseProvider {
  constructor(config = {}) {
    super(config);
    this.baseUrl = config.baseUrl || 'http://vouver.me/api';
    this.timeout = config.timeout || 20000;
  }

  /**
   * 🛡️ Filtro Leão de Chácara: Bloqueia conteúdos pesados ou incompatíveis (HEVC/H.265)
   * Usa uma Regex Case-Insensitive para barrar 4K, HDR e Hybrid.
   * @private
   */
  _blindarCatalogo(items) {
    if (!Array.isArray(items)) return items;
    
    // Regex implacável: Pega 4K, 4k, HDR, hdr, Hybrid, HYBRID. E ignora os colchetes.
    const regexBloqueio = /(4k|hdr|hybrid)/i;
    
    return items.filter(item => {
      const titulo = item.title || item.name || '';
      // Retorna TRUE (mantém na lista) apenas se o regex NÃO encontrar as palavras proibidas
      return !regexBloqueio.test(titulo);
    });
  }

  /**
   * Busca o catálogo completo (filmes + séries)
   */
  async fetchCatalog() {
    return this.requestWithRetry(
      async () => {
        const response = await this.httpGet(`${this.baseUrl}/catalog`);
        
        if (response.status !== 200) {
          throw new Error(`HTTP ${response.status}: Catálogo não disponível`);
        }

        if (!response.data || !Array.isArray(response.data.movies)) {
          throw new Error('Formato de resposta inválido do Vouver');
        }

        // 🚀 Aplica a blindagem no catálogo global ANTES de salvar na memória da VPS
        if (response.data.movies) {
          response.data.movies = this._blindarCatalogo(response.data.movies);
        }
        if (response.data.series) {
          response.data.series = this._blindarCatalogo(response.data.series);
        }

        return response.data;
      },
      'fetchCatalog'
    );
  }

  /**
   * Busca detalhes de um filme ou série específico
   */
  async fetchDetails(contentId, mediaType = 'movie') {
    return this.requestWithRetry(
      async () => {
        const response = await this.httpGet(
          `${this.baseUrl}/${mediaType}/${contentId}`
        );

        if (response.status !== 200) {
          throw new Error(`HTTP ${response.status}: Conteúdo ${contentId} não encontrado`);
        }

        return response.data;
      },
      `fetchDetails(${contentId})`
    );
  }

  /**
   * Estima a duração de um conteúdo
   */
  async estimateDuration(contentId, mediaType = 'movie') {
    try {
      const details = await this.fetchDetails(contentId, mediaType);
      return details.duration || (mediaType === 'series' ? 45 : 110);
    } catch (error) {
      this.logger.warn(`Duração padrão usada para ${contentId}`);
      return mediaType === 'series' ? 45 : 110;
    }
  }

  /**
   * Busca filmes por termo
   */
  async searchMovies(term) {
    return this.requestWithRetry(
      async () => {
        const response = await this.httpGet(
          `${this.baseUrl}/search`,
          { 'q': term, 'type': 'movie' }
        );

        if (response.status !== 200) {
          throw new Error(`HTTP ${response.status}: Busca falhou`);
        }

        // 🚀 Filtra os resultados da busca ativa para o usuário no Telegram
        const resultados = response.data?.results || [];
        return this._blindarCatalogo(resultados);
      },
      `searchMovies(${term})`
    );
  }

  /**
   * Busca séries por termo
   */
  async searchSeries(term) {
    return this.requestWithRetry(
      async () => {
        const response = await this.httpGet(
          `${this.baseUrl}/search`,
          { 'q': term, 'type': 'series' }
        );

        if (response.status !== 200) {
          throw new Error(`HTTP ${response.status}: Busca falhou`);
        }

        // 🚀 Filtra os resultados da busca ativa para o usuário no Telegram
        const resultados = response.data?.results || [];
        return this._blindarCatalogo(resultados);
      },
      `searchSeries(${term})`
    );
  }
}

module.exports = VouverProvider;