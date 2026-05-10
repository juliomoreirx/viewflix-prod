# HLS Player Fix - Tela Preta 0:00

## Problema Relatado
- Player abrindo com tela preta
- Timer travado em 0:00
- Arquivo `.m3u8` não carregando
- VLC toca o arquivo normalmente (arquivo está OK)

## Causas Identificadas

### 1. **URL não sendo escapada corretamente**
- `streamPath` era injetado com aspas simples: `const streamPath = '${streamPath}';`
- URLs com caracteres especiais (Bunny CDN) poderiam quebrar a string JavaScript

### 2. **Falta de headers CORS no Hls.js**
- Bunny CDN requer configuração de CORS
- Hls.js não tinha `xhrSetup` configurado
- `crossOrigin` não estava definido no elemento video

### 3. **Sem logging para debug**
- Impossível identificar em qual etapa o carregamento falha
- Sem mensagens de erro no console do navegador

## Soluções Implementadas

### 1. ✅ URL Properly Escaped (Commit: 70598eb)
```javascript
// ANTES:
const streamPath = '${streamPath}';

// DEPOIS:
const streamPath = ${JSON.stringify(streamPath)};
```
**Benefício**: URL é escapada corretamente, funciona com URLs contendo `/`, `?`, `&`, `#`

### 2. ✅ CORS Headers for Hls.js
```javascript
const hlsConfig = {
  enableWorker: true,
  lowLatencyMode: false,
  backBufferLength: 180,
  maxBufferLength: 120,
  maxMaxBufferLength: 240,
  maxBufferHole: 0.5,
  startFragPrefetch: true,
  fragLoadingTimeOut: 20000,
  fragLoadingMaxRetry: 4,
  manifestLoadingMaxRetry: 4,
  xhrSetup: (xhr, url) => {
    xhr.withCredentials = false;  // ← NOVO
  }
};

// ...
hls.attachMedia(videoEl);
videoEl.crossOrigin = 'anonymous';  // ← NOVO
```

### 3. ✅ Comprehensive Logging
```javascript
console.log('[Player] Loading source:', { url, resumeAt, type });
console.log('[Player] Hls.js is supported, loading manifest');
console.log('[HLS] Manifest parsed successfully', { url, levels });
console.error('[HLS] Error:', data);
console.warn('[HLS] Network error, retrying...', data);
```

## Como Testar

### No Navegador (DevTools)
1. Abra um filme com HLS transcode (tenha `hlsManifestUrl` no banco)
2. Abra DevTools: `F12`
3. Vá para aba **Console**
4. Procure pelos logs:
   - `[Player] Loading source: { url: 'https://..../index.m3u8', ... }`
   - `[Player] Hls.js is supported, loading manifest`
   - `[HLS] Manifest parsed successfully` ✅ (se tudo OK)
   - `[HLS] Error:` ❌ (se houver problema)

### Comportamento Esperado

#### Cenário 1: Sucesso ✅
```
[Player] Loading source: { url: 'https://viewflixspace.b-cdn.net/a-abelha-maya-o-filme-2014-60003/index.m3u8', resumeAt: 0, type: 'HLS' }
[Player] Hls.js is supported, loading manifest
[HLS] Manifest parsed successfully { url: 'https://...', levels: 1 }
```
→ **Vídeo começa a tocar normalmente**

#### Cenário 2: Erro de Rede ❌
```
[HLS] Error: { type: 'networkError', details: 'manifestParsingError', ... }
[HLS] Network error, retrying...
```
→ **Player tenta reconectar**, caso contrário vê mensagem: "O canal pode estar instável"

#### Cenário 3: Bunny CDN retorna 404 ❌
```
[HLS] Error: { type: 'networkError', fatal: true, ... }
[HLS] Fatal error, retrying stream...
```
→ **Precisa verificar se `hlsManifestUrl` no DB está correto e o arquivo existe no Bunny**

## Próximos Passos de Teste

### 1. Verificar BD
```javascript
// No MongoDB, procure por um filme que deveria ter HLS:
db.purchasedcontents.findOne({ mediaType: 'movie', hlsManifestUrl: { $exists: true } })

// Resultado deve ter:
{
  _id: ObjectId(...),
  videoId: 'abc123',
  hlsManifestUrl: 'https://viewflixspace.b-cdn.net/a-abelha-maya-o-filme-2014-60003/index.m3u8',
  title: 'A Abelha Maya: O Filme',
  ...
}
```

