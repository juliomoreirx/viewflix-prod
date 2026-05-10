# Tempo de Transcode HLS - Referência

## ⏱️ Estimativas de Tempo

O transcode FFmpeg de Full HD (1920x1080 @ 5000kbps) depende de:
- **Duração do vídeo original**
- **Tamanho do arquivo**
- **Poder de processamento da CPU**
- **Velocidade do disco**

### Tabela de Referência

| Duração | Tamanho | Tempo Estimado (CPU 2-4 cores) | Tempo (CPU 8+ cores) |
|---------|---------|--------------------------------|----------------------|
| 23 min  | 500MB   | 3-5 minutos                    | 2-3 minutos          |
| 45 min  | 1GB     | 6-10 minutos                   | 4-6 minutos          |
| 1h 30m  | 2GB     | 12-20 minutos                  | 8-12 minutos         |
| 2h      | 3GB     | 18-30 minutos                  | 12-18 minutos        |
| 4h      | 6GB     | 35-60 minutos                  | 25-40 minutos        |

**Fórmula aproximada:**
```
Tempo ≈ (Duração em segundos × 0.5 até 1.0) / Número de cores CPU
```

### Exemplo da Log:

```
[HLS Pipeline] Starting VOD processing: 385658 (series)
[HLS Transcode] Starting: /tmp/viewflix-cache/385658-1778377681293.mp4
[HLS Transcode] FFmpeg process started with preset=medium, resolution=1920x1080, bitrate=5000k
```

**Depois disso, FFmpeg vai ficar **silencioso** por vários minutos processando.** Isso é NORMAL! ✅

```
[HLS Transcode] Progress: frame=1200 fps=45.5 q=28.0 Lsize=N/A time=00:00:50.00
[HLS Transcode] Progress: frame=2400 fps=42.0 q=28.0 Lsize=N/A time=00:01:40.00
```

Se vir logs assim, transcode está funcionando corretamente!

```
[HLS Transcode] Complete: 540 segments in /tmp/viewflix-cache/transcode/385658-1778377718130
```

**Pronto!** 540 segmentos = 9 minutos de vídeo (540 × 10s cada).

---

## 🎯 Sinais de Sucesso vs Erro

### ✅ Sucesso
```
[HLS Pipeline] Starting VOD processing: 385658 (series)
[HLS Transcode] FFmpeg process started...
[HLS Transcode] Complete: XXX segments in /tmp/...
[HLS Pipeline] Uploading to Bunny: 385658
[HLS Bunny Upload] Uploaded: index.m3u8 (1234 bytes)
[HLS Bunny Upload] Uploaded: 0000.ts (524288 bytes)
[HLS Pipeline] Complete: https://viewflixspace.b-cdn.net/content/series/...
```

### ❌ Erro - FFmpeg não encontrado
```
[HLS Transcode] Starting: undefined
[HLS Transcode] FFmpeg not found - install FFmpeg or set FFMPEG_PATH...
```
**Solução:** Instalar FFmpeg (ver INSTALL_FFMPEG.md)

### ❌ Erro - Arquivo muito grande (timeout)
```
[HLS Transcode] Progress: frame=500 fps=10 q=28
[... fica 30+ minutos sem progresso ...]
```
**Solução:** Aumentar timeout ou usar `-preset fast` em vez de `medium`

---

## 🔧 Se Transcode Demora Muito

### Opção 1: Usar preset mais rápido

Edite `src/services/hls-transcoder.service.js`:

```javascript
// Mude de:
'-preset', 'medium', // ~50% do tempo em tempo real

// Para:
'-preset', 'fast',   // ~25% do tempo em tempo real
// ou
'-preset', 'faster', // ~15% do tempo em tempo real
// ou
'-preset', 'ultrafast', // ~5% do tempo em tempo real (baixa qualidade)
```

**Trade-off:** Mais rápido = qualidade pior

### Opção 2: Reduzir resolução

```javascript
// Mude de:
this.targetResolution = '1920x1080';

// Para:
this.targetResolution = '1280x720'; // Metade dos pixels = ~4x mais rápido
```

### Opção 3: Reduzir bitrate

```javascript
// Mude de:
this.targetBitrate = '5000k';

// Para:
this.targetBitrate = '2500k'; // Metade do bitrate = ~2x mais rápido
```

---

## 📊 Performance Real na VPS

**CPU 2-core:**
- 1GB MP4 → ~10 minutos

**CPU 4-core:**
- 1GB MP4 → ~5 minutos

**CPU 8-core:**
- 1GB MP4 → ~3 minutos

**Com NVMe SSD + CPU 8-core:**
- 1GB MP4 → ~2 minutos

---

## 🎬 Parallelization

Se tiver múltiplos downloads simultâneos:

```javascript
// Em src/services/bunny-cache.service.js
BUNNY_CACHE_CONCURRENCY: 2  // Máximo 2 transcodes simultâneos
```

FFmpeg com `preset=medium` usa ~100-150% CPU.
- Com 2 cores → 1 transcode por vez
- Com 8 cores → até 4 transcodes simultâneos

---

## 💡 Status do Batch Download

Os logs mostram progresso assim:

```
1. Download MP4:          0% -----> 96%
2. Upload MP4 ao Bunny:   96% -----> 99%
3. Transcode para HLS:    99% -----> 99% (fica aqui por vários minutos!)
4. Upload HLS ao Bunny:   99% -----> 100%
```

**No passo 3, FFmpeg está processando. Espere!** ⏳

---

## 🚨 Se Ficar Travado

Se a log parar em `[HLS Transcode] Progress: ...` por > 1 hora:

1. **Verificar espaço em disco:**
   ```bash
   df -h /tmp
   # Precisa de pelo menos 2x o tamanho do MP4
   ```

2. **Verificar CPU:**
   ```bash
   top -p $(pgrep ffmpeg)
   # Deve mostrar uso de CPU > 80%
   ```

3. **Matar transcode travado:**
   ```bash
   killall ffmpeg
   # App vai reprocessar na próxima tentativa
   ```

4. **Aumentar timeout** em `.env`:
   ```env
   # Adicione:
   FFMPEG_TIMEOUT_MS=3600000  # 1 hora
   ```

---

## 📈 Otimização Recomendada para Produção

Para VPS típica (2-4 cores, 8GB RAM, SSD):

```javascript
// hls-transcoder.service.js
this.targetResolution = '1920x1080';    // ✅ Manter
this.targetBitrate = '4000k';           // ⬇️ Reduzir de 5000k
this.presetQuality = 'faster';          // ⬇️ Mudar de 'medium' para 'faster'
```

**Resultado:** 30-40% mais rápido, qualidade ainda ótima para streaming.

---

## ✅ Monitorar em Produção

Recomendação: adicione uma métrica de tempo médio de transcode:

```bash
# Ver média de tempo de transcode
grep "\[HLS Transcode\] Complete:" /var/log/viewflix/app.log \
  | awk -F'stage":"transcode' '{print $2}' \
  | tail -10
```

Se média > 20 minutos por GB, considere otimizar (reduzir bitrate/preset).
