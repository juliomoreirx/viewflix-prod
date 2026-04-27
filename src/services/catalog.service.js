const fs = require('fs');
const path = require('path');

function isAdultoNome(name) {
  return /[\[\(]xxx|\+18|adulto|hentai/i.test(String(name).toUpperCase());
}

async function listCatalog({
  type = 'movies',
  page = 1,
  q,
  cacheConteudo,
  atualizarCache,
  projectRoot
}) {
  const pageNum = parseInt(page, 10) || 1;
  const limit = 20;

  if (
    (!cacheConteudo.series || cacheConteudo.series.length === 0) &&
    (!cacheConteudo.movies || cacheConteudo.movies.length === 0) &&
    (!cacheConteudo.livetv || cacheConteudo.livetv.length === 0)
  ) {
    await atualizarCache(true);
  }

  let lista;
  if (type === 'adult') {
    lista = [...cacheConteudo.movies, ...cacheConteudo.series].filter((i) =>
      isAdultoNome(i.name)
    );
  } else if (type === 'livetv') {
    lista = cacheConteudo.livetv || [];
  } else {
    lista = (cacheConteudo[type] || []).filter((i) => !isAdultoNome(i.name));
  }

  if (q) {
    const qLower = String(q).toLowerCase();
    lista = lista.filter((i) => i.name.toLowerCase().includes(qLower));
  }

  const total = lista.length;
  const items = lista.slice((pageNum - 1) * limit, pageNum * limit);

  const data = items.map((item) => {
    const folder =
      type === 'adult'
        ? (cacheConteudo.movies.find((m) => m.id === item.id) ? 'movies' : 'series')
        : type;

    const coverPath = path.join(projectRoot, 'public', 'covers', folder, `${item.id}.jpg`);
    const img = fs.existsSync(coverPath)
      ? `/covers/${folder}/${item.id}.jpg`
      : `https://via.placeholder.com/300x450?text=${encodeURIComponent(item.name)}`;

    return {
      id: item.id,
      title: item.name,
      img,
      type: folder
    };
  });

  return {
    data,
    currentPage: pageNum,
    totalPages: Math.ceil(total / limit),
    totalItems: total
  };
}

module.exports = { listCatalog };