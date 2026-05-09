# LiveTV Buffer Configuration Guide

## Por que o vídeo estava "choppy" (pulando frames)?

O buffer padrão (6 segundos x 30 segmentos = 180 segundos) é **muito agressivo** para streams LiveTV:
- Segmentos muito curtos = mudanças frequentes de taxa de bits
- Buffer pequeno = o player fica sem dados frequentemente
- Resultado: frame drops, áudio ok (menos sensível a jitter)

## Configuração Otimizada (Nova)

**Segmentação: 10 segundos × 60 segmentos = 600 segundos (10 minutos de buffer)**

### Por que funciona melhor:

1. **Segmentos maiores (10s)** 
   - Menos overhead de multiplexação
   - Mais dados por segmento = mais previsível
   - Taxa de bits mais estável

2. **Buffer grande (600s)**
   - Absorve variações de qualidade
   - Permite smooth playback mesmo com latência de rede
   - Player mantém taxa de frames consistente

3. **Auto-provisioning**
   - Todos os canais LiveTV recebem a mesma configuração otimizada
   - Sem necessidade de configuração manual
   - Warmup automático no boot

## Como Usar

### Auto-Provisioning (Padrão)
Ocorre automaticamente no boot do servidor:
```
[boot] Iniciando provisioning de 6808 canais LiveTV
[boot] Provisioning concluído: inserted=6808 duration=2340ms
[boot] Iniciando warmup de 6808 canais LiveTV
```

### Manual - Salvar Configuração de um Canal
```bash
curl -X PUT http://localhost:3000/api/admin/livetv-buffer/profiles/293 \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "enabled": true,
    "segmentDurationSec": 10,
    "segmentCount": 60,
    "warmupMode": "on-demand"
  }'
```

### Manual - Reprovisionar Todos os Canais
```bash
curl -X POST http://localhost:3000/api/admin/livetv-buffer/reprovision \
  -H "Authorization: Bearer YOUR_TOKEN"
```

### Manual - Disparar Warmup
```bash
curl -X POST http://localhost:3000/api/admin/livetv-buffer/profiles/293/warmup \
  -H "Authorization: Bearer YOUR_TOKEN"
```

### Manual - Verificar Status
```bash
curl -X GET http://localhost:3000/api/livetv-buffer/293/status
```

Resposta:
```json
{
  "ok": true,
  "data": {
    "channelId": "293",
    "status": "warming",
    "enabled": true,
    "segmentDurationSec": 10,
    "segmentCount": 60,
    "targetBufferSec": 600,
    "shouldDelayPlayback": true
  }
}
```

## Ajuste Fino (Se Necessário)

Se ainda tiver choppiness:

| Sintoma | Solução | Valores Recomendados |
|---------|--------|---------------------|
| Vídeo muito choppy | Aumentar segmentos | segmentCount: 80-100 |
| Alto uso de memória | Reduzir segmentos | segmentCount: 40 |
| Latência alta | Aumentar duração | segmentDurationSec: 15 |
| Latência baixa | Reduzir duração | segmentDurationSec: 5 |

**Fórmula**: `Buffer Total (segundos) = segmentDurationSec × segmentCount`

Exemplos:
- 10s × 60 = 600s (10 min) ✅ Atual
- 10s × 80 = 800s (13 min) - Mais buffer
- 5s × 100 = 500s (8 min) - Menos latência

## Endpoints de Administração

**GET** `/api/admin/livetv-buffer/catalog`
- Lista todos os canais com seus perfis
- Query params: `enabled`, `status`, `page`, `limit`

**PUT** `/api/admin/livetv-buffer/profiles/:channelId`
- Salva/atualiza perfil de um canal

**POST** `/api/admin/livetv-buffer/profiles/:channelId/warmup`
- Dispara warmup manual para um canal

**POST** `/api/admin/livetv-buffer/reprovision`
- Reprovisiona todos os canais (usa defaults otimizados)

**GET** `/api/livetv-buffer/:channelId/status` (Público)
- Retorna status do buffer para player usar
- Não requer autenticação
- Campo `shouldDelayPlayback` indica se deve aguardar warmup

## Database Schema

```javascript
{
  channelId: String,              // ID único do canal
  channelTitle: String,           // Nome do canal
  enabled: Boolean,               // Buffer ativado?
  segmentDurationSec: Number,     // Duração de cada segmento (segundos)
  segmentCount: Number,           // Quantidade de segmentos no buffer
  warmupMode: 'on-demand'|'always-on',  // Tipo de warmup
  status: 'disabled'|'idle'|'warming'|'ready'|'error',
  lastWarmupAt: Date,
  lastReadyAt: Date,
  lastError: String,
  statusNote: String,
  createdAt: Date,
  updatedAt: Date
}
```

## Troubleshooting

**Vídeo ainda choppy?**
1. Verificar `GET /api/livetv-buffer/:channelId/status`
2. Se `status !== 'ready'`, aguardar warmup completar
3. Se persistir, aumentar `segmentCount` para 80-100

**Memória alta?**
1. Reduzir `segmentCount` para 40
2. Ou reduzir `segmentDurationSec` para 8

**Latência alta?**
1. Reduzir `segmentCount` para 40
2. Reduzir `segmentDurationSec` para 5

**Erros no warmup?**
1. Verificar logs do servidor
2. Testar provisioning manual: `POST /api/admin/livetv-buffer/reprovision`
