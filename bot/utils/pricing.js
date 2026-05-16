const config = require('../config');

function normalizarDuracaoMin(mediaType, duracaoMinutos) {
  const d = parseInt(String(duracaoMinutos || 0), 10);
  if (Number.isFinite(d) && d > 0) return d;
  return mediaType === 'movie' ? 110 : 24; 
}

function calcularPrecoFinal({ mediaType = 'movie', duracaoMinutos = 0 }) {
  const tipo = mediaType === 'series' ? 'series' : 'movie';
  const minutos = normalizarDuracaoMin(tipo, duracaoMinutos);

  const precoExato = (config.PRECO_POR_HORA * minutos) / 60;
  const precoBase = Math.round(precoExato);

  const minimoAplicado = tipo === 'series' ? config.PRECO_MINIMO_SERIE : config.PRECO_MINIMO;
  const precoFinal = Math.max(precoBase, minimoAplicado);

  return {
    mediaType: tipo,
    duracaoMinutos: minutos,
    precoPorHora: config.PRECO_POR_HORA,
    precoBase,
    precoMinimoAplicado: minimoAplicado,
    precoFinal
  };
}

function calcularPreco(minutos) {
  return calcularPrecoFinal({ mediaType: 'movie', duracaoMinutos: minutos }).precoFinal;
}

module.exports = {
  normalizarDuracaoMin,
  calcularPrecoFinal,
  calcularPreco
};