// bot/state.js
const bunnyCacheService = require('../src/services/bunny-cache.service');

// Tempo de vida do estado na memória do Redis: 1 Hora (3600 segundos)
// Após esse tempo de inatividade, o Redis destrói a sessão sozinho para não acumular lixo
const STATE_TTL = 3600; 

class StateManager {
  /**
   * Lê o estado atual do usuário no Redis
   */
  async getUserState(chatId) {
    try {
      const data = await bunnyCacheService.redisConnection.get(`state:user:${chatId}`);
      return data ? JSON.parse(data) : null;
    } catch (error) {
      console.error(`❌ [State Manager] Erro ao ler estado do Redis para o chat [${chatId}]:`, error.message);
      return null;
    }
  }

  /**
   * Salva ou atualiza o estado do usuário no Redis fazendo um merge com os dados anteriores
   */
  async setUserState(chatId, newState) {
    try {
      const currentState = (await this.getUserState(chatId)) || {};
      
      // Mescla o estado antigo com o novo (Preserva variáveis que não foram sobrescritas)
      const mergedState = { ...currentState, ...newState };
      
      // Salva no Redis com expiração (setex = Set with Expiration)
      await bunnyCacheService.redisConnection.setex(
        `state:user:${chatId}`,
        STATE_TTL,
        JSON.stringify(mergedState)
      );
    } catch (error) {
      console.error(`❌ [State Manager] Erro ao salvar estado no Redis para o chat [${chatId}]:`, error.message);
    }
  }

  /**
   * Limpa o estado do usuário (Geralmente usado quando ele volta pro Menu Principal)
   */
  async clearUserState(chatId) {
    try {
      await bunnyCacheService.redisConnection.del(`state:user:${chatId}`);
    } catch (error) {
      console.error(`❌ [State Manager] Erro ao deletar estado no Redis para o chat [${chatId}]:`, error.message);
    }
  }
}

module.exports = new StateManager();