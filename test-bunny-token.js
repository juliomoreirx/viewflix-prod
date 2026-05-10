const crypto = require('crypto');

// Chave do .env
const BUNNY_PULL_ZONE_KEY = '66fc3275-56fd-4088-8992-2657b8cf642e';

// Caminho da URL
const path = '/series/os-cavaleiros-do-zodiaco-1986/season-1/s01e01-385658/index.m3u8';

// Gerar token
const expiresAt = Math.floor(Date.now() / 1000) + (24 * 3600);

console.log('\n=== BUNNY TOKEN - BASIC (MD5) vs ADVANCED (SHA256) ===\n');
console.log('Path:', path);
console.log('Expires:', expiresAt);
console.log('Key:', BUNNY_PULL_ZONE_KEY);
console.log('\n');

// BASIC - MD5
const basicTests = [
  { name: 'BASIC MD5: path + expires + key', input: path + expiresAt + BUNNY_PULL_ZONE_KEY, hash: 'md5' },
  { name: 'BASIC MD5: expires + path + key', input: expiresAt + path + BUNNY_PULL_ZONE_KEY, hash: 'md5' },
  { name: 'BASIC MD5: key + path + expires', input: BUNNY_PULL_ZONE_KEY + path + expiresAt, hash: 'md5' },
];

console.log('=== BASIC METHOD (MD5) ===\n');
basicTests.forEach((test, idx) => {
  const token = crypto.createHash(test.hash).update(test.input).digest('hex');
  console.log(`${idx + 1}. ${test.name}`);
  console.log(`   Token: ${token}`);
  console.log(`   URL: https://viewflixspace.b-cdn.net${path}?token=${token}&expires=${expiresAt}`);
  console.log('');
});

// ADVANCED - SHA256
const advancedTests = [
  { name: 'ADVANCED SHA256: path + expires + key', input: path + expiresAt + BUNNY_PULL_ZONE_KEY, hash: 'sha256' },
  { name: 'ADVANCED SHA256: expires + path + key', input: expiresAt + path + BUNNY_PULL_ZONE_KEY, hash: 'sha256' },
  { name: 'ADVANCED SHA256: key + path + expires', input: BUNNY_PULL_ZONE_KEY + path + expiresAt, hash: 'sha256' },
];

console.log('\n=== ADVANCED METHOD (SHA256) ===\n');
advancedTests.forEach((test, idx) => {
  const token = crypto.createHash(test.hash).update(test.input).digest('hex');
  console.log(`${idx + 1}. ${test.name}`);
  console.log(`   Token: ${token}`);
  console.log(`   URL: https://viewflixspace.b-cdn.net${path}?token=${token}&expires=${expiresAt}`);
  console.log('');
});

console.log('\n=== TENTE CADA URL E AVISE QUAL FUNCIONA ===\n');

