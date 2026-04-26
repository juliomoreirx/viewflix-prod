// src/services/providers/index.js
// Centraliza os providers

const VouverProvider = require('./vouver.provider');
const GoPlayProvider = require('./goplay.provider');

const providers = {
  vouver: null,
  goplay: null
};

/**
 * Inicializa todos os providers
 */
function initializeProviders(config = {}) {
  providers.vouver = new VouverProvider({
    baseUrl: config.VOUVER_BASE_URL || 'http://vouver.me/api',
    maxRetries: 3,
    retryDelay: 1000,
    logger: config.logger || console
  });

  providers.goplay = new GoPlayProvider({
    baseUrl: config.GOPLAY_BASE_URL || 'http://goplay.icu/api',
    maxRetries: 3,
    retryDelay: 1500,
    logger: config.logger || console
  });

  console.log('✅ [Providers] Vouver e GoPlay inicializados com retry automático');

  return providers;
}

/**
 * Obtém um provider específico
 */
function getProvider(name) {
  return providers[name] || null;
}

module.exports = {
  initializeProviders,
  getProvider,
  providers
};
