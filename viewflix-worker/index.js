require('dotenv').config();
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const proxyChain = require('proxy-chain');
const cron = require('node-cron');

puppeteer.use(StealthPlugin());

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
    

    const proxyUrlCompleta = `http://${PROXY_USER}:${PROXY_PASS}@${PROXY_HOST}:${PROXY_PORT}`;
    let proxyLocalAutenticado = null;
    let browser = null;

    try {
        proxyLocalAutenticado = await proxyChain.anonymizeProxy(proxyUrlCompleta);

        browser = await puppeteer.launch({
            headless: 'new',
            ignoreHTTPSErrors: true,
            args: [
                `--proxy-server=${proxyLocalAutenticado}`,
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-web-security',
                '--disable-features=IsolateOrigins,site-per-process,AutoUpgradeMixedContent,HttpsUpgrades',
                '--disable-site-isolation-trials',
                '--allow-running-insecure-content',
                '--ignore-certificate-errors',
                '--ignore-certificate-errors-spki-list',
                '--force-device-scale-factor=1',
                '--disable-dev-shm-usage',
                '--disable-gpu',
                // Desativa upgrade automático de HTTP para HTTPS
                '--disable-features=AutoupgradeMixedContent',
                '--unsafely-treat-insecure-origin-as-secure=http://vouver.me',
            ]
        });

        const page = await browser.newPage();

        // Evasão de detecção
        await page.evaluateOnNewDocument(() => {
            Object.defineProperty(navigator, 'webdriver', { get: () => false });
            window.chrome = { runtime: {} };
            Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3] });
            Object.defineProperty(navigator, 'languages', { get: () => ['pt-BR', 'pt', 'en-US'] });
        });

        await page.setUserAgent(
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
        );
        await page.setDefaultNavigationTimeout(120000);
        await page.setJavaScriptEnabled(true);
        await page.setExtraHTTPHeaders({
            'Accept-Language': 'pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7'
        });

        // Intercepta requisições para evitar loop de redirect
        await page.setRequestInterception(true);
        let redirectCount = 0;
        page.on('request', (req) => {
            const url = req.url();
            // Bloqueia recursos desnecessários para acelerar
            if (['image', 'stylesheet', 'font', 'media'].includes(req.resourceType())) {
                return req.abort();
            }
            // Detecta loop de redirect e força URL original
            if (req.isNavigationRequest() && req.redirectChain().length > 3) {
                
                return req.abort();
            }
            req.continue();
        });

        
        try {
            await page.goto(TARGET_URL, {
                waitUntil: 'domcontentloaded', 
                timeout: 60000
            });
        } catch (err) {

        }

        await new Promise(r => setTimeout(r, 8000));

        // Checagem do conteúdo atual
        const currentUrl = page.url();
        const content = await page.content();

        // Se ainda está na página de erro do Chrome, tenta navegar direto via fetch interno
        if (content.includes('--google-blue') || content.includes('ERR_')) {

            
            // Tenta via about:blank + injeção de fetch
            await page.goto('about:blank');
            await new Promise(r => setTimeout(r, 2000));
            
            // Seta o contexto do domínio manualmente e navega
            await page.goto(TARGET_URL, {
                waitUntil: 'domcontentloaded',
                timeout: 60000
            }).catch(e => console.log('[Aviso] Segunda tentativa:', e.message));

            await new Promise(r => setTimeout(r, 8000));
        }

        try {
            await page.waitForSelector('#username', { visible: true, timeout: 30000 });
        } catch (e) {
            const finalContent = await page.content();
            await page.screenshot({ path: 'erro-vps.png', fullPage: true });
            throw new Error('Falha de renderização: #username não encontrado.');
        }

        await page.evaluate((u, p) => {
            const user = document.getElementById('username');
            const pass = document.getElementById('sifre');
            if (user && pass) {
                user.value = u;
                pass.value = p;
            }
        }, LOGIN_USER, LOGIN_PASS);


        await Promise.all([
            page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {}),
            page.evaluate(() => {
                const loginBtn = document.getElementById('login');
                if (loginBtn) loginBtn.click();
            })
        ]);


        await new Promise(r => setTimeout(r, 10000));

        const cookies = await page.cookies();
        let cookieMap = new Map();
        let cfClearanceValue = '';

        cookies.forEach(cookie => {
            cookieMap.set(cookie.name, cookie.value);
            if (cookie.name === 'cf_clearance') cfClearanceValue = cookie.value;
        });

        const order = ['PHPSESSID', 'vouverme', 'username', 'password', 'cf_clearance'];
        let sessionCookiesArray = [];
        order.forEach(name => {
            if (cookieMap.has(name)) sessionCookiesArray.push(`${name}=${cookieMap.get(name)}`);
        });

        const finalSessionString = sessionCookiesArray.join('; ');

        if (!finalSessionString.includes('PHPSESSID')) {
            // Loga todos cookies recebidos para diagnóstico
            throw new Error('Login falhou: PHPSESSID ausente após clique.');
        }


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
            console.log('✅ Cookies sincronizados com sucesso via webhook');
        } else {
            const body = await response.text();
            console.error('[Erro Webhook] Status:', response.status, '| Body:', body);
        }

    } catch (error) {
        console.error('[Erro Crítico]:', error.message);
    } finally {
        if (browser) await browser.close();
        if (proxyLocalAutenticado) await proxyChain.closeAnonymizedProxy(proxyLocalAutenticado, true);
    }
}

syncViewflixCookies();
cron.schedule('0 * * * *', () => syncViewflixCookies());