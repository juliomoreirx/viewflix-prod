// bot/index.js
const express = require('express'); // 🚀 Garantia de isolamento de rotas
const bot = require('./instance');
const config = require('./config');
const state = require('./state');

// Importação dos Módulos do Sistema de Banco de Dados e Negócio
const db = require('./services/db.service');
const userService = require('./services/user.service');
const contentService = require('./services/content.service');
const paymentService = require('./services/payment.service');

// Importação dos Roteadores de Eventos (Handlers)
const registerCommands = require('./handlers/commands');
const registerTextHandlers = require('./handlers/text');
const registerCallbackHandlers = require('./handlers/callbacks');
const registerErrorHandlers = require('./handlers/errors');

// Importação do Orquestrador de Tarefas (Jobs)
const startJobs = require('./jobs/cleanup');

// Utilitários de Formatação para uso interno
const { formatMoney } = require('./utils/formatters');
const { sanitizarTexto } = require('../src/services/text-utils.service');

/**
 * Inicializador global do Bot do Telegram (Suporta Webhook Compartilhado e PM2 Cluster)
 * @param {Object} models - Modelos do Mongoose do ecossistema principal
 * @param {Object} services - Serviços de cache e provedores injetados
 * @param {string} dominio - Domínio público HTTPS configurado na VPS
 * @param {Object} app - Instância do servidor Express principal da aplicação
 */
function initBot(models, services, dominio, app) {
  // 1. Injetar os modelos do Mongoose no Barramento de Dados Isolado
  db.setModels(models);

  // 2. Injetar serviços de Cache e Provedores de Conteúdo Externo
  contentService.setExternalServices(services);

  // 3. Configurar dinamicamente o domínio público do Player
  config.dynamic.DOMINIO_PUBLICO = dominio || '';

  // 4. Ligar a escuta dos Handlers especialistas
  registerCommands();
  registerTextHandlers();
  registerCallbackHandlers();
  registerErrorHandlers();

  // 5. Ativar as rotinas assíncronas de manutenção (Cleanup / Notificações)
  startJobs();

  // 6. 🚀 EVOLUÇÃO WEBHOOK: Configuração de Rota Distribuída e Amigável a Clusters do PM2
  if (app) {
    // Injeta o express.json() diretamente na rota para evitar conflitos com parsers customizados do app principal
    app.post('/api/telegram-webhook', express.json(), (req, res) => {
      bot.processUpdate(req.body);
      res.sendStatus(200);
    });

    // Prática Sênior: Apenas a instância '0' do PM2 faz a chamada à API do Telegram para registrar o endereço
    const isPrimaryInstance = !process.env.NODE_APP_INSTANCE || process.env.NODE_APP_INSTANCE === '0';
    
    if (isPrimaryInstance && dominio) {
      // Saneia a URL removendo possíveis barras duplicadas no final do domínio
      const webhookUrl = `${dominio.replace(/\/$/, '')}/api/telegram-webhook`;
      
      bot.setWebHook(webhookUrl)
        .then(() => {
          console.log(`🚀 [Telegram Webhook] Sincronizado com sucesso! Escutando em: ${webhookUrl}`);
        })
        .catch((err) => {
          console.error('❌ [Telegram Webhook] Erro crítico ao registrar webhook no Telegram:', err.message);
        });
    }
    console.log('🚀 [FastTV Bot] Inicializado com sucesso em modo WEBHOOK distribuído (Pronto para PM2 -i max).');
  } else {
    // Fallback de segurança para desenvolvimento local se o app não for injetado
    bot.startPolling();
    console.log('⚠️ [FastTV Bot] Inicializado em modo LONGBOLLING de Fallback (Não utilize em modo Cluster do PM2).');
  }
}

/**
 * Função Portada: Envia campanhas de marketing massivo com ou sem atribuição de bônus financeiro
 */
async function dispararCampanhaTelegram({ message, bonusAmount = 0, bonusLimit = 0, adminLabel = 'Admin' }) {
  const UserModel = db.getUserModel();
  if (!UserModel || typeof UserModel.find !== 'function') {
    throw new Error('Modelo de usuário indisponível no banco do bot.');
  }

  const texto = String(message || '').trim();
  if (!texto) {
    throw new Error('Mensagem da campanha é obrigatória');
  }

  const bonusCentavos = Math.max(0, parseInt(String(bonusAmount || 0), 10) || 0);
  const bonusMax = Math.max(0, parseInt(String(bonusLimit || 0), 10) || 0);

  const usuarios = await UserModel.find({
    registeredAt: { $exists: true },
    isBlocked: { $ne: true }
  })
    .sort({ registeredAt: 1, userId: 1 })
    .select('userId firstName username registeredAt isActive isBlocked')
    .lean();

  let sentCount = 0;
  let failedCount = 0;
  let bonusGrantedCount = 0;
  const bonusWinners = [];

  for (const user of usuarios) {
    try {
      await bot.sendMessage(user.userId, texto, {
        parse_mode: 'Markdown',
        disable_web_page_preview: false
      });
      sentCount += 1;

      // Se houver bônus financeiro atrelado à campanha e limite disponível
      if (bonusCentavos > 0 && bonusGrantedCount < bonusMax) {
        await paymentService.addCredits(user.userId, bonusCentavos);
        bonusGrantedCount += 1;
        bonusWinners.push({
          userId: user.userId,
          username: user.username || null,
          firstName: user.firstName || null
        });

        await bot.sendMessage(
          user.userId,
          `🎁 *Você ganhou um bônus de ${formatMoney(bonusCentavos)}!*\n\nObrigado por testar a plataforma.`,
          { parse_mode: 'Markdown' }
        ).catch(() => {});
      }
    } catch (error) {
      failedCount += 1;
    }
  }

  return {
    adminLabel,
    totalRecipients: usuarios.length,
    sentCount,
    failedCount,
    bonusGrantedCount,
    bonusAmount: bonusCentavos,
    bonusWinners
  };
}

/**
 * Função Portada: Dispara alertas directos em formato push quando ocorrem falhas críticas de processamento na Bunny CDN
 */
async function notificarFalhaCacheAoUsuario(userId, purchase) {
  if (!bot || typeof bot.sendMessage !== 'function') return;
  
  try {
    const titulo = sanitizarTexto(purchase.title || 'Conteúdo');
    const erro = sanitizarTexto(purchase.cacheError || 'Erro desconhecido');
    
    const texto = `
⚠️ *Problema ao baixar conteúdo*

Título: ${titulo}
Erro: ${erro}

O arquivo ficou incompleto (${purchase.cacheProgress || 0}%). 

*O que fazer:*
Você não foi cobrado novamente. Clique no botão abaixo para retentar o download:

/requeue_${purchase._id}

Precisar de ajuda? Entre em contato com o suporte.
    `.trim();
    
    await bot.sendMessage(userId, texto, { parse_mode: 'Markdown' }).catch((err) => {
      console.error('❌ Erro ao notificar usuário sobre falha de cache:', err.message);
    });
  } catch (error) {
    console.error('❌ Erro crítico em notificarFalhaCacheAoUsuario:', error.message);
  }
}

// Interface Pública idêntica às assinaturas originais exigidas pelo ecossistema do App
module.exports = {
  bot,
  initBot,
  setModels: db.setModels,
  processarPagamentoAprovado: paymentService.processarPagamentoAprovado,
  getUserCredits: paymentService.getUserCredits,
  addCredits: paymentService.addCredits,
  dispararCampanhaTelegram,
  notificarFalhaCacheAoUsuario
};