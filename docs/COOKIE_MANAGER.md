# Cookie Manager - Documentação

## Visão Geral

O **Cookie Manager** é um sistema automático que monitora e renova cookies Cloudflare e de sessão que expiram regularmente. Ele previne que o sistema caia quando cookies expiram.

## Configuração

### 1. Adicionar variáveis ao `.env`

```env
# Cookies de sessão (serão renovados automaticamente)
SESSION_COOKIES=PHPSESSID=xxx; vouverme=yyy; username=zzz; password=www

# Cloudflare Challenge
CF_CLEARANCE=xxx.yyy.zzz

# API Key para autenticação remota (gerada automaticamente ou configurada manualmente)
COOKIE_REFRESH_API_KEY=seu_token_super_secreto_aqui

# URL base do Vouver (usado para renovação)
VOUVER_BASE_URL=http://vouver.me
```

### 2. Inicialização Automática

O Cookie Manager é inicializado automaticamente no bootstrap do servidor:

```javascript
const cookieManager = new CookieManagerService({
  targetUrl: env.VOUVER_BASE_URL || 'http://vouver.me',
  checkInterval: 3600000, // Verifica a cada 1 hora
  logger
});
cookieManager.startMonitoring(); // Inicia o monitoramento automático
```

## APIs de Gerenciamento

### 1. Verificar Status dos Cookies

```bash
curl -X GET http://localhost:3000/cookies/status \
  -H "Authorization: Bearer seu_token_aqui"
```

**Resposta:**
```json
{
  "status": {
    "lastCheck": "2026-04-23T20:30:00.000Z",
    "hasSessionCookies": true,
    "hasCfClearance": true,
    "monitoring": true,
    "checkInterval": 3600000,
    "refreshThreshold": 86400000
  },
  "timestamp": "2026-04-23T20:35:00.000Z"
}
```

### 2. Validar Cookies Atuais

```bash
curl -X POST http://localhost:3000/cookies/validate \
  -H "Authorization: Bearer seu_token_aqui" \
  -H "Content-Type: application/json"
```

**Resposta:**
```json
{
  "valid": true,
  "timestamp": "2026-04-23T20:35:00.000Z"
}
```

### 3. Forçar Renovação de Cookies

```bash
curl -X POST http://localhost:3000/cookies/refresh \
  -H "Authorization: Bearer seu_token_aqui" \
  -H "Content-Type: application/json"
```

**Resposta:**
```json
{
  "refreshed": true,
  "status": { /* ... */ },
  "timestamp": "2026-04-23T20:35:00.000Z"
}
```

### 4. Iniciar Monitoramento Automático

```bash
curl -X POST http://localhost:3000/cookies/start-monitoring \
  -H "Authorization: Bearer seu_token_aqui" \
  -H "Content-Type: application/json"
```

### 5. Parar Monitoramento Automático

```bash
curl -X POST http://localhost:3000/cookies/stop-monitoring \
  -H "Authorization: Bearer seu_token_aqui" \
  -H "Content-Type: application/json"
```

## Script Automático de Renovação

### Uso Local (sem autenticação)

```bash
# Verificar saúde dos cookies
node scripts/cookie-refresher.js check

# Renovar cookies
node scripts/cookie-refresher.js refresh
```

### Uso Remoto (com autenticação)

```bash
export DOMINIO_PUBLICO=https://seu-api.com
export COOKIE_REFRESH_API_KEY=seu_token_aqui

# Verificar status
node scripts/cookie-refresher.js status

# Renovar cookies
node scripts/cookie-refresher.js refresh
```

## Agendamento Automático (Cron Job)

### Linux/Mac - Verificar e renovar a cada 12 horas

```bash
# Abrir crontab
crontab -e

# Adicionar linha:
0 */12 * * * cd /caminho/para/fasttv && node scripts/cookie-refresher.js refresh >> /var/log/fasttv-cookies.log 2>&1
```

### Windows - Usando Task Scheduler

```powershell
# Criar tarefa que roda a cada 12 horas
$trigger = New-JobTrigger -RepetitionInterval (New-TimeSpan -Hours 12) -RepeatIndefinitely
$action = New-ScheduledJobOption -RunElevated
Register-ScheduledJob -Name "FastTV-CookieRefresh" `
  -ScriptBlock { 
    cd "E:\Viewflix-bot\fasttv"
    node scripts/cookie-refresher.js refresh 
  } `
  -Trigger $trigger
```

## Fluxo de Funcionamento

1. **Inicialização**: CookieManager inicia e imediatamente verifica validade dos cookies
2. **Monitoramento Periódico**: A cada 1 hora (configurável), verifica se cookies ainda são válidos
3. **Validação**: Faz uma requisição teste para vouver.me usando os cookies atuais
4. **Renovação**: Se inválidos, tenta obter novos cookies do Vouver
5. **Persistência**: Novos cookies são salvos no arquivo `.env` e recarregados no process.env
6. **Alerta**: Se falhar na renovação, registra erro no logger

## Tratamento de Erros

- **Cookies expirados**: CookieManager tenta renovar automaticamente
- **Falha na renovação**: Registra erro crítico no logger (requer intervenção manual)
- **Falha parcial**: Se apenas CF_CLEARANCE expirar mas SESSION_COOKIES permanecer válido, apenas CF_CLEARANCE é renovado

## Segurança

- ✅ Autenticação via Bearer Token
- ✅ Permite requisições locais sem token (127.0.0.1)
- ✅ Variável de ambiente para API Key
- ✅ Logging de tentativas de acesso não autorizado
- ✅ Validação de resposta HTTP antes de atualizar cookies

## Troubleshooting

### "❌ Falha ao renovar cookies"

1. Verifique se Vouver está online: `curl http://vouver.me`
2. Verifique logs do servidor
3. Tente renovação manual via API: `curl -X POST http://localhost:3000/cookies/refresh`

### "CF_CLEARANCE expirado"

Se apenas CF_CLEARANCE expirou (SESSION_COOKIES ainda válido):
- O CookieManager renovará apenas CF_CLEARANCE
- SESSION_COOKIES será preservado

### Cookies não atualizam em desenvolvimento

Se estiver testando localmente:
```bash
# Limpar .env antigo
rm .env

# Recriar com cookies novos
cp .env.example .env
# Editar .env com cookies atualizados
```

## Monitoramento Recomendado

Configure alertas para:
- ⚠️ Tentativas falhadas de renovação
- ⚠️ Cookies inválidos por mais de 5 minutos
- ⚠️ Falhas consecutivas na validação

## Performance

- Verificação: ~500ms por ciclo
- Renovação: ~5-10s quando necessário
- Impacto no servidor: Negligenciável (<1% CPU)
- Impacto na memória: <10MB