### 2. Testar URL Diretamente
```bash
# Via curl para verificar se Bunny tem o arquivo:
curl -I "https://viewflixspace.b-cdn.net/a-abelha-maya-o-filme-2014-60003/index.m3u8"

# Resposta esperada:
# HTTP/1.1 200 OK
# Content-Type: application/vnd.apple.mpegurl
# Content-Length: 1234
```

### 3. Verificar Estrutura de Pastas no Bunny
```
✅ Estrutura de Filme:
a-abelha-maya-o-filme-2014-60003/
  ├── index.m3u8
  ├── 0000.ts
  ├── 0001.ts
  ├── 0002.ts
  └── ...

❌ Estrutura Antiga (não vai funcionar):
content/movie/60003/
  ├── index.m3u8
  ├── 0000.ts
  └── ...
```

### 4. Reiniciar Aplicação
```bash
cd /path/to/viewflix-prod
git pull origin main  # Get commit 70598eb
npm install          # Se necessário
pm2 restart viewflix
```

## Commits Relacionados

| Commit | Mudança |
|--------|---------|
| `4fc4a04` | Usar nome do MP4 como pasta do filme no Bunny |
| `70598eb` | Fix: melhorar carregamento HLS.js com CORS e logging |

## Debug Manual

Se ainda tiver problemas, abra DevTools e execute:

```javascript
// Verificar se Hls.js está carregado
console.log(typeof Hls);  // Deve ser: "function"

// Verificar se a URL está correta
console.log(streamPath);  // Deve ser URL completa: https://...../index.m3u8

// Criar instância HLS manualmente (teste)
if (Hls.isSupported()) {
  const testHls = new Hls();
  testHls.loadSource('https://viewflixspace.b-cdn.net/seu-filme/index.m3u8');
  testHls.on(Hls.Events.MANIFEST_PARSED, () => console.log('✅ Funcionou!'));
  testHls.on(Hls.Events.ERROR, (e, d) => console.log('❌ Erro:', d));
}
```

## Checklist de Verificação

- [ ] Filme tem `hlsManifestUrl` no BD (inspecione em MongoDB)
- [ ] `hlsManifestUrl` aponta para URL válida (teste com curl -I)
- [ ] Arquivo `index.m3u8` existe no Bunny CDN
- [ ] Todos os arquivos `.ts` foram uploaded para Bunny
- [ ] DevTools Console mostra logs `[Player]` e `[HLS]`
- [ ] Sem erros 404 ou CORS no network tab
- [ ] Vídeo começa a tocar após ~3-5 segundos

## Troubleshooting

### Sintoma: "Tela preta, 0:00"
**Solução 1**: Verificar console do navegador
- Deve ter logs `[HLS]` para debug
- Se vazio = URL não está sendo carregada corretamente

**Solução 2**: Verificar se `hlsManifestUrl` existe no BD
- Se vazio = transcode não rodou ou falhou
- Verifique logs da aplicação para erros de transcode

**Solução 3**: Teste URL diretamente no browser
- Cole a URL no endereço: `https://viewflixspace.b-cdn.net/seu-filme/index.m3u8`
- Se retorna 404 = arquivo não foi uploadado ao Bunny
- Se retorna conteúdo = problema está no player Hls.js

### Sintoma: "CORS error"
**Solução**: Bunny CDN pode estar bloqueando requisições
- Verifique configuração de CORS no painel Bunny
- Adicione seu domínio às origens permitidas

### Sintoma: "Travado em 0:00 mas vídeo toca parcialmente"
**Solução**: Problema de buffer
- Aumente `maxBufferLength` em `hlsConfig`
- Reduza `startFragPrefetch` para `false`
- Teste com outro vídeo para confirmar padrão

## Contato Técnico
Se problemas persistirem:
1. Cole todos os logs do console
2. Cole URL do vídeo que falha
3. Verifique resposta do curl para a URL
4. Verifique estrutura de pastas no Bunny CDN
