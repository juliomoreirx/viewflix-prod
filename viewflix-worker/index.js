require('dotenv').config();
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const proxyChain = require('proxy-chain');
const cron = require('node-cron');

// Ativa o plugin stealth para evitar detecção do Cloudflare
puppeteer.use(StealthPlugin());

// ==========================================
// CONFIGURAÇÕES (Ajuste conforme necessário)
// ==========================================
const PROXY_HOST = 'brd.superproxy.io';
const PROXY_PORT = '33335';
const PROXY_USER = 'brd-customer-hl_110d360f-zone-viewflix_login';
const PROXY_PASS = 'nje410p9m2w1';

const TARGET_URL = 'http://vouver.me/index.php?page=login'; 
const WEBHOOK_URL = 'https://watch.viewflix.space/cookies/webhook'; 
const WEBHOOK_TOKEN = 'QI113sPuww5G32yRefBTWefUXr63d7UrrmrhoI58orUk';

const LOGIN_USER = '85119rbz';
const LOGIN_PASS = 'cyd16156';

async function syncViewflixCookies() {
    console.log(`\n[${new Date().toISOString()}] Iniciando rotina de automação...`);
    
    const proxyUrlCompleta = `http://${PROXY_USER}:${PROXY_PASS}@${PROXY_HOST}:${PROXY_PORT}`;
    let proxyLocalAutenticado;
    
    try {
        // Cria um túnel local para autenticar no proxy residencial
        proxyLocalAutenticado = await proxyChain.anonymizeProxy(proxyUrlCompleta);
    } catch (err) {
        console.error('[Erro Crítico] Falha ao configurar túnel de proxy:', err.message);
        return;
    }

    const browser = await puppeteer.launch({
        headless: "new", // Modo VPS (sem interface visual)
        ignoreHTTPSErrors: true, // Ignora erros de SSL/Certificado na raiz
        args: [
            `--proxy-server=${proxyLocalAutenticado}`,
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-web-security',
            '--allow-running-insecure-content',
            '--disable-features=IsolateOrigins,site-per-process,SafeBrowsing,AutoUpgradeMixedContent,HttpsUpgrades'
        ]
    });

    let page;

    try {
        page = await browser.newPage();
        
        // Comando de baixo nível para forçar o Chrome a ignorar avisos de segurança
        const client = await page.target().createCDPSession();
        await client.send('Security.setIgnoreCertificateErrors', { ignore: true });

        // Define User-Agent real para evitar bloqueios
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

        console.log('[Info] Acessando vouver.me...');
        await page.goto(TARGET_URL, { 
            waitUntil: 'networkidle2', 
            timeout: 90000 
        }).catch(() => {
            console.log('[Aviso] Tempo de carregamento excedido ou redirecionamento detectado. Verificando seletores...');
        });

        // Caso o Chrome pare na tela de "Sua conexão não é privada" mesmo assim
        const proceedButton = await page.$('#proceed-link');
        if (proceedButton) {
            console.log('[Info] Tela de aviso detectada. Forçando entrada...');
            await page.click('#details-button').catch(() => {});
            await page.click('#proceed-link').catch(() => {});
            await new Promise(r => setTimeout(r, 5000));
        }

        console.log('[Info] Aguardando seletor de login...');
        await page.waitForSelector('#username', { visible: true, timeout: 45000 });

        console.log('[Info] Preenchendo credenciais...');
        await page.type('#username', LOGIN_USER, { delay: 100 });
        await page.type('#sifre', LOGIN_PASS, { delay: 100 });

        console.log('[Info] Executando comando de login...');
        // Clique via JS para evitar problemas com elementos sobrepostos
        await page.evaluate(() => {
            const btn = document.querySelector('#login');
            if (btn) btn.click();
        });

        // O site redireciona após 3s via AJAX. Aguardamos 8s para garantir.
        console.log('[Info] Aguardando processamento da sessão (8s)...');
        await new Promise(r => setTimeout(r, 8000));

        console.log('[Info] Extraindo cookies da nova sessão...');
        const cookies = await page.cookies();
        
        let cookieMap = new Map();
        let cfClearanceValue = '';

        cookies.forEach(cookie => {
            cookieMap.set(cookie.name, cookie.value);
            if (cookie.name === 'cf_clearance') cfClearanceValue = cookie.value;
        });

        // Formatação exata para a sua variável SESSION_COOKIES no .env
        const order = ['PHPSESSID', 'vouverme', 'username', 'password', 'cf_clearance'];
        let sessionCookiesArray = [];
        order.forEach(name => {
            if (cookieMap.has(name)) {
                sessionCookiesArray.push(`${name}=${cookieMap.get(name)}`);
            }
        });

        const finalSessionString = sessionCookiesArray.join('; ');

        if (!finalSessionString.includes('PHPSESSID') || !cfClearanceValue) {
            throw new Error('Sessão incompleta: PHPSESSID ou cf_clearance não encontrados.');
        }

        // Montagem do Payload para o Webhook
        const payload = {
            source: 'puppeteer_vps_worker',
            pageUrl: TARGET_URL,
            userAgent: await browser.userAgent(),
            sentAt: new Date().toISOString(),
            sessionCookies: finalSessionString,
            cfClearance: cfClearanceValue
        };

        console.log('[Info] Enviando cookies para o servidor...');
        const response = await fetch(WEBHOOK_URL, {
            method: 'POST',
            headers: { 
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${WEBHOOK_TOKEN}`
            },
            body: JSON.stringify(payload)
        });

        if (response.ok) {
            console.log('[Sucesso] Cookies sincronizados com o .env do servidor!');
        } else {
            console.error('[Erro Webhook] Status:', response.status);
        }

    } catch (error) {
        console.error('[Erro Crítico]:', error.message);
    } finally {
        if (browser) await browser.close();
        if (proxyLocalAutenticado) await proxyChain.closeAnonymizedProxy(proxyLocalAutenticado, true);
        console.log('[Info] Navegador encerrado e proxy limpo.');
    }
}

// Execução inicial
syncViewflixCookies();

// Agendamento: de 1 em 1 hora (no minuto zero)
cron.schedule('0 * * * *', () => {
    syncViewflixCookies();
});

console.log('[Viewflix Worker] Ativo. Próxima execução agendada para o início da próxima hora.');