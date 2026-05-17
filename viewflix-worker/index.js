const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../.env') });
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const proxyChain = require('proxy-chain');
const cron = require('node-cron');

puppeteer.use(StealthPlugin());

// ==========================================
// 1. VALIDAÇÃO DE AMBIENTE (Failsafe)
// ==========================================
// 🚀 CORREÇÃO APLICADA: Agora usamos RES_PROXY_* igual à tua .env
const {
    RES_PROXY_HOST,
    RES_PROXY_PORT = '33335',
    RES_PROXY_USER,
    RES_PROXY_PASS,
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
        let puppeteerArgs = [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-web-security',
            '--window-size=1920,1080',
            '--disable-features=IsolateOrigins,site-per-process,AutoUpgradeMixedContent,HttpsUpgrades',
            '--disable-site-isolation-trials',
            '--ignore-certificate-errors',
            '--force-device-scale-factor=1',
            '--disable-dev-shm-usage',
            '--disable-gpu'
        ];

        // 🚀 CORREÇÃO APLICADA: Validação usando as variáveis com RES_
        if (RES_PROXY_HOST && RES_PROXY_USER && RES_PROXY_PASS) {
            const proxyUrlCompleta = `http://${RES_PROXY_USER}:${RES_PROXY_PASS}@${RES_PROXY_HOST}:${RES_PROXY_PORT}`;
            proxyLocalAutenticado = await proxyChain.anonymizeProxy(proxyUrlCompleta);
            puppeteerArgs.push(`--proxy-server=${proxyLocalAutenticado}`);
            console.log('🛡️ Proxy Bright Data configurado e anonimizado!');
        } else {
            console.warn('⚠️ A rodar sem Proxy Residencial. Risco elevado de bloqueio do Cloudflare!');
        }

        browser = await puppeteer.launch({
            headless: 'new',
            ignoreHTTPSErrors: true,
            args: puppeteerArgs
        });

        const page = await browser.newPage();
        await page.setViewport({ width: 1920, height: 1080 });

        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36');
        await page.setDefaultNavigationTimeout(60000);

        await page.setRequestInterception(true);
        page.on('request', (req) => {
            if (['font', 'media'].includes(req.resourceType())) {
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

        console.log('⏳ Analisando a página (Aguardando Cloudflare ou Login)...');
        await new Promise(r => setTimeout(r, 8000)); 

        await page.waitForSelector('#username', { visible: true, timeout: 45000 });
        console.log('✅ Tela de login alcançada!');

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
        
        if (browser) {
            try {
                const pages = await browser.pages();
                if (pages.length > 0) {
                    await pages[0].screenshot({ path: '/root/viewflix/viewflix-prod/viewflix-worker/debug-cloudflare.png', fullPage: true });
                    console.log('📸 Screenshot da tela de bloqueio salvo em: debug-cloudflare.png');
                }
            } catch (e) {}
        }
    } finally {
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
syncViewflixCookies();

cron.schedule('0 * * * *', () => {
    console.log('⏰ [Cron] Disparando rotina automática de atualização de cookies...');
    syncViewflixCookies();
});

console.log('🕰️ Worker agendado com sucesso. Aguardando ciclos...');