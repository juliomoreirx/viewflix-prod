const env = require('../config/env');

const PRECO_POR_HORA = Number(env.PRECO_POR_HORA || 5); // ex: 5.00
const PRECO_MINIMO = Number(env.PRECO_MINIMO || 2); // mínimo padrão
const PRECO_MINIMO_SERIE = Number(env.PRECO_MINIMO_SERIE || 1); // opcional (p/ episódio curto)

function normalizarDuracaoMin(mediaType, duracaoMin) {
  const d = Number(duracaoMin || 0);
  if (d > 0) return d;

  // fallback só quando não tem duração real
  return mediaType === 'movie' ? 110 : 24;
}

function arred2(v) {
  return Math.round(v * 100) / 100;
}

/**
 * Calcula preço final.
 * @param {Object} p
 * @param {'movie'|'series'} p.mediaType
 * @param {number} p.duracaoMinutos
 */
function calcularPrecoFinal({ mediaType = 'movie', duracaoMinutos = 0 }) {
  const tipo = mediaType === 'series' ? 'series' : 'movie';
  const minutos = normalizarDuracaoMin(tipo, duracaoMinutos);

  const precoBase = (minutos / 60) * PRECO_POR_HORA;
  const minimoAplicado = tipo === 'series' ? PRECO_MINIMO_SERIE : PRECO_MINIMO;

  const precoFinal = Math.max(precoBase, minimoAplicado);

  return {
    mediaType: tipo,
    duracaoMinutos: minutos,
    precoPorHora: PRECO_POR_HORA,
    precoBase: arred2(precoBase),
    precoMinimoAplicado: minimoAplicado,
    precoFinal: arred2(precoFinal)
  };
}

module.exports = {
  calcularPrecoFinal
};