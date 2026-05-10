const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs').promises;
const logger = require('../lib/logger');

/**
 * HLS Transcoder Service
 * Converts MP4 files to HLS format (m3u8 + ts segments)
 * Full HD (1920x1080) @ 5000kbps, 10s segments
 */

class HLSTranscoderService {
  constructor() {
    this.ffmpegPath = process.env.FFMPEG_PATH || 'ffmpeg';
    this.targetResolution = '1920x1080';
    this.targetBitrate = '5000k';
    this.segmentDuration = 10; // seconds
  }

  /**
   * Transcode MP4 to HLS
   * @param {string} inputPath - Path to MP4 file
   * @param {string} outputDir - Output directory for m3u8 + ts files
   * @returns {Promise<{success: boolean, outputDir: string, manifestPath: string, error?: string}>}
   */
  async transcodeToHLS(inputPath, outputDir) {
    try {
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

        ffmpeg.stdout.on('data', (data) => {
          stdout += data.toString();
        });

        ffmpeg.stderr.on('data', (data) => {
          stderr += data.toString();
          // Log progress
          if (stderr.includes('frame=')) {
            logger.debug(`[HLS Transcode] Progress: ${stderr.split('\n').slice(-2)[0]}`);
          }
        });

        ffmpeg.on('close', async (code) => {
          if (code !== 0) {
            logger.error(`[HLS Transcode] FFmpeg error (code ${code}):`, stderr);
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

            logger.info(
              `[HLS Transcode] Complete: ${tsFiles.length} segments in ${outputDir}`
            );

            resolve({
              success: true,
              outputDir,
              manifestPath,
              segmentCount: tsFiles.length,
              totalDuration: this.segmentDuration * tsFiles.length
            });
          } catch (err) {
            reject(err);
          }
        });

        ffmpeg.on('error', (err) => {
          logger.error('[HLS Transcode] Spawn error:', err);
          reject(err);
        });
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
