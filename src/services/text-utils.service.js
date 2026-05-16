// src/services/text-utils.service.js
// ✅ VERSÃO 5 - Regex corrigida + mojibake 100% limpo

function fixMojibake(texto) {
  if (!texto || typeof texto !== 'string') return texto;
  
  let t = texto;

  // 1. Fix clássico UTF-8 lido como Latin1
  if (/[ÃÂÀÁÄÅÇÈÉÊËÌÍÎÏÑÒÓÔÕÖÙÚÛÜÝ♦�]/g.test(t)) {
    try {
      const buffer = Buffer.from(t, 'latin1');
      const fixed = buffer.toString('utf8');
      if (fixed !== t && !/[ÃÂÀÁÄÅÇÈÉÊËÌÍÎÏÑÒÓÔÕÖÙÚÛÜÝ♦�]/g.test(fixed)) {
        t = fixed;
      }
    } catch (e) {}
  }

  // 2. Correções específicas do vouver.me
  t = t
    .replace(/♦/g, 'à')
    .replace(/♦mega/g, 'Ômega')
    .replace(/�/g, '')
    .replace(/\\([a-zA-Z])/g, '$1')
    .replace(/\\\./g, '.')
    .replace(/\\+/g, '');

  return t;
}

function decodificarHTML(texto) {
  if (!texto) return '';
  
  let t = fixMojibake(String(texto));

  // Entidades HTML
  t = t
    .replace(/&#(\d+);/g, (_, num) => String.fromCharCode(parseInt(num)))
    .replace(/&#x([0-9a-fA-F]+);/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/&aacute;/gi, 'á').replace(/&Aacute;/g, 'Á')
    .replace(/&atilde;/gi, 'ã').replace(/&Atilde;/g, 'Ã')
    .replace(/&acirc;/gi, 'â').replace(/&Acirc;/g, 'Â')
    .replace(/&agrave;/gi, 'à').replace(/&Agrave;/g, 'À')
    .replace(/&eacute;/gi, 'é').replace(/&Eacute;/g, 'É')
    .replace(/&ecirc;/gi, 'ê').replace(/&Ecirc;/g, 'Ê')
    .replace(/&iacute;/gi, 'í').replace(/&Iacute;/g, 'Í')
    .replace(/&oacute;/gi, 'ó').replace(/&Oacute;/g, 'Ó')
    .replace(/&otilde;/gi, 'õ').replace(/&Otilde;/g, 'Õ')
    .replace(/&ocirc;/gi, 'ô').replace(/&Ocirc;/g, 'Ô')
    .replace(/&uacute;/gi, 'ú').replace(/&Uacute;/g, 'Ú')
    .replace(/&ccedil;/gi, 'ç').replace(/&Ccedil;/g, 'Ç')
    .replace(/&ntilde;/gi, 'ñ').replace(/&Ntilde;/g, 'Ñ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");

  return t;
}

function limparTexto(texto) {
  if (!texto) return '';
  return decodificarHTML(texto.trim().replace(/\s+/g, ' '));
}

function escaparMarkdownSeguro(texto) {
  if (!texto) return '';
  let t = decodificarHTML(texto);
  
  // 🔥 Regex CORRIGIDA (hífen no final da classe)
  return t
    .replace(/[\u{1D400}-\u{1D7FF}]/gu, '')
    .replace(/[\u{1F100}-\u{1F1FF}]/gu, '')
    .replace(/([_*`[\]()~>#+=|{}!.-])/g, '\\$1')   // <- aqui está o fix
    .trim();
}

function sanitizarTexto(texto) {
  if (!texto) return '';
  let t = decodificarHTML(texto);
  return t
    .replace(/[\u{1D400}-\u{1D7FF}]/gu, '')
    .replace(/[\u{1F100}-\u{1F1FF}]/gu, '')
    .replace(/[*_`[\]()~>#+=|{}!.]/g, '')
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
  removerAcentos,
  fixMojibake
};