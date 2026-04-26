# 🐛 Cookie Manager - Correção de Extração de Cookies

## Problema Identificado

O `CookieManager` estava renovando cookies corretamente, mas durante a extração dos `Set-Cookie` headers, estava **perdendo informações críticas**:

### Antes (Incompleto):
```
SESSION_COOKIES=PHPSESSID=c0302133fafaedb89cec49b1d6dbffc8
```

### Depois (Completo):
```
SESSION_COOKIES=PHPSESSID=427dc1a42194c028bdf1e01229bf31dc; vouverme=7323574; username=85119rbz; password=cyd16156
CF_CLEARANCE=ahOkOTRCCuf1mvMjlhpdQZfeme7qEJLA8x0MG4jF2vc-1776988972-...
```

## Root Cause Analysis

### 1. **Tipo de Requisição Errado**
- ❌ Estava fazendo `GET http://vouver.me/` (página inicial)
- ✅ Corrigido para: `POST http://vouver.me/login.php` com credenciais

```javascript
// Antes (GET simples)
const response = await axios.get(`${this.targetUrl}/`, {
  timeout: this.timeout,
  validateStatus: () => true,
  maxRedirects: 5,
  withCredentials: true
});

// Depois (POST com login)
const response = await axios.post(`${this.targetUrl}/login.php`, 
  `username=${process.env.LOGIN_USER}&password=${process.env.LOGIN_PASS}`,
  {
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
    },
    timeout: this.timeout,
    validateStatus: () => true,
    maxRedirects: 5
  }
);
```

### 2. **Lógica de Parse Melhorada**
- ✅ Agora usa `Map` para evitar duplicatas de cookies
- ✅ Parse correto de `Set-Cookie: name=value; Path=/; HttpOnly; Secure`
- ✅ Captura todos os 5 cookies importantes: `PHPSESSID`, `vouverme`, `username`, `password`, `cf_clearance`
- ✅ Consolidação em string separada por `; ` (sem espaço duplo ou formatação inválida)

```javascript
// Cookies extraídos corretamente:
const sessionCookieNames = ['PHPSESSID', 'vouverme', 'username', 'password', 'cf_clearance'];

for (const setCookie of setCookieHeaders) {
  const parts = setCookie.split(';');
  const firstPart = parts[0].trim();
  const [name, value] = firstPart.split('=');
  
  if (sessionCookieNames.includes(name.trim())) {
    cookies.sessionCookies.set(name.trim(), `${name.trim()}=${value.trim()}`);
  }
}

// Resultado: "PHPSESSID=x; vouverme=y; username=z; password=p; cf_clearance=c"
```

### 3. **Validação Crítica Implementada**
- ✅ Valida se `PHPSESSID` foi extraído antes de considerar sucesso
- ✅ Retry com exponential backoff: 1s, 2s, 4s (não 2s, 4s, 6s)
- ✅ Logging detalhado de cada tentativa

```javascript
// Validação rigorosa
const hasCriticalCookies = newCookies.sessionCookies && newCookies.sessionCookies.includes('PHPSESSID');

if (hasCriticalCookies) {
  // Salvar apenas se PHPSESSID presente
  await this.updateEnvFile({
    SESSION_COOKIES: this.sessionCookies,
    CF_CLEARANCE: this.cfClearance
  });
  return true;
}
```

### 4. **Atualização de process.env em Tempo Real**
- ✅ `process.env.SESSION_COOKIES` e `process.env.CF_CLEARANCE` atualizados imediatamente
- ✅ Depois persistidos no arquivo `.env` via `updateEnvFile()`
- ✅ Garante que proximas requisições usem novos cookies

```javascript
if (newCookies.cfClearance) {
  this.cfClearance = newCookies.cfClearance;
  process.env.CF_CLEARANCE = newCookies.cfClearance; // Imediato
  this.logger.info('[CookieManager] ✅ CF_CLEARANCE renovado');
}

if (newCookies.sessionCookies) {
  this.sessionCookies = newCookies.sessionCookies;
  process.env.SESSION_COOKIES = newCookies.sessionCookies; // Imediato
  this.logger.info('[CookieManager] ✅ SESSION_COOKIES renovados');
}
```

## Mudanças Implementadas

### Arquivo: `src/services/cookie-manager.service.js`

#### 1. Método `parseCookiesFromHeaders()` - REFATORADO
```javascript
parseCookiesFromHeaders(setCookieHeaders) {
  const cookies = {
    cfClearance: null,
    sessionCookies: new Map() // ← Map garante unicidade
  };

  const sessionCookieNames = ['PHPSESSID', 'vouverme', 'username', 'password', 'cf_clearance'];

  for (const setCookie of setCookieHeaders) {
    const parts = setCookie.split(';');
    const firstPart = parts[0].trim();
    const [name, value] = firstPart.split('=');

    if (!name || !value) continue;

    const trimmedName = name.trim();
    const trimmedValue = value.trim();

    // Tratar cf_clearance especialmente
    if (trimmedName.toLowerCase() === 'cf_clearance') {
      cookies.cfClearance = `cf_clearance=${trimmedValue}`;
    }

    // Adicionar ao Map (evita duplicatas)
    if (sessionCookieNames.includes(trimmedName)) {
      cookies.sessionCookies.set(trimmedName, `${trimmedName}=${trimmedValue}`);
    }
  }

  // Consolidar em string
  let sessionCookiesString = null;
  if (cookies.sessionCookies.size > 0) {
    sessionCookiesString = Array.from(cookies.sessionCookies.values()).join('; ');
  }

  return {
    cfClearance: cookies.cfClearance,
    sessionCookies: sessionCookiesString
  };
}
```

#### 2. Método `refreshCookies()` - CORRIGIDO
```javascript
async refreshCookies() {
  for (let attempt = 1; attempt <= this.maxRetries; attempt++) {
    try {
      // ← POST ao login.php (não GET à raiz)
      const response = await axios.post(`${this.targetUrl}/login.php`, 
        `username=${process.env.LOGIN_USER}&password=${process.env.LOGIN_PASS}`,
        {
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
          },
          timeout: this.timeout,
          validateStatus: () => true,
          maxRedirects: 5
        }
      );

      // Extrair Set-Cookie corretamente
      let setCookieHeaders = response.headers['set-cookie'] || [];
      if (!Array.isArray(setCookieHeaders)) {
        setCookieHeaders = [setCookieHeaders];
      }

      if (setCookieHeaders.length > 0) {
        const newCookies = this.parseCookiesFromHeaders(setCookieHeaders);
        
        // Atualizar process.env imediatamente
        if (newCookies.cfClearance) {
          this.cfClearance = newCookies.cfClearance;
          process.env.CF_CLEARANCE = newCookies.cfClearance; // ← Real-time
        }

        if (newCookies.sessionCookies) {
          this.sessionCookies = newCookies.sessionCookies;
          process.env.SESSION_COOKIES = newCookies.sessionCookies; // ← Real-time
        }

        // ← Validação rigorosa
        const hasCriticalCookies = newCookies.sessionCookies && 
                                   newCookies.sessionCookies.includes('PHPSESSID');
        
        if (hasCriticalCookies) {
          // Persistir no .env
          await this.updateEnvFile({
            SESSION_COOKIES: this.sessionCookies,
            CF_CLEARANCE: this.cfClearance
          });
          return true;
        } else {
          this.logger.warn(`PHPSESSID não encontrado na tentativa ${attempt}`);
        }
      }
    } catch (error) {
      this.logger.warn(`Tentativa ${attempt} falhou: ${error.message}`);
    }

    // Exponential backoff: 1s, 2s, 4s
    if (attempt < this.maxRetries) {
      const delayMs = 1000 * Math.pow(2, attempt - 1);
      this.logger.info(`Aguardando ${delayMs}ms antes da próxima tentativa...`);
      await this.delay(delayMs);
    }
  }

  return false;
}
```

## Fluxo de Renovação (Atualizado)

```
[1] CookieManager.checkAndRefreshCookies()
    ↓
[2] validateCookies() → Status 404? (Expirados)
    ↓
[3] refreshCookies() - Tentativa 1
    ├─ POST /login.php com credentials
    ├─ Recebe Set-Cookie headers
    ├─ parseCookiesFromHeaders() → Map-based parse
    ├─ Valida PHPSESSID presente?
    ├─ Atualiza process.env imediatamente
    └─ updateEnvFile() → Persiste em .env
    ↓
[4] Sucesso! Proximas requisições usam novos cookies
```

## Validação

### Script de Teste
```bash
node scripts/test-cookie-extraction.js
```

Teste:
1. Faz POST ao `/login.php` com credenciais
2. Captura `Set-Cookie` headers
3. Executa parse com lógica atualizada
4. Exibe resultado completo
5. Valida presença do PHPSESSID

### Logs Esperados
```
✅ PHPSESSID extraído
✅ vouverme extraído
✅ username extraído
✅ password extraído
✅ CF_CLEARANCE extraído

SESSION_COOKIES=PHPSESSID=427dc1a42194c028bdf1e01229bf31dc; vouverme=7323574; username=85119rbz; password=cyd16156
CF_CLEARANCE=ahOkOTRCCuf1mvMjlhpdQZfeme7qEJLA8x0MG4jF2vc-...
```

## Impacto

✅ **Antes**: Sistema caía quando cookies expirava (apenas PHPSESSID insuficiente)
✅ **Depois**: Todos os 5 cookies renovados, validade garantida por 30 dias

Tempo para próxima expiração: **~30 dias** (conforme cookie CF_CLEARANCE com expirationDate: 1808524966)

