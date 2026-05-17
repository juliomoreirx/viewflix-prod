require('dotenv').config();
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const proxyChain = require('proxy-chain');
const cron = require('node-cron');

puppeteer.use(StealthPlugin());

// ==========================================
// 1. VALIDAÇÃO DE AMBIENTE (Failsafe)
// ==========================================
const {
    PROXY_HOST,
    PROXY_PORT = '33335',
    PROXY_USER,
    PROXY_PASS,
    LOGIN_USER,
    LOGIN_PASS,
    TARGET_URL = 'http://vouver.me/index.php?page=login',
    WEBHOOK_URL,
    WEBHOOK_TOKEN
} = process.env;

if (!LOGIN_USER || !LOGIN_PASS || !WEBHOOK_URL || !WEBHOOK_TOKEN) {
    console.error('❌ ERRO FATAL: Variáveis de ambiente ausentes no .env do Worker!');
    process.exit(1);
}

// ==========================================
// 2. FUNÇÃO PRINCIPAL DE SINCRONIZAÇÃO
// ==========================================
async function syncViewflixCookies() {
    console.log(`[${new Date().toISOString()}] 🔄 Iniciando extração de cookies...`);
    
    let proxyLocalAutenticado = null;
    let browser = null;

    try {
        // Configuração do Proxy (se existir)
        let puppeteerArgs = [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-web-security',
            '--disable-features=IsolateOrigins,site-per-process,AutoUpgradeMixedContent,HttpsUpgrades',
            '--disable-site-isolation-trials',
            '--allow-running-insecure-content',
            '--ignore-certificate-errors',
            '--force-device-scale-factor=1',
            '--disable-dev-shm-usage',
            '--disable-gpu',
            '--unsafely-treat-insecure-origin-as-secure=http://vouver.me'
        ];

        if (PROXY_HOST && PROXY_USER && PROXY_PASS) {
            const proxyUrlCompleta = `http://${PROXY_USER}:${PROXY_PASS}@${PROXY_HOST}:${PROXY_PORT}`;
            proxyLocalAutenticado = await proxyChain.anonymizeProxy(proxyUrlCompleta);
            puppeteerArgs.push(`--proxy-server=${proxyLocalAutenticado}`);
            console.log('🛡️ Proxy configurado e anonimizado.');
        } else {
            console.warn('⚠️ A rodar sem Proxy Residencial. Risco elevado de bloqueio do Cloudflare!');
        }

        browser = await puppeteer.launch({
            headless: true,
            ignoreHTTPSErrors: true,
            args: puppeteerArgs
        });

        const page = await browser.newPage();

        // Evasão Avançada de Deteção
        await page.evaluateOnNewDocument(() => {
            Object.defineProperty(navigator, 'webdriver', { get: () => false });
            window.chrome = { runtime: {} };
            Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3] });
            Object.defineProperty(navigator, 'languages', { get: () => ['pt-BR', 'pt', 'en-US'] });
        });

        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, cheerful Gecko) Chrome/124.0.0.0 Safari/537.36');
        await page.setDefaultNavigationTimeout(60000);

        // Otimização de Performance: Bloquear apenas mídia pesada. Deixar STYLESHEET livre para o Cloudflare!
        await page.setRequestInterception(true);
        page.on('request', (req) => {
            if (['image', 'font', 'media'].includes(req.resourceType())) {
                return req.abort();
            }
            if (req.isNavigationRequest() && req.redirectChain().length > 3) {
                return req.abort();
            }
            req.continue();
        });

        console.log('🌐 Navegando para a página alvo...');
        
        try {
            await page.goto(TARGET_URL, { waitUntil: 'networkidle2', timeout: 45000 });
        } catch (err) {
            console.warn('⚠️ O carregamento demorou muito, forçando continuação...');
        }

        // Lidar com o Cloudflare ou Erros SSL (Bypass forçado)
        const content = await page.content();
        if (content.includes('--google-blue') || content.includes('ERR_')) {
            console.log('🔄 Intervenção necessária. Tentando bypass via about:blank...');
            await page.goto('about:blank');
            await new Promise(r => setTimeout(r, 2000));
            await page.goto(TARGET_URL, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
        }

        // Esperar pelo input de forma inteligente
        console.log('⏳ Aguardando formulário de login...');
        await page.waitForSelector('#username', { visible: true, timeout: 30000 });

        // Preencher e submeter o formulário
        await page.evaluate((u, p) => {
            document.getElementById('username').value = u;
            document.getElementById('sifre').value = p;
            document.getElementById('login').click();
        }, LOGIN_USER, LOGIN_PASS);

        console.log('🔑 Credenciais inseridas. Aguardando processamento do login...');
        
        await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30000 }).catch(() => console.log('Navegação lenta, verificando cookies mesmo assim...'));
        
        await new Promise(r => setTimeout(r, 3000)); 

        const cookies = await page.cookies();
        const cookieMap = new Map();
        let cfClearanceValue = '';

        cookies.forEach(cookie => {
            cookieMap.set(cookie.name, cookie.value);
            if (cookie.name === 'cf_clearance') cfClearanceValue = cookie.value;
        });

        const order = ['PHPSESSID', 'vouverme', 'username', 'password', 'cf_clearance'];
        const sessionCookiesArray = order
            .filter(name => cookieMap.has(name))
            .map(name => `${name}=${cookieMap.get(name)}`);

        const finalSessionString = sessionCookiesArray.join('; ');

        if (!finalSessionString.includes('PHPSESSID')) {
            await page.screenshot({ path: 'erro-login-sem-sessao.png', fullPage: true });
            throw new Error('Login falhou: PHPSESSID ausente após o clique. Screenshot guardado.');
        }

        console.log('📡 Enviando cookies frescos para a API central...');
        
        const response = await fetch(WEBHOOK_URL, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${WEBHOOK_TOKEN}`
            },
            body: JSON.stringify({
                source: 'puppeteer_vps_worker',
                sessionCookies: finalSessionString,
                cfClearance: cfClearanceValue
            })
        });

        if (response.ok) {
            console.log('✅ Cookies sincronizados com sucesso via webhook!');
        } else {
            const body = await response.text();
            throw new Error(`[Erro Webhook] Status: ${response.status} | Body: ${body}`);
        }

    } catch (error) {
        console.error('❌ [Erro Crítico]:', error.message);
    } finally { // 🚀 CORREÇÃO SUPREMA: Alterado de 'file' para 'finally' com sucesso!
        console.log('🧹 Limpando processos...');
        if (browser) await browser.close();
        if (proxyLocalAutenticado) await proxyChain.closeAnonymizedProxy(proxyLocalAutenticado, true);
    }
}

// ==========================================
// 3. PREVENÇÃO DE PROCESSOS ZUMBI (Graceful Shutdown)
// ==========================================
process.on('SIGINT', async () => {
    console.log('Encerramento forçado detectado. Limpando processos...');
    process.exit(0);
});
process.on('SIGTERM', async () => {
    console.log('Encerramento do sistema detectado. Limpando processos...');
    process.exit(0);
});

// ==========================================
// 4. AGENDAMENTO E START DE GLOBAL SCOPE
// ==========================================

// Executa imediatamente ao ligar o processo de forma isolada
syncViewflixCookies();

// Agenda para rodar estritamente de hora em hora
cron.schedule('0 * * * *', () => {
    console.log('⏰ [Cron] Disparando rotina automática de atualização de cookies...');
    syncViewflixCookies();
});

console.log('🕰️ Worker agendado com sucesso. Aguardando ciclos...');