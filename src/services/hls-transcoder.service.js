const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs').promises;
const { execSync } = require('child_process');
const logger = require('../lib/logger');

/**
 * HLS Transcoder Service
 * Converts MP4 files to HLS format (m3u8 + ts segments)
 * Full HD (1920x1080) @ 5000kbps, 10s segments
 */

class HLSTranscoderService {
  constructor() {
    this.ffmpegPath = this._detectFFmpegPath();
    this.targetResolution = '1920x1080';
    this.targetBitrate = '5000k';
    this.segmentDuration = 10; // seconds
    
    if (this.ffmpegPath) {
      logger.info(`[HLS Transcode] FFmpeg found at: ${this.ffmpegPath}`);
    } else {
      logger.warn('[HLS Transcode] FFmpeg not found - HLS transcode will fail');
    }
  }

  /**
   * Detect FFmpeg path
   * @private
   */
  _detectFFmpegPath() {
    // Try environment variable first
    const envPath = process.env.FFMPEG_PATH;
    if (envPath && this._checkCommand(envPath)) {
      return envPath;
    }

    // Try common Linux/Mac paths
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

    // Try 'ffmpeg' in PATH
    try {
      const result = execSync('which ffmpeg', { encoding: 'utf8' }).trim();
      if (result) return result;
    } catch (e) {}

    // Try Windows paths
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
   * Transcode MP4 to HLS
   * @param {string} inputPath - Path to MP4 file
   * @param {string} outputDir - Output directory for m3u8 + ts files
   * @returns {Promise<{success: boolean, outputDir: string, manifestPath: string, error?: string}>}
   */
  async transcodeToHLS(inputPath, outputDir) {
    try {
      if (!inputPath || inputPath === 'undefined') {
        throw new Error('Invalid input path');
      }

      if (!this.ffmpegPath) {
        throw new Error('FFmpeg not found - install FFmpeg or set FFMPEG_PATH environment variable');
      }

      logger.info(`[HLS Transcode] Starting: ${inputPath}`);

      // Ensure output directory exists
      await fs.mkdir(outputDir, { recursive: true });

      const manifestPath = path.join(outputDir, 'index.m3u8');
      const segmentPattern = path.join(outputDir, '%04d.ts');

      // FFmpeg command for HLS transcoding
      // -i: input file
      // -c:v libx264: H.264 video codec
      // -s: scale to resolution
      // -b:v: bitrate
      // -c:a aac: AAC audio codec
      // -b:a 128k: audio bitrate
      // -f hls: HLS format
      // -hls_time: segment duration
      // -hls_list_size 0: keep all segments in manifest
      // -hls_segment_filename: output segment naming
      const ffmpegArgs = [
        '-i', inputPath,
        '-c:v', 'libx264',
        '-preset', 'medium', // balance speed/quality
        '-s', this.targetResolution,
        '-b:v', this.targetBitrate,
        '-maxrate', this.targetBitrate,
        '-bufsize', '10000k',
        '-c:a', 'aac',
        '-b:a', '128k',
        '-ar', '48000',
        '-f', 'hls',
        '-hls_time', this.segmentDuration.toString(),
        '-hls_list_size', '0',
        '-hls_segment_filename', segmentPattern,
        manifestPath
      ];

      return new Promise((resolve, reject) => {
        const ffmpeg = spawn(this.ffmpegPath, ffmpegArgs);
        let stderr = '';
        let stdout = '';
        let lastProgressLog = 0;
        let lastFrameCount = 0;
        let stallCounter = 0;
        const ffmpegStartTime = Date.now();

        // Timeout para FFmpeg travado (default 30 minutos)
        const ffmpegTimeout = parseInt(process.env.FFMPEG_TIMEOUT_MS || '1800000', 10);
        let timeoutHandle = setTimeout(() => {
          logger.error(`[HLS Transcode] FFmpeg timeout after ${ffmpegTimeout}ms - killing process`);
          ffmpeg.kill('SIGKILL');
          reject(new Error(`FFmpeg transcode timeout after ${ffmpegTimeout}ms`));
        }, ffmpegTimeout);

        ffmpeg.stdout.on('data', (data) => {
          stdout += data.toString();
        });

        ffmpeg.stderr.on('data', (data) => {
          stderr += data.toString();
          
          // Extract frame count for stall detection
          const frameMatch = stderr.match(/frame=\s*(\d+)/);
          if (frameMatch) {
            const currentFrame = parseInt(frameMatch[1], 10);
            const now = Date.now();
            
            // Log progress every 2 seconds
            if ((now - lastProgressLog) > 2000) {
              lastProgressLog = now;
              const elapsedSecs = Math.round((now - ffmpegStartTime) / 1000);
              const fpsMatch = stderr.match(/fps=\s*([0-9.]+)/);
              const fps = fpsMatch ? parseFloat(fpsMatch[1]) : 0;
              const timeMatch = stderr.match(/time=(\d+):(\d+):([0-9.]+)/);
              let currentTime = 'N/A';
              if (timeMatch) {
                const h = parseInt(timeMatch[1]);
                const m = parseInt(timeMatch[2]);
                const s = parseFloat(timeMatch[3]);
                currentTime = `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(Math.floor(s)).padStart(2, '0')}`;
              }
              
              const bitrate = stderr.match(/bitrate=\s*([0-9.]+kbits\/s)/) ? stderr.match(/bitrate=\s*([0-9.]+kbits\/s)/)[1] : 'N/A';
              const speed = stderr.match(/speed=\s*([0-9.]+x)/) ? stderr.match(/speed=\s*([0-9.]+x)/)[1] : 'N/A';
              
              logger.info(
                `[HLS Transcode] ⏱️ ${elapsedSecs}s | 📺 Frame: ${currentFrame} | ⚡ ${fps} fps | 🎬 Time: ${currentTime} | 📊 ${bitrate} | 🚀 ${speed}`
              );

              // Detect stall: if frame count didn't increase
              if (currentFrame === lastFrameCount && lastFrameCount > 0) {
                stallCounter++;
                logger.warn(`[HLS Transcode] ⚠️ Stall detected! Frame stuck at ${currentFrame} (${stallCounter}/4)`);
                
                if (stallCounter >= 4) {
                  logger.error(`[HLS Transcode] 💥 FFmpeg stalled for too long - killing process`);
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
            logger.error(`[HLS Transcode] 💥 FFmpeg error (code ${code}, ${elapsedSecs}s):`, stderr.slice(-500));
            return reject(new Error(`FFmpeg transcode failed: ${stderr}`));
          }

          try {
            // Verify output files exist
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
            const avgBitrate = ((totalSize * 8) / elapsedMs / 1000).toFixed(2);

            logger.info(
              `[HLS Transcode] ✅ Complete in ${elapsedSecs}s | 📦 ${tsFiles.length} segments | 💾 ${totalMB}MB | 📊 ${avgBitrate}kbps avg`
            );

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
          logger.error('[HLS Transcode] Spawn error:', err);
          reject(err);
        });

        // Log start
        logger.info(`[HLS Transcode] 🚀 FFmpeg process started | preset=medium | ${this.targetResolution} @ ${this.targetBitrate} | segments=${this.segmentDuration}s`);
      });
    } catch (error) {
      logger.error('[HLS Transcode] Error:', error);
      throw error;
    }
  }

  /**
   * Get video duration in seconds
   * @param {string} filePath - Path to video file
   * @returns {Promise<number>} Duration in seconds
   */
  async getVideoDuration(filePath) {
    return new Promise((resolve, reject) => {
      const ffprobeArgs = [
        '-v', 'error',
        '-show_entries', 'format=duration',
        '-of', 'default=noprint_wrappers=1:nokey=1:noesc=1',
        filePath
      ];

      const ffprobe = spawn('ffprobe', ffprobeArgs);
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

  /**
   * Get video info (codec, resolution, bitrate, duration)
   * @param {string} filePath - Path to video file
   * @returns {Promise<object>} Video information
   */
  async getVideoInfo(filePath) {
    return new Promise((resolve, reject) => {
      const ffprobeArgs = [
        '-v', 'error',
        '-show_format',
        '-show_streams',
        '-print_format', 'json',
        filePath
      ];

      const ffprobe = spawn('ffprobe', ffprobeArgs);
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

  /**
   * Clean up transcoded files
   * @param {string} outputDir - Directory to clean
   * @returns {Promise<void>}
   */
  async cleanup(outputDir) {
    try {
      const files = await fs.readdir(outputDir);
      for (const file of files) {
        await fs.unlink(path.join(outputDir, file));
      }
      await fs.rmdir(outputDir);
      logger.info(`[HLS Transcode] Cleaned up: ${outputDir}`);
    } catch (error) {
      logger.warn(`[HLS Transcode] Cleanup warning: ${error.message}`);
    }
  }
}

module.exports = new HLSTranscoderService();
