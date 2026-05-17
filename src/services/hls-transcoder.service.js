const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs').promises;
const { execSync } = require('child_process');
const logger = require('../lib/logger');

/**
 * HLS Remuxer Service
 * Converts MP4 files to HLS format (m3u8 + ts segments) via remuxing (transmuxing)
 * Copies video/audio streams as-is without re-encoding → preserves original quality + ~50-100x faster
 * 10s segments, original bitrate/resolution maintained
 */

class HLSTranscoderService {
  constructor() {
    this.ffmpegPath = this._detectFFmpegPath();
    // 🚀 CORREÇÃO FFPROBE: Resolve dinamicamente o path do ffprobe baseado no ffmpeg
    this.ffprobePath = this.ffmpegPath ? this.ffmpegPath.replace(/ffmpeg(\.exe)?$/, 'ffprobe$1') : 'ffprobe';
    this.segmentDuration = 10; // seconds (remuxing preserves original resolution/bitrate)
    
    if (this.ffmpegPath) {
      logger.info(`[HLS Remux] FFmpeg found at: ${this.ffmpegPath}`);
    } else {
      logger.warn('[HLS Remux] FFmpeg not found - HLS transcode will fail');
    }
  }

  /**
   * Detect FFmpeg path
   * @private
   */
  _detectFFmpegPath() {
    const envPath = process.env.FFMPEG_PATH;
    if (envPath && this._checkCommand(envPath)) {
      return envPath;
    }

    const commonPaths = [
      '/usr/bin/ffmpeg',
      '/usr/local/bin/ffmpeg',
      '/opt/homebrew/bin/ffmpeg',
      '/usr/local/Cellar/ffmpeg/*/bin/ffmpeg'
    ];

    for (const p of commonPaths) {
      if (this._checkCommand(p)) {
        return p;
      }
    }

    try {
      const result = execSync('which ffmpeg', { encoding: 'utf8' }).trim();
      if (result) return result;
    } catch (e) {}

    const winPaths = [
      'C:\\ffmpeg\\bin\\ffmpeg.exe',
      'C:\\Program Files\\ffmpeg\\bin\\ffmpeg.exe',
      'ffmpeg.exe'
    ];

    for (const p of winPaths) {
      if (this._checkCommand(p)) {
        return p;
      }
    }

    return null;
  }

  /**
   * Check if command exists
   * @private
   */
  _checkCommand(cmd) {
    try {
      execSync(`${cmd} -version`, { stdio: 'ignore' });
      return true;
    } catch (e) {
      return false;
    }
  }

