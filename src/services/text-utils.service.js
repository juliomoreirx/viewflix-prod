// src/services/text-utils.service.js

function decodificarHTML(texto) {
  if (!texto) return '';
  
  // 1. Decodifica numéricos (ex: &#231; -> ç)
  let t = String(texto)
    .replace(/&#(\d+);/g, (m, d) => String.fromCharCode(d))
    .replace(/&#x([a-fA-F0-9]+);/gi, (m, h) => String.fromCharCode(parseInt(h, 16)));
  
  // 2. Decodifica nomeados (ex: &aacute; -> á)
  const entities = {
    '&aacute;': 'á', '&Aacute;': 'Á', '&atilde;': 'ã', '&Atilde;': 'Ã',
    '&acirc;': 'â', '&Acirc;': 'Â', '&agrave;': 'à', '&Agrave;': 'À',
    '&eacute;': 'é', '&Eacute;': 'É', '&ecirc;': 'ê', '&Ecirc;': 'Ê',
    '&iacute;': 'í', '&Iacute;': 'Í',
    '&oacute;': 'ó', '&Oacute;': 'Ó', '&otilde;': 'õ', '&Otilde;': 'Õ',
    '&ocirc;': 'ô', '&Ocirc;': 'Ô',
    '&uacute;': 'ú', '&Uacute;': 'Ú',
    '&ccedil;': 'ç', '&Ccedil;': 'Ç', '&ntilde;': 'ñ', '&Ntilde;': 'Ñ',
    '&nbsp;': ' ', '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'"
  };
  
  t = t.replace(/&[a-zA-Z]+;/g, m => entities[m] || m);
  return t;
}

function limparTexto(texto) {
  if (!texto) return '';
  // Remove espaços extras e decodifica o HTML
  let t = texto.trim().replace(/\s+/g, ' ');
  return decodificarHTML(t);
}

function escaparMarkdownSeguro(texto) {
  if (!texto) return '';
  let t = decodificarHTML(texto);
  return t
    .replace(/[\u{1D400}-\u{1D7FF}]/gu, '')
    .replace(/[\u{1F100}-\u{1F1FF}]/gu, '')
    .replace(/([_*`\[\]()~>#+=|{}.!-])/g, '\\$1') // Escapa caracteres sensíveis do Telegram
    .trim();
}

function sanitizarTexto(texto) {
  if (!texto) return '';
  let t = decodificarHTML(texto); // Limpa o HTML antes
  return t
    .replace(/[\u{1D400}-\u{1D7FF}]/gu, '')
    .replace(/[\u{1F100}-\u{1F1FF}]/gu, '')
    .replace(/[*_`\[\]()~>#+=|{}.!]/g, '')
    .trim();
}

function removerAcentos(texto) {
  if (!texto) return '';
  let t = decodificarHTML(texto);
  return t.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
}

module.exports = {
  decodificarHTML,
  limparTexto,
  escaparMarkdownSeguro,
  sanitizarTexto,
  removerAcentos
};