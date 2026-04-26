#!/usr/bin/env node

/**
 * Script de teste: Valida a extração de cookies
 * Testa o parse de headers Set-Cookie
 */

const axios = require('axios');
require('dotenv').config();

// Simular a função de parse
function parseCookiesFromHeaders(setCookieHeaders) {
  const cookies = {
    cfClearance: null,
    sessionCookies: new Map()
  };

  const sessionCookieNames = ['PHPSESSID', 'vouverme', 'username', 'password', 'cf_clearance'];

  for (const setCookie of setCookieHeaders) {
    const parts = setCookie.split(';');
    const firstPart = parts[0].trim();
    const [name, value] = firstPart.split('=');

    if (!name || !value) continue;

    const trimmedName = name.trim();
    const trimmedValue = value.trim();

    if (trimmedName.toLowerCase() === 'cf_clearance') {
      cookies.cfClearance = `cf_clearance=${trimmedValue}`;
      console.log(`✅ CF_CLEARANCE extraído (${trimmedValue.substring(0, 30)}...)`);
    }

    if (sessionCookieNames.includes(trimmedName)) {
      cookies.sessionCookies.set(trimmedName, `${trimmedName}=${trimmedValue}`);
      console.log(`✅ ${trimmedName} extraído (${trimmedValue.substring(0, 30)}...)`);
    }
  }

  let sessionCookiesString = null;
  if (cookies.sessionCookies.size > 0) {
    sessionCookiesString = Array.from(cookies.sessionCookies.values()).join('; ');
  }

  return {
    cfClearance: cookies.cfClearance,
    sessionCookies: sessionCookiesString
  };
}

async function testCookieExtraction() {
  console.log('🔍 Testando extração de cookies...\n');

  try {
    console.log('📝 Fazendo POST ao vouver.me/ajax/login.php...');
    const response = await axios.post(
      `${process.env.BASE_URL}/ajax/login.php`,
      {
        username: process.env.LOGIN_USER,
        password: process.env.LOGIN_PASS,
        remember: 1,
        type: 1
      },
      {
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          'X-Requested-With': 'XMLHttpRequest',
          'Referer': `${process.env.BASE_URL}/`
        },
        timeout: 10000,
        validateStatus: () => true,
        maxRedirects: 5
      }
    );

    console.log(`\n📊 Response Status: ${response.status}`);
    console.log(`📊 Response Body: ${response.data}`);
    console.log(`📊 Response Headers:`, Object.keys(response.headers));

    let setCookieHeaders = response.headers['set-cookie'] || [];
    if (!Array.isArray(setCookieHeaders)) {
      setCookieHeaders = [setCookieHeaders];
    }

    console.log(`\n🍪 Set-Cookie headers recebidos: ${setCookieHeaders.length}\n`);

    if (setCookieHeaders.length > 0) {
      setCookieHeaders.forEach((cookie, idx) => {
        console.log(`${idx + 1}. ${cookie.substring(0, 80)}...`);
      });

      console.log('\n🔄 Parseando cookies...\n');
      const parsed = parseCookiesFromHeaders(setCookieHeaders);

      console.log('\n📋 Resultado Final:');
      console.log(`SESSION_COOKIES: ${parsed.sessionCookies}`);
      console.log(`CF_CLEARANCE: ${parsed.cfClearance}`);

      if (parsed.sessionCookies && parsed.sessionCookies.includes('PHPSESSID')) {
        console.log('\n✅ SUCCESS: PHPSESSID encontrado!');
      } else {
        console.log('\n❌ ERRO: PHPSESSID não encontrado!');
      }
    } else {
      console.log('❌ Nenhum Set-Cookie recebido');
    }
  } catch (error) {
    console.error(`❌ Erro: ${error.message}`);
    process.exit(1);
  }
}

testCookieExtraction();