  /**
   * Transcode MP4 to HLS (Otimizado para VPS Shared de Baixo Custo)
   */
  async transcodeToHLS(inputPath, outputDir) {
    try {
      if (!inputPath || inputPath === 'undefined') {
        throw new Error('Invalid input path');
      }

      if (!this.ffmpegPath) {
        throw new Error('FFmpeg not found - install FFmpeg or set FFMPEG_PATH environment variable');
      }

      logger.info(`[HLS Remux] Starting: ${inputPath}`);

      try {
        const stats = await fs.stat(inputPath);
        if (!stats.isFile()) {
          throw new Error(`Input path is not a file: ${inputPath}`);
        }
        logger.info(`[HLS Remux] ✅ Input file verified: ${(stats.size / 1024 / 1024).toFixed(2)}MB`);
      } catch (err) {
        throw new Error(`Cannot read input file: ${err.message}`);
      }

      await fs.mkdir(outputDir, { recursive: true });

      const manifestPath = path.join(outputDir, 'index.m3u8');
      const segmentPattern = path.join(outputDir, '%04d.ts');

      // 🚀 ARGS CONFIGURAÇÃO FORMULA 1 (Remux Total e Blindagem de Thread)
      const ffmpegArgs = [
        '-y',                  // Sobrescreve sem perguntar
        '-nostdin',            // Impede travamento em background
        '-i', inputPath,
        '-map', '0:V:0',       // Captura estritamente a trilha principal de vídeo
        '-map', '0:a:0?',      // Captura estritamente a trilha principal de áudio
        '-c:v', 'copy',        // Copia o fluxo de vídeo instantaneamente (Sem re-encoding)
        '-c:a', 'copy',        // 🚀 OTIMIZAÇÃO SUPREMA: Copia o áudio original diretamente. Remove o gargalo de CPU!
        '-threads', '1',       // 🚀 BLINDAGEM DE VPS: Fixado em 1 thread para não sofrer limitação da Digital Ocean
        '-sn',                 // Remove legendas embutidas causadoras de fragParsingError
        '-dn',                 // Remove pacotes de dados desnecessários
        '-f', 'hls',
        '-hls_time', this.segmentDuration.toString(),
        '-hls_list_size', '0',
        '-hls_segment_filename', segmentPattern,
        manifestPath
      ];

      const envTimeout = parseInt(process.env.FFMPEG_TIMEOUT_MS || '300000', 10); // Reduzido para 5 minutos padrão
      const factorMsPerSec = parseInt(process.env.FFMPEG_TIMEOUT_FACTOR_MS_PER_SEC || '500', 10); 
      let computedTimeout = envTimeout;
      
      try {
        const durationSec = await this.getVideoDuration(inputPath);
        if (durationSec && durationSec > 0) {
          const byDuration = Math.ceil(durationSec * factorMsPerSec);
          computedTimeout = Math.max(envTimeout, byDuration);
          logger.info(`[HLS Remux] Calculated FFmpeg timeout ${computedTimeout}ms based on duration ${Math.round(durationSec)}s`);
        }
      } catch (err) {
        logger.warn(`[HLS Remux] ffprobe failed to get duration, using default timeout: ${err.message}`);
      }

      return new Promise((resolve, reject) => {
        const ffmpeg = spawn(this.ffmpegPath, ffmpegArgs);
        let stderr = '';
        let stdout = '';
        let lastProgressLog = 0;
        let lastHeartbeatLog = Date.now();
        let lastFrameCount = 0;
        let stallCounter = 0;
        const ffmpegStartTime = Date.now();

        const ffmpegTimeout = computedTimeout;
        let timeoutHandle = setTimeout(() => {
          logger.error(`[HLS Remux] FFmpeg timeout after ${ffmpegTimeout}ms - killing process`);
          try { ffmpeg.kill('SIGKILL'); } catch (e) {}
          reject(new Error(`FFmpeg transcode timeout after ${ffmpegTimeout}ms`));
        }, ffmpegTimeout);

        ffmpeg.stdout.on('data', (data) => {
          stdout += data.toString();
        });

        ffmpeg.stderr.on('data', (data) => {
          const text = data.toString();
          stderr += text;
          const now = Date.now();
          
          if (text.includes('error') || text.includes('Error') || text.includes('ERROR')) {
            logger.error(`[HLS Remux] FFmpeg error output: ${text.trim()}`);
          }

          if (now - lastHeartbeatLog > 15000) {
            lastHeartbeatLog = now;
            const timeMatch = text.match(/time=(\d+):(\d+):([0-9.]+)/);
            let currentTimeStr = 'Processando...';
            if (timeMatch) {
              currentTimeStr = `${timeMatch[1]}h ${timeMatch[2]}m ${Math.floor(parseFloat(timeMatch[3]))}s`;
            }
            const elapsedMins = ((now - ffmpegStartTime) / 60000).toFixed(1);
            logger.info(`[HLS Remux] ⏳ Processo ATIVO (${elapsedMins}m passados). Copiando blocos: ${currentTimeStr}`);
          }
          
          const frameMatch = text.match(/frame=\s*(\d+)/);
          if (frameMatch) {
            const currentFrame = parseInt(frameMatch[1], 10);
            
            if ((now - lastProgressLog) > 2000) {
              lastProgressLog = now;
              const elapsedSecs = Math.round((now - ffmpegStartTime) / 1000);
              const fpsMatch = text.match(/fps=\s*([0-9.]+)/);
              const fps = fpsMatch ? parseFloat(fpsMatch[1]) : 0;
              const timeMatch = text.match(/time=(\d+):(\d+):([0-9.]+)/);
              let currentTime = 'N/A';
              if (timeMatch) {
                const h = parseInt(timeMatch[1]);
                const m = parseInt(timeMatch[2]);
                const s = parseFloat(timeMatch[3]);
                currentTime = `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(Math.floor(s)).padStart(2, '0')}`;
              }
              
              const bitrate = text.match(/bitrate=\s*([0-9.]+kbits\/s)/) ? text.match(/bitrate=\s*([0-9.]+kbits\/s)/)[1] : 'N/A';
              const speed = text.match(/speed=\s*([0-9.]+x)/) ? text.match(/speed=\s*([0-9.]+x)/)[1] : 'N/A';
              
              logger.info(
                `[HLS Remux] ⏱️ ${elapsedSecs}s | 📺 Frame: ${currentFrame} | ⚡ Speed Copy: ${speed} | 🎬 Time: ${currentTime}`
              );

              if (currentFrame === lastFrameCount && lastFrameCount > 0) {
                stallCounter++;
                logger.warn(`[HLS Remux] ⚠️ Stall detected! Frame stuck at ${currentFrame} (${stallCounter}/4)`);
                
                if (stallCounter >= 4) {
                  logger.error(`[HLS Remux] 💥 FFmpeg stalled for too long - killing process`);
                  ffmpeg.kill('SIGKILL');
                  clearTimeout(timeoutHandle);
                  reject(new Error(`FFmpeg stalled at frame ${currentFrame}`));
                  return;
                }
              } else {
                stallCounter = 0;
                lastFrameCount = currentFrame;
              }
            }
          }
        });

        ffmpeg.on('close', async (code) => {
          clearTimeout(timeoutHandle);
          const elapsedMs = Date.now() - ffmpegStartTime;
          const elapsedSecs = Math.round(elapsedMs / 1000);
          
          if (code !== 0) {
            let errorMsg = 'Unknown error';
            if (stderr) {
              const errorPatterns = [
                /Unknown codec/i,
                /Decoder .* not found/i,
                /Input\/output error/i,
                /Permission denied/i,
                /No such file or directory/i,
                /Invalid data found/i,
                /not a valid/i
              ];
              
              for (const pattern of errorPatterns) {
                const match = stderr.match(pattern);
                if (match) {
                  errorMsg = match[0];
                  break;
                }
              }
              
              if (errorMsg === 'Unknown error' && stderr.length > 0) {
                errorMsg = stderr.substring(Math.max(0, stderr.length - 500));
              }
            }
            
            logger.error(`[HLS Remux] 💥 FFmpeg error (code ${code}, ${elapsedSecs}s)`);
            logger.error(`[HLS Remux] ❌ Error detail: ${errorMsg}`);
            return reject(new Error(`FFmpeg transcode failed: ${errorMsg}`));
          }

          try {
            const files = await fs.readdir(outputDir);
            const tsFiles = files.filter(f => f.endsWith('.ts'));
            const hasManifest = files.includes('index.m3u8');

            if (!hasManifest || tsFiles.length === 0) {
              throw new Error('Transcode completed but output files missing');
            }

            const totalSize = (await Promise.all(
              tsFiles.map(f => fs.stat(path.join(outputDir, f)).then(s => s.size).catch(() => 0))
            )).reduce((a, b) => a + b, 0);

            const totalMB = (totalSize / 1024 / 1024).toFixed(2);
            logger.info(`[HLS Remux] ✅ Remux concluído com sucesso em ${elapsedSecs}s! Volume final: ${totalMB}MB`);

            resolve({
              success: true,
              outputDir,
              manifestPath,
              segmentCount: tsFiles.length,
              totalDuration: this.segmentDuration * tsFiles.length,
              totalSize,
              elapsedMs
            });
          } catch (err) {
            reject(err);
          }
        });

        ffmpeg.on('error', (err) => {
          clearTimeout(timeoutHandle);
          logger.error('[HLS Remux] Spawn error:', err);
          reject(err);
        });
      });
    } catch (error) {
      logger.error('[HLS Remux] Error:', error);
      throw error;
    }
  }

