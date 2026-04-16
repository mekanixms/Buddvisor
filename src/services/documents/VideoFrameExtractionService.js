const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const logger = require('../../utils/logger');

function execFileAsync(cmd, args, options = {}) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, options, (error, stdout, stderr) => {
      if (error) {
        error.stdout = stdout;
        error.stderr = stderr;
        return reject(error);
      }
      resolve({ stdout, stderr });
    });
  });
}

class VideoFrameExtractionService {
  /**
   * Extract a small set of representative frames for multimodal understanding.
   * Uses fps sampling; for short clips you still get up to maxFrames frames.
   */
  static async extractFrames(videoPath, options = {}) {
    const {
      maxFrames = 6,
      width = 768,
      fps = 0.2, // 1 frame every ~5s
    } = options;

    const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'video-frames-'));
    const outPattern = path.join(tmpDir, 'frame_%03d.jpg');

    // -vf fps=...,scale=...
    const args = [
      '-y',
      '-i', videoPath,
      '-vf', `fps=${fps},scale=${width}:-1`,
      '-frames:v', String(maxFrames),
      outPattern,
    ];

    await execFileAsync('ffmpeg', args, { timeout: 5 * 60 * 1000 });

    const files = (await fs.promises.readdir(tmpDir))
      .filter(f => f.toLowerCase().endsWith('.jpg'))
      .sort()
      .map(f => path.join(tmpDir, f));

    return { frames: files, tmpDir };
  }

  static async cleanup(tmpDir) {
    try {
      await fs.promises.rm(tmpDir, { recursive: true, force: true });
    } catch (e) {
      logger.warn(`Failed cleaning temp dir ${tmpDir}: ${e.message || e}`);
    }
  }
}

module.exports = VideoFrameExtractionService;

