const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const OpenAI = require('openai');
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

class MediaTranscriptionService {
  static getDefaultApiKey() {
    return process.env.OPENAI_API_KEY || null;
  }

  static async transcribeAudioWithWhisper(audioPath, options = {}) {
    const { apiKey = this.getDefaultApiKey(), model = 'whisper-1' } = options;

    if (!apiKey) {
      return {
        text: '',
        metadata: {
          type: 'audio',
          transcriber: 'whisper',
          model,
          error: 'OPENAI_API_KEY not configured',
        },
      };
    }

    const client = new OpenAI({ apiKey });
    const fileStream = fs.createReadStream(audioPath);

    const result = await client.audio.transcriptions.create({
      file: fileStream,
      model,
    });

    const text = (result?.text || '').trim();
    return {
      text,
      metadata: {
        type: 'audio',
        transcriber: 'whisper',
        model,
      },
    };
  }

  static async extractAudioFromVideoToWav(videoPath) {
    const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'media-audio-'));
    const outPath = path.join(tmpDir, 'audio.wav');

    // 16kHz mono WAV is a good default for transcription.
    const args = [
      '-y',
      '-i', videoPath,
      '-vn',
      '-ac', '1',
      '-ar', '16000',
      outPath,
    ];

    await execFileAsync('ffmpeg', args, { timeout: 5 * 60 * 1000 });

    return { wavPath: outPath, tmpDir };
  }

  static async transcribeVideoWithWhisper(videoPath, options = {}) {
    const { wavPath, tmpDir } = await this.extractAudioFromVideoToWav(videoPath);
    try {
      const result = await this.transcribeAudioWithWhisper(wavPath, options);
      return {
        text: result.text,
        metadata: {
          type: 'video',
          ...result.metadata,
        },
      };
    } finally {
      try {
        await fs.promises.rm(tmpDir, { recursive: true, force: true });
      } catch (e) {
        logger.warn(`Failed cleaning temp dir ${tmpDir}: ${e.message || e}`);
      }
    }
  }
}

module.exports = MediaTranscriptionService;

