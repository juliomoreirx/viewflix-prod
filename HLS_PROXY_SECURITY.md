# HLS Proxy Security - Encriptação de URLs

## Problema Resolvido

Antes: Links do Bunny estavam sendo expostos via **base64** (encoding reversível)
- Network tab do navegador expõe URLs reais
- Qualquer um pode descobrir onde o conteúdo está armazenado

Agora: URLs encriptadas com **AES-256-GCM**
- Network tab só mostra token criptografado
- Bunny URLs permanecem secretas
- Token inclui autenticação (não pode ser manipulado)

## Como Funciona

### 1. Player (Navegador)
```javascript
// URL original do Bunny é criptografada antes de enviar ao proxy
const proxyUrl = '/api/hls-proxy/manifest?token=<encrypted>';
// Token é enviado, não a URL original
```

### 2. Servidor (Backend)
```javascript
// Recebe token criptografado
GET /api/hls-proxy/manifest?token=a1b2c3d4:...
  ↓
// Descriptografa com chave privada
const url = hlsProxy.decryptUrl(token);
  ↓
// Valida que é URL do Bunny (security check)
if (!url.includes('b-cdn.net')) throw Error;
  ↓
// Faz requisição ao Bunny (servidor-lado, sem CORS)
axios.get(url)
  ↓
// Retorna ao navegador
```

## Setup Necessário

### 1. Gerar Chave de Encriptação

Execute no terminal Node.js:
```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Resultado: String com 64 caracteres hexadecimais
```
a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6
```

### 2. Configurar no .env

```bash
# .env
HLS_PROXY_ENCRYPTION_KEY=a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6
```

### 3. IMPORTANTE: Persistência da Chave

⚠️ **A chave deve ser a MESMA em todos os restarts do servidor**

Se a chave mudar:
- ✅ Tokens novos funcionarão
- ❌ Tokens antigos ficarão inválidos
- ❌ Usuários que estão assistindo verão erro

**Solução:** Guardar a chave em um `.env` versionado ou usar um secrets manager (AWS Secrets, HashiCorp Vault, etc)

## Segurança

### O que é Protegido

✅ URLs do Bunny CDN encriptadas com AES-256-GCM
✅ Autenticação: token é verificado (não pode ser manipulado)
✅ Validação: só permite URLs de b-cdn.net ou bunny domains
✅ Token inclui IV (initialization vector) aleatório para cada requisição

### O que NÃO é Protegido

❌ Dados em repouso no servidor (requer HTTPS)
❌ Dados no navegador (requer HTTPS)
❌ Se alguém roubar a chave privada (HLS_PROXY_ENCRYPTION_KEY)

### Melhores Práticas

1. **Use HTTPS** (obrigatório para segurança real)
2. **Guarde a chave em ambiente seguro** (não no git)
3. **Rotação de chave** (opcional, mas recomendado anualmente)
4. **Rate limiting** (adicione limites de requisições por IP)

## Monitoramento

### Logs de Segurança

```javascript
// Sucesso
[HLS Proxy] Fetching segment (a1b2c3d4...)

// Falha de descriptografia (tentativa de manipulação)
[HLS Proxy] Decryption/authentication failed (possible token tampering)

// URL não autorizada
[HLS Proxy] Security: Attempted unauthorized access to non-Bunny URL

// Token inválido
[HLS Proxy] Token has invalid format (expected 3 parts)
```

## Teste

### 1. Verify Encryption Key

```bash
# Na inicialização, verá:
[HLS Proxy] Using HLS_PROXY_ENCRYPTION_KEY from environment
# ou
[HLS Proxy] No encryption key set. Set HLS_PROXY_ENCRYPTION_KEY to persist key...
```

### 2. Network Tab (DevTools)

**Antes (sem encriptação):**
```
GET /api/hls-proxy/segment?url=https://viewflixspace.b-cdn.net/series/.../0000.ts
Expõe URL completa!
```

**Depois (com encriptação):**
```
GET /api/hls-proxy/segment?token=a1b2c3d4:e5f6a7b8:9c0d1e2f
URL secreta! ✅
```

### 3. Descriptografia Inválida

Abra DevTools Console:
```javascript
// Tente descriptografar um token falso
const hlsProxy = require('./src/services/hls-proxy.service');
const fakeToken = 'fake:token:data';
hlsProxy.decryptUrl(fakeToken);
// Retorna: null (token inválido)
```

## Troubleshooting

### Síntoma: "Decryption failed" no console
**Causa:** Chave foi alterada entre requisições
**Solução:** Reinicie servidor com mesma chave no .env

### Síntoma: Vídeo funciona, mas logs mostram "token tampering"
**Causa:** Token foi modificado durante transmissão
**Solução:** Não é problema normal, verificar integridade da rede (HTTPS obrigatório)

### Síntoma: "Invalid segment URL - must be from Bunny CDN"
**Causa:** Token descriptografa para URL não-Bunny
**Solução:** Verificar se encryptUrl() foi chamado com URL correta

## Próximas Melhorias (Opcional)

1. **Rate Limiting** por token/IP
2. **Token Expiration** (tokens que expiram após X tempo)
3. **JWT Signing** (adicionar user ID ao token)
4. **Audit Log** (registrar todas as requisições de proxy)

## Referência Rápida

| Aspecto | Antes | Depois |
|---------|-------|--------|
| Encoding | Base64 (reversível) | AES-256-GCM (irreversível) |
| Network Leak | URLs visíveis | URLs criptografadas |
| Autenticação | Nenhuma | GCM Auth Tag |
| Validação | Nenhuma | URL deve ser Bunny |
| Performance | Rápida | ~1ms por decrypt (insignificante) |

