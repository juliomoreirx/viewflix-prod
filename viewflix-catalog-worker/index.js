// /root/viewflix/viewflix-prod/viewflix-catalog-worker/index.js
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../.env') });
const Redis = require('ioredis');
const axios = require('axios');
const { HttpProxyAgent, HttpsProxyAgent } = require('hpagent');
const cron = require('node-cron');

// ==========================================
// 1. CONFIGURAÇÕES E AMBIENTE
// ==========================================
const {
    REDIS_URL, // 🚀 Padrão absoluto centralizado
    RES_PROXY_HOST,
    RES_PROXY_PORT = '33335',
    RES_PROXY_USER,
    RES_PROXY_PASS,
    WEBHOOK_URL,
    WEBHOOK_TOKEN,
    CATALOG_URL = 'http://vouver.me/api/content.json' 
} = process.env;

if (!WEBHOOK_URL || !WEBHOOK_TOKEN) {
    console.error('❌ ERRO FATAL: Variáveis de Webhook ausentes no .env!');
    process.exit(1);
}

// Inicializa o Redis passando a string de conexão completa diretamente
const redis = REDIS_URL ? new Redis(REDIS_URL) : new Redis();
console.log('🔌 [Redis] Inicializado com sucesso via string de conexão.');

const REGEX_BLOQUEIO_4K = /(4k|hdr|hybrid)/i;

// ==========================================
// 2. FILTROS DE LIMPEZA E BLINDAGEM
// ==========================================
function filtrarFilmesESeries(items) {
    if (!Array.isArray(items)) return [];
    return items.filter(item => {
        const titulo = item.title || item.name || item.titulo || '';
        return !REGEX_BLOQUEIO_4K.test(titulo);
    });
}

function filtrarCanaisLive(items) {
    if (!Array.isArray(items)) return [];
    const regexInicio24h = /^\[24h\]/i;
    const regexContemIncompativel = /(h265|hdr)/i;
    return items.filter(item => {
        const titulo = item.title || item.name || item.titulo || '';
        return !regexInicio24h.test(titulo) && !regexContemIncompativel.test(titulo);
    });
}

// ==========================================
// 3. CORE: DOWNLOAD E ATUALIZAÇÃO DO CATÁLOGO
// ==========================================
async function atualizarCatalogoFila() {
    console.log(`[${new Date().toISOString()}] 🔄 Iniciando ciclo de atualização do catálogo...`);

    try {
        // Buscar cookies frescos gerados pelo robô Puppeteer
        let cookiesAtivos = await redis.get('fasttv:cookies:current') || process.env.SESSION_COOKIES;
        
        if (!cookiesAtivos) {
            console.warn('⚠️ Nenhum cookie ativo localizado no Redis ou .env. Tentando requisição limpa...');
        }

        let axiosConfig = {
            timeout: 90000, 
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
                'Accept': 'application/json, text/plain, */*',
                'Cookie': cookiesAtivos || ''
            }
        };

        if (RES_PROXY_HOST && RES_PROXY_USER && RES_PROXY_PASS) {
            const proxyUrl = `http://${RES_PROXY_USER}:${RES_PROXY_PASS}@${RES_PROXY_HOST}:${RES_PROXY_PORT}`;
            axiosConfig.httpAgent = new HttpProxyAgent({ keepAlive: true, proxy: proxyUrl });
            axiosConfig.httpsAgent = new HttpsProxyAgent({ keepAlive: true, proxy: proxyUrl });
            console.log('🛡️ Roteamento via Proxy Bright Data ativado.');
        }

        console.log(`📡 Efetuando download do catálogo de: ${CATALOG_URL}`);
        const response = await axios.get(CATALOG_URL, axiosConfig);
        
        if (!response.data || (typeof response.data !== 'object')) {
            throw new Error('O servidor respondeu com um payload inválido ou vazio.');
        }

        const catalogoBruto = response.data;
        console.log('✅ Download concluído. Processando filtragem de segurança...');

        const catalogoFiltrado = {
            movies: filtrarFilmesESeries(catalogoBruto.movies || catalogoBruto.filmes || []),
            series: filtrarFilmesESeries(catalogoBruto.series || catalogoBruto.animes || []),
            livetv: filtrarCanaisLive(catalogoBruto.livetv || catalogoBruto.channels || [])
        };

        console.log(`📊 Métricas do novo catálogo:\n ├ Filmes: ${catalogoFiltrado.movies.length}\n ├ Séries: ${catalogoFiltrado.series.length}\n └ Canais Ao Vivo: ${catalogoFiltrado.livetv.length}`);

        const redisKey = 'fasttv:catalog:global';
        await redis.set(redisKey, JSON.stringify(catalogoFiltrado));
        console.log('📥 [Redis] Novo catálogo filtrado persistido com sucesso!');

        console.log('📡 Notificando API central via Webhook...');
        const webhookResponse = await axios.post(WEBHOOK_URL, {
            source: 'catalog_worker',
            status: 'refreshed'
        }, {
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${WEBHOOK_TOKEN}`
            },
            validateStatus: () => true
        });

        if (webhookResponse.status === 200 || webhookResponse.status === 204) {
            console.log('🚀 [Sincronização] API central notificada e atualizada com sucesso!');
        } else {
            console.warn(`⚠️ API central respondeu com status: ${webhookResponse.status}.`);
        }

    } catch (error) {
        console.error('❌ [Erro Crítico no Worker]:', error.message);
    }
}

// ==========================================
// 4. CICLO DE VIDA E AGENDAMENTO
// ==========================================
atualizarCatalogoFila();

cron.schedule('0 * * * *', () => {
    console.log('⏰ [Cron] Disparando rotina automática de atualização de catálogo...');
    atualizarCatalogoFila();
});

console.log('🕰️ Microserviço de catálogo agendado com sucesso. Aguardando ciclos...');