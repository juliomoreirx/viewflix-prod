# Instalar FFmpeg

## Para Ubuntu/Debian

```bash
sudo apt-get update
sudo apt-get install -y ffmpeg
```

Verificar instalação:
```bash
ffmpeg -version
```

## Para Amazon Linux 2 / RHEL

```bash
sudo yum install -y ffmpeg
```

## Para macOS

```bash
brew install ffmpeg
```

## Verificar se está no PATH

```bash
which ffmpeg
# Deve retornar algo como: /usr/bin/ffmpeg
```

---

## Configuração no `.env`

Se FFmpeg está em um local não-padrão, defina:

```env
FFMPEG_PATH=/caminho/customizado/para/ffmpeg
```

Exemplos:
```
# Linux padrão (automático)
FFMPEG_PATH=ffmpeg

# Caminho customizado
FFMPEG_PATH=/usr/local/bin/ffmpeg
FFMPEG_PATH=/opt/ffmpeg/bin/ffmpeg
```

---

## Teste Rápido

Após instalar, execute:

```bash
ffmpeg -f lavfi -i color=c=blue:s=1920x1080:d=1 -c:v libx264 -preset medium -b:v 5000k -hls_time 10 test.m3u8
```

Isso criará um vídeo de teste em HLS. Se funcionar, FFmpeg está OK!

---

## Se tiver problema na VPS

1. **Verificar permissões:**
```bash
ls -la /usr/bin/ffmpeg
chmod +x /usr/bin/ffmpeg
```

2. **Verificar versão:**
```bash
ffmpeg -version
# Deve ser versão recente (4.x ou 5.x+)
```

3. **Se não tiver libx264:**
```bash
# Debian/Ubuntu
sudo apt-get install -y libx264-dev

# Amazon Linux 2
sudo yum install -y x264-devel
```

4. **Recompile se necessário:**
```bash
# Ubuntu
sudo apt-get remove ffmpeg
sudo apt-get install -y autoconf automake build-essential libass-dev libfreetype6-dev libsdl2-dev libtheora-dev libtool libva-dev libvorbis-dev libvpx-dev libx264-dev libx265-dev libxcb1-dev libxcb-shm0-dev libxcb-xfixes0-dev pkg-config texinfo wget zlib1g-dev

# Clone e compile
git clone https://git.ffmpeg.org/ffmpeg.git ffmpeg
cd ffmpeg
./configure --enable-gpl --enable-libx264 --enable-libx265
make -j$(nproc)
sudo make install
```

---

## Logs do Node

Após instalar FFmpeg e reiniciar a app, procure por:

```
[HLS Transcode] FFmpeg found at: /usr/bin/ffmpeg
```

Se não aparecer, significa que FFmpeg não foi detectado.

Para debug, adicione no `.env`:
```
DEBUG=hls-transcode:*
```

---

## Espaço em Disco Requerido

- **MP4 original**: tamanho do arquivo
- **Transcode temporário**: ~20-30% maior que MP4
- **Resultado HLS**: ~80% do tamanho MP4

**Exemplo**: Um arquivo de 2GB vai precisar de ~4GB de espaço livre durante o processo.

Monitore com:
```bash
df -h /tmp  # ou onde estiver BUNNY_TEMP_DIR
```
