// bot/config.js
const env = require('../src/config/env');

module.exports = {
  // Credenciais
  BOT_TOKEN: env.BOT_TOKEN,
  JWT_SECRET: env.JWT_SECRET,
  MP_ACCESS_TOKEN: env.MP_ACCESS_TOKEN,

  // Configurações de Preço (Já são números reais, validados pelo Zod)
  PRECO_POR_HORA: env.PRECO_POR_HORA,
  PRECO_MINIMO: env.PRECO_MINIMO,
  PRECO_MINIMO_SERIE: env.PRECO_MINIMO_SERIE,
  // 🚀 ATUALIZADO: Preço fixado para R$ 5,00 por canal por 24 horas
  PRECO_LIVETV_FIXO: 5,
  BONUS_INICIAL_NOVO_USUARIO: parseInt(process.env.BONUS_INICIAL_NOVO_USUARIO || '500', 10), // Se quiser, adicione no Zod também!

  // Admins (Já é um array de números [123, 456])
  ADMIN_IDS: env.ADMIN_IDS,

  // Variáveis mutáveis em tempo de execução (Injetadas pelo index principal)
  dynamic: {
    DOMINIO_PUBLICO: env.DOMINIO_PUBLICO || ''
  }
};