#!/usr/bin/env node

/**
 * Script de teste para validar a página de Admin do ViewFlix
 * 
 * Uso: node test-admin.js
 */

const http = require('http');
const token = process.env.ADMIN_API_TOKEN || '3276427420213442';

function testAdminAPI() {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'localhost',
      port: 3000,
      path: '/api/admin/users?page=1&limit=5',
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      }
    };

    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        console.log('\n✅ TESTE 1: Validação de Token');
        console.log(`Status: ${res.statusCode}`);
        
        if (res.statusCode === 200) {
          try {
            const json = JSON.parse(data);
            console.log(`✅ API retornou dados válidos`);
            console.log(`   - Total de usuários: ${json.totalUsers}`);
            console.log(`   - Página: ${json.page} de ${json.totalPages}`);
            resolve(true);
          } catch (e) {
            console.error('❌ Resposta não é JSON válido');
            reject(e);
          }
        } else {
          console.error('❌ Token inválido ou API retornou erro');
          console.error(data);
          reject(new Error('Invalid token'));
        }
      });
    });

    req.on('error', reject);
    req.end();
  });
}

function testAdminHTML() {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'localhost',
      port: 3000,
      path: '/admin.html',
      method: 'GET'
    };

    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        console.log('\n✅ TESTE 2: Acesso à Página Admin');
        console.log(`Status: ${res.statusCode}`);
        
        if (res.statusCode === 200 && data.includes('VIEWFLIX ADMIN')) {
          console.log('✅ Página carregada com sucesso');
          resolve(true);
        } else {
          console.error('❌ Página não encontrada ou inválida');
          reject(new Error('Invalid page'));
        }
      });
    });

    req.on('error', reject);
    req.end();
  });
}

async function runTests() {
  console.log('🚀 Iniciando testes do Admin Dashboard ViewFlix\n');
  console.log(`📝 Token usado: ${token.substring(0, 8)}...`);
  
  try {
    await testAdminHTML();
    await testAdminAPI();
    
    console.log('\n✅ Todos os testes passaram!');
    console.log('\n📍 Acesse a página admin em:');
    console.log('   http://localhost:3000/admin.html\n');
    process.exit(0);
  } catch (err) {
    console.error('\n❌ Erro durante os testes:', err.message);
    process.exit(1);
  }
}

runTests();
