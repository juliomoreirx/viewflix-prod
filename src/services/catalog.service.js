// src/services/catalog.service.js
const fs = require('fs');
const path = require('path');

// Movemos a regex para fora para não ser compilada a cada iteração
const ADULT_REGEX = /[\[\(]xxx|\+18|adulto|hentai|brasileirinhas/i;

function isAdultoNome(name) {
  return ADULT_REGEX.test(String(name || '').toUpperCase());
}

async function listCatalog({
  type = 'movies',
  page = 1,
  q,
  cacheConteudo,
  atualizarCache,
  projectRoot
}) {
  const pageNum = Math.max(1, parseInt(page, 10) || 1);
  const limit = 20;

  // Se as caches estiverem vazias, forçamos a atualização
  if (
    (!cacheConteudo.series?.length) &&
    (!cacheConteudo.movies?.length) &&
    (!cacheConteudo.livetv?.length)
  ) {
    await atualizarCache(true);
  }

  // Filtragem inicial
  let lista = [];
  if (type === 'adult') {
    lista = [...(cacheConteudo.movies || []), ...(cacheConteudo.series || [])]
      .filter((i) => isAdultoNome(i.name));
  } else if (type === 'livetv') {
    lista = cacheConteudo.livetv || [];
  } else {
    lista = (cacheConteudo[type] || []).filter((i) => !isAdultoNome(i.name));
  }

  // Busca por texto
  if (q && q.trim()) {
    const qLower = String(q).toLowerCase().trim();
    lista = lista.filter((i) => String(i.name || '').toLowerCase().includes(qLower));
  }

  const total = lista.length;
  const items = lista.slice((pageNum - 1) * limit, pageNum * limit);

  // Mapeamento com otimização
  const data = items.map((item) => {
    let folder = type;
    if (type === 'adult') {
      folder = (cacheConteudo.movies || []).some((m) => m.id === item.id) ? 'movies' : 'series';
    }

    // Em vez de bloquear a thread a verificar o disco para cada imagem, 
    // assumimos a rota pública. O Nginx ou o Express devem lidar com o 404 da imagem e fazer fallback.
    // Mas para manter a tua lógica, fazemos a verificação de forma mais segura:
    const coverPath = path.join(projectRoot, 'public', 'covers', folder, `${item.id}.jpg`);
    let img = `https://via.placeholder.com/300x450?text=${encodeURIComponent(item.name)}`;
    
    try {
      if (fs.existsSync(coverPath)) {
        img = `/covers/${folder}/${item.id}.jpg`;
      }
    } catch (e) {
      // Ignora erro de disco
    }

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