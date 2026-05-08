const axios = require('axios');

const BASE_URL = 'http://localhost:3000';
const TOKEN = '3276427420213442'; // ADMIN_API_TOKEN do .env

async function test() {
  try {
    // 1. Criar batch
    console.log('📦 Criando batch...');
    const batchRes = await axios.post(`${BASE_URL}/api/admin/batch/create`, {
      name: 'Teste Path Bunny',
      description: 'Teste para verificar caminho do arquivo no Bunny',
      items: [],
      concurrency: 1
    }, {
      headers: { Authorization: `Bearer ${TOKEN}` }
    });

    const batchId = batchRes.data.data._id;
    console.log(`✅ Batch criado: ${batchId}`);
    console.log(`   bunnyFolder: ${batchRes.data.data.bunnyFolder}`);

    // 2. Buscar conteúdo para adicionar
    console.log('\n🔍 Buscando conteúdo...');
    const searchRes = await axios.get(`${BASE_URL}/api/admin/content/search?q=matrix&type=movie&limit=1`, {
      headers: { Authorization: `Bearer ${TOKEN}` }
    });

    if (!searchRes.data.data || searchRes.data.data.length === 0) {
      console.log('❌ Nenhum conteúdo encontrado');
      return;
    }

    const content = searchRes.data.data[0];
    console.log(`✅ Conteúdo encontrado: ${content.title} (ID: ${content.id})`);

    // 3. Adicionar item ao batch
    console.log('\n➕ Adicionando item ao batch...');
    const addRes = await axios.post(
      `${BASE_URL}/api/admin/batch/${batchId}/items`,
      {
        items: [
          {
            videoId: content.id,
            title: content.title,
            mediaType: 'movie'
          }
        ]
      },
      {
        headers: { Authorization: `Bearer ${TOKEN}` }
      }
    );

    console.log(`✅ Item adicionado ao batch`);
    console.log(`   Itens: ${addRes.data.data.items.length}`);
    console.log(`   Item 0: title=${addRes.data.data.items[0].title}, videoId=${addRes.data.data.items[0].videoId}`);

    // 4. Iniciar processamento
    console.log('\n▶️  Iniciando processamento...');
    const startRes = await axios.post(
      `${BASE_URL}/api/admin/batch/${batchId}/start`,
      {},
      {
        headers: { Authorization: `Bearer ${TOKEN}` }
      }
    );

    console.log(`✅ Processamento iniciado`);
    console.log(`   Status: ${startRes.data.data.status}`);

    // 5. Monitorar progresso
    console.log('\n⏳ Aguardando conclusão...');
    let completed = false;
    let attempts = 0;
    const maxAttempts = 120; // 2 minutos com poll de 1s

    while (!completed && attempts < maxAttempts) {
      await new Promise(r => setTimeout(r, 1000));
      attempts++;

      const statusRes = await axios.get(`${BASE_URL}/api/admin/batch/${batchId}`, {
        headers: { Authorization: `Bearer ${TOKEN}` }
      });

      const batch = statusRes.data.data;
      const item = batch.items[0];

      process.stdout.write(`\r   [${attempts}s] Status: ${batch.status} | Item: stage=${item.stage}, progress=${item.progress}%, status=${item.status}`);

      if (batch.status === 'completed' || (batch.completedItems > 0 && batch.failedItems === 0)) {
        completed = true;
        console.log('\n');
      } else if (batch.status === 'failed' || batch.failedItems > 0) {
        console.log('\n❌ Batch falhou!');
        console.log(`   Erro do item: ${item.error}`);
        console.log(`   Status: ${item.status}`);
        process.exit(1);
      }
    }

    // 6. Exibir resultado final
    const finalRes = await axios.get(`${BASE_URL}/api/admin/batch/${batchId}`, {
      headers: { Authorization: `Bearer ${TOKEN}` }
    });

    const finalBatch = finalRes.data.data;
    const finalItem = finalBatch.items[0];

    console.log('\n✅ Processamento concluído!');
    console.log(`   Status: ${finalBatch.status}`);
    console.log(`   Item status: ${finalItem.status}`);
    console.log(`   Item stage: ${finalItem.stage}`);
    console.log(`   Item progress: ${finalItem.progress}%`);
    console.log(`   Storage Path: ${finalItem.storagePath}`);

    if (finalItem.storagePath) {
      const pathParts = finalItem.storagePath.split('/');
      console.log(`\n📁 Estrutura do caminho:`);
      console.log(`   Raiz: ${pathParts[0]}`);
      console.log(`   Tipo: ${pathParts[1] || 'N/A'}`);
      console.log(`   Arquivo: ${pathParts[pathParts.length - 1]}`);

      // Verificar se caminho está correto
      if (pathParts[0] === 'movies' || pathParts[0] === 'series') {
        console.log(`\n✅ ✅ ✅ CAMINHO CORRETO! Arquivo em ${pathParts[0]}/`);
      } else {
        console.log(`\n❌ ❌ ❌ CAMINHO INCORRETO! Esperado movies/ ou series/, recebido ${pathParts[0]}/`);
      }
    }

  } catch (error) {
    console.error('❌ Erro:', error.response?.data || error.message);
    process.exit(1);
  }
}

test();