  async getVideoDuration(filePath) {
    return new Promise((resolve, reject) => {
      const probeCmd = this.ffprobePath || 'ffprobe';
      const ffprobeArgs = [
        '-v', 'error',
        '-show_entries', 'format=duration',
        '-of', 'default=noprint_wrappers=1:nokey=1:noesc=1',
        filePath
      ];

      const ffprobe = spawn(probeCmd, ffprobeArgs);
      let output = '';

      ffprobe.stdout.on('data', (data) => {
        output += data.toString();
      });

      ffprobe.on('close', (code) => {
        if (code === 0 && output) {
          const duration = parseFloat(output.trim());
          resolve(duration);
        } else {
          reject(new Error('ffprobe failed'));
        }
      });

      ffprobe.on('error', reject);
    });
  }

  async getVideoInfo(filePath) {
    return new Promise((resolve, reject) => {
      const probeCmd = this.ffprobePath || 'ffprobe';
      const ffprobeArgs = [
        '-v', 'error',
        '-show_format',
        '-show_streams',
        '-print_format', 'json',
        filePath
      ];

      const ffprobe = spawn(probeCmd, ffprobeArgs);
      let output = '';

      ffprobe.stdout.on('data', (data) => {
        output += data.toString();
      });

      ffprobe.on('close', (code) => {
        if (code === 0 && output) {
          try {
            const data = JSON.parse(output);
            resolve({
              duration: data.format?.duration ? parseFloat(data.format.duration) : null,
              bitrate: data.format?.bit_rate ? parseInt(data.format.bit_rate) : null,
              size: data.format?.size ? parseInt(data.format.size) : null,
              streams: data.streams || []
            });
          } catch (err) {
            reject(err);
          }
        } else {
          reject(new Error('ffprobe failed'));
        }
      });

      ffprobe.on('error', reject);
    });
  }

  async cleanup(outputDir) {
    try {
      const files = await fs.readdir(outputDir);
      for (const file of files) {
        await fs.unlink(path.join(outputDir, file));
      }
      await fs.rmdir(outputDir);
      logger.info(`[HLS Remux] Cleaned up: ${outputDir}`);
    } catch (error) {
      logger.warn(`[HLS Remux] Cleanup warning: ${error.message}`);
    }
  }
}

module.exports = new HLSTranscoderService();