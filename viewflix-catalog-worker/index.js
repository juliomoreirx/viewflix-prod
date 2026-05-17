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
    REDIS_URL,
    RES_PROXY_HOST,
    RES_PROXY_PORT = '33335',
    RES_PROXY_USER,
    RES_PROXY_PASS,
    WEBHOOK_URL,
    WEBHOOK_TOKEN,
    // URL exata extraída do trace de rede
    CATALOG_URL = 'http://vouver.me/ajax/search.php?q=a' 
} = process.env;

if (!WEBHOOK_URL || !WEBHOOK_TOKEN) {
    console.error('❌ ERRO FATAL: Variáveis de Webhook ausentes no .env!');
    process.exit(1);
}

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
    console.log(`[${new Date().toISOString()}] 🔄 Iniciando extração do catálogo via GET AJAX...`);

    try {
        let cookiesAtivos = await redis.get('fasttv:cookies:current') || process.env.SESSION_COOKIES;
        
        if (!cookiesAtivos) {
            console.warn('⚠️ Nenhum cookie ativo localizado. Tentando requisição...');
        }

        // CABEÇALHOS IDÊNTICOS AO SEU NAVEGADOR (TRACE DE REDE)
        let axiosConfig = {
            timeout: 90000, 
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:150.0) Gecko/20100101 Firefox/150.0',
                'Accept': 'application/json, text/javascript, */*; q=0.01',
                'Accept-Language': 'pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7',
                'X-Requested-With': 'XMLHttpRequest', // O disfarce do AJAX
                'Connection': 'keep-alive',
                'Referer': 'http://vouver.me/index.php?page=homepage',
                'Cookie': cookiesAtivos || ''
            }
        };

        if (RES_PROXY_HOST && RES_PROXY_USER && RES_PROXY_PASS) {
            const proxyUrl = `http://${RES_PROXY_USER}:${RES_PROXY_PASS}@${RES_PROXY_HOST}:${RES_PROXY_PORT}`;
            axiosConfig.httpAgent = new HttpProxyAgent({ keepAlive: true, proxy: proxyUrl });
            axiosConfig.httpsAgent = new HttpsProxyAgent({ keepAlive: true, proxy: proxyUrl });
            console.log('🛡️ Roteamento via Proxy Bright Data ativado.');
        }

        console.log(`📡 Disparando GET para: ${CATALOG_URL}`);
        
        const response = await axios.get(CATALOG_URL, axiosConfig);
        
        // Valida se a resposta tem a estrutura {"status":true, "data": {...}}
        if (!response.data || !response.data.status || !response.data.data) {
            throw new Error(`Payload inválido. Estrutura encapsulada 'data' ausente.`);
        }

        // O pulo do gato: desempacotar o JSON real que fica dentro de "data"
        const catalogoBruto = response.data.data;
        console.log('✅ Resposta AJAX recebida e desempacotada. Processando filtragem...');

        const catalogoFiltrado = {
            movies: filtrarFilmesESeries(catalogoBruto.movies || catalogoBruto.filmes || []),
            series: filtrarFilmesESeries(catalogoBruto.series || catalogoBruto.animes || []),
            livetv: filtrarCanaisLive(catalogoBruto.livetv || catalogoBruto.channels || [])
        };

        console.log(`📊 Métricas do novo catálogo:\n ├ Filmes: ${catalogoFiltrado.movies.length}\n ├ Séries: ${catalogoFiltrado.series.length}\n └ Canais Ao Vivo: ${catalogoFiltrado.livetv.length}`);

        // A API espera que a string do Redis já venha empacotada da mesma forma que o vouverService faz
        const redisKey = 'fasttv:catalog:global';
        await redis.set(redisKey, JSON.stringify(catalogoFiltrado));
        console.log('📥 [Redis] Novo catálogo filtrado persistido com sucesso (Estrutura nativa API)!');

        // ==========================================
        // 🚀 NOTIFICAÇÃO RESILIENTE (LOCALHOST + FALLBACK PÚBLICO)
        // ==========================================
        const portaApi = process.env.PORT || 3000;
        const localWebhookUrl = `http://127.0.0.1:${portaApi}/api/telegram-webhook`;
        
        console.log(`📡 Tentando notificar API central via rede interna: ${localWebhookUrl}`);
        
        const payloadWebhook = { source: 'catalog_worker', status: 'refreshed' };
        const headersWebhook = {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${WEBHOOK_TOKEN}`
        };

        try {
            const webhookResponse = await axios.post(localWebhookUrl, payloadWebhook, {
                headers: headersWebhook,
                // Define validateStatus para rejeitar e pular pro Catch se der erro interno de conexão (como 502)
                validateStatus: (status) => status < 500 
            });

            if (webhookResponse.status === 200 || webhookResponse.status === 204) {
                console.log('🚀 [Sincronização] API central notificada e atualizada com sucesso via rede interna!');
            } else {
                throw new Error(`API respondeu com status ${webhookResponse.status}`);
            }
        } catch (localError) {
            console.warn(`⚠️ Falha na rede interna (${localError.message}). Acionando Fallback para URL Pública...`);
            
            try {
                const fallbackResponse = await axios.post(WEBHOOK_URL, payloadWebhook, {
                    headers: headersWebhook,
                    validateStatus: () => true
                });
                console.log(`🚀 [Sincronização Fallback] API notificada via URL Pública! Status final: ${fallbackResponse.status}`);
            } catch (fallbackError) {
                console.error(`❌ [Erro Crítico] Impossível notificar a API em todas as rotas: ${fallbackError.message}`);
            }
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