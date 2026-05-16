const { removerAcentos } = require('../../src/services/text-utils.service');

function formatMoney(centavos) {
  return `R$ ${(centavos / 100).toFixed(2).replace('.', ',')}`;
}

function formatTimeRemaining(expiresAt) {
  const now = new Date();
  const diff = expiresAt - now;
  if (diff <= 0) return '❌ EXPIRADO';
  const days = Math.floor(diff / (1000 * 60 * 60 * 24));
  const hours = Math.floor((diff % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));
  const minutes = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60));
  
  if (days > 0) return `⏰ ${days}d ${hours}h restantes`;
  if (hours > 0) return `⏰ ${hours}h ${minutes}m restantes`;
  return `⏰ ${minutes}m restantes`;
}

function normalizeTitle(value) {
  return removerAcentos(String(value || '')).toLowerCase().trim();
}

function paginateList(items, page = 1, perPage = 10) {
  const total = items.length;
  const totalPages = Math.max(1, Math.ceil(total / perPage));
  const current = Math.min(Math.max(1, page), totalPages);
  const start = (current - 1) * perPage;
  const end = start + perPage;
  return {
    items: items.slice(start, end),
    total,
    totalPages,
    current
  };
}

function buildPaginationRow(prefix, current, totalPages) {
  const row = [];
  if (current > 1) row.push({ text: '◀️ Anterior', callback_data: `${prefix}_${current - 1}` });
  if (totalPages > 1) row.push({ text: `📄 ${current}/${totalPages}`, callback_data: 'noop' });
  if (current < totalPages) row.push({ text: 'Próximo ▶️', callback_data: `${prefix}_${current + 1}` });
  return row;
}

module.exports = {
  formatMoney,
  formatTimeRemaining,
  normalizeTitle,
  paginateList,
  buildPaginationRow
};