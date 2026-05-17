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
const {
    RES_PROXY_HOST,
    RES_PROXY_PORT = '33335',
    RES_PROXY_USER,
    RES_PROXY_PASS,
    LOGIN_USER,
    LOGIN_PASS,
    WEBHOOK_URL,
    WEBHOOK_TOKEN
} = process.env;

// 🚀 FIX ABSOLUTO: HTTP PURO E ENGESSADO. SEM REPLACES, SEM INVENCÕES.
const TARGET_URL = 'http://vouver.me/index.php?page=login';

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
            '--ignore-certificate-errors',
            '--disable-dev-shm-usage',
            '--disable-gpu',
            // 🚀 A MÁGICA ESTÁ AQUI: Proíbe o Chrome de tentar forçar HTTPS (O que causava o Too Many Redirects)
            '--disable-features=HttpsUpgrades,AutoUpgradeMixedContent,IsolateOrigins,site-per-process',
            '--unsafely-treat-insecure-origin-as-secure=http://vouver.me'
        ];

        // Usando a credencial bruta sem encode para a Bright Data não rejeitar
        if (RES_PROXY_HOST && RES_PROXY_USER && RES_PROXY_PASS) {
            const proxyUrlCompleta = `http://${RES_PROXY_USER}:${RES_PROXY_PASS}@${RES_PROXY_HOST}:${RES_PROXY_PORT}`;
            proxyLocalAutenticado = await proxyChain.anonymizeProxy(proxyUrlCompleta);
            puppeteerArgs.push(`--proxy-server=${proxyLocalAutenticado}`);
            console.log('🛡️ Proxy Bright Data configurado e anonimizado!');
        } else {
            console.warn('⚠️ A rodar sem Proxy Residencial!');
        }

        browser = await puppeteer.launch({
            headless: true,
            ignoreHTTPSErrors: true,
            args: puppeteerArgs
        });

        const page = await browser.newPage();
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36');
        await page.setDefaultNavigationTimeout(45000);

        // Bloqueio de peso morto (imagens e fontes)
        await page.setRequestInterception(true);
        page.on('request', (req) => {
            if (['image', 'font', 'media'].includes(req.resourceType())) {
                return req.abort();
            }
            req.continue();
        });

        console.log(`🌐 Navegando para (HTTP PURO): ${TARGET_URL}`);
        
        try {
            await page.goto(TARGET_URL, { waitUntil: 'domcontentloaded', timeout: 45000 });
        } catch (err) {
            console.warn(`⚠️ Timeout na rede (${err.message}). Continuando...`);
        }

        console.log('⏳ Aguardando formulário de login...');
        await page.waitForSelector('#username', { visible: true, timeout: 30000 });

        console.log('✅ Tela de login alcançada!');
        await page.evaluate((u, p) => {
            document.getElementById('username').value = u;
            document.getElementById('sifre').value = p;
            document.getElementById('login').click();
        }, LOGIN_USER, LOGIN_PASS);

        console.log('🔑 Credenciais inseridas. Aguardando processamento...');
        
        // Timeout menor e com catch para não travar o script se o botão for de requisição AJAX (como mostrou no HTML)
        await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 15000 }).catch(() => {});
        
        // Tempo crucial para a resposta do AJAX.login.php processar o cookie no servidor
        await new Promise(r => setTimeout(r, 4000)); 

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
            throw new Error('Login falhou: PHPSESSID ausente após a submissão.');
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
    } finally {
        console.log('🧹 Limpando processos...');
        if (browser) await browser.close();
        if (proxyLocalAutenticado) await proxyChain.closeAnonymizedProxy(proxyLocalAutenticado, true);
    }
}

// ==========================================
// 3. PREVENÇÃO DE PROCESSOS ZUMBI
// ==========================================
process.on('SIGINT', async () => { process.exit(0); });
process.on('SIGTERM', async () => { process.exit(0); });

// ==========================================
// 4. EXECUÇÃO EM ESCOPO GLOBAL DO CRON
// ==========================================
syncViewflixCookies();

cron.schedule('0 * * * *', () => {
    console.log('⏰ [Cron] Disparando rotina automática de atualização de cookies...');
    syncViewflixCookies();
});

console.log('🕰️ Worker agendado com sucesso. Aguardando ciclos...');