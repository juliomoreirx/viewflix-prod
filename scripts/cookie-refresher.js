// scripts/cookie-refresher.js
// Script que pode ser rodado em cron job para renovar cookies automaticamente
// Uso: node scripts/cookie-refresher.js

const axios = require('axios');
const dotenv = require('dotenv');
const path = require('path');

// Carregar .env
dotenv.config({ path: path.join(__dirname, '../fasttv/.env') });

const BASE_API = process.env.DOMINIO_PUBLICO || 'http://localhost:3000';
const API_KEY = process.env.COOKIE_REFRESH_API_KEY; // Será adicionado ao .env

async function refreshCookies() {
  try {
    console.log('🔄 Iniciando renovação de cookies...');
    
    // Endpoint no servidor para renovar cookies
    const response = await axios.post(`${BASE_API}/cookies/refresh`, {}, {
      headers: {
        'Authorization': `Bearer ${API_KEY}`,
        'Content-Type': 'application/json'
      },
      timeout: 60000
    });

    if (response.data.refreshed) {
      console.log('✅ Cookies renovados com sucesso!');
      console.log('Status:', response.data.status);
      process.exit(0);
    } else {
      console.error('❌ Falha ao renovar cookies');
      process.exit(1);
    }
  } catch (error) {
    console.error('❌ Erro ao contactar servidor:', error.message);
    process.exit(1);
  }
}

async function checkCookiesHealth() {
  try {
    console.log('🔍 Verificando saúde dos cookies...');
    
    const response = await axios.get(`${BASE_API}/cookies/status`, {
      headers: {
        'Authorization': `Bearer ${API_KEY}`
      },
      timeout: 30000
    });

    console.log('📊 Status dos Cookies:');
    console.log(JSON.stringify(response.data, null, 2));
    
    process.exit(0);
  } catch (error) {
    console.error('❌ Erro ao verificar status:', error.message);
    process.exit(1);
  }
}

// Parse command line arguments
const command = process.argv[2] || 'check';

if (command === 'refresh') {
  refreshCookies();
} else if (command === 'check' || command === 'status') {
  checkCookiesHealth();
} else {
  console.log('Uso: node cookie-refresher.js [comando]');
  console.log('Comandos:');
  console.log('  check    - Verifica saúde dos cookies (padrão)');
  console.log('  status   - Mesmo que check');
  console.log('  refresh  - Força renovação dos cookies');
  process.exit(0);
}
