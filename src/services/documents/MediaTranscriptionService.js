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

  /**
   * Convert any audio file to 16 kHz mono WAV (required by Ollama multimodal audio via images field).
   */
  static async convertAudioToWav16kMono(audioPath) {
    const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'media-wav-'));
    const outPath = path.join(tmpDir, 'audio.wav');
    const args = ['-y', '-i', audioPath, '-vn', '-ac', '1', '-ar', '16000', outPath];
    await execFileAsync('ffmpeg', args, { timeout: 5 * 60 * 1000 });
    return { wavPath: outPath, tmpDir };
  }

  static extractOllamaMessageText(data) {
    const rawContent = data?.message?.content ?? data?.response ?? '';
    let content = '';
    if (typeof rawContent === 'string') content = rawContent.trim();
    else if (Array.isArray(rawContent)) {
      content = rawContent.map(c => (c?.text ?? c?.content ?? '')).join('').trim();
    } else {
      content = String(rawContent?.text ?? rawContent?.content ?? '').trim();
    }
    if (content) return content;

    const thinking = data?.message?.thinking;
    if (typeof thinking === 'string') {
      const t = thinking.trim();
      // Ignore Gemma channel markers with no real transcript in thinking.
      if (t.length > 20 && !/^<\|channel>/i.test(t)) return t;
    }
    return '';
  }

  /**
   * Transcribe via Ollama multimodal chat. Audio is sent as base64 WAV in messages[].images
   * (Ollama detects RIFF/WAVE magic bytes). Requires 16 kHz mono WAV.
   */
  static async transcribeAudioWithOllama(audioPath, options = {}) {
    const {
      baseURL = process.env.OLLAMA_BASE_URL || 'http://localhost:11434',
      model = process.env.OLLAMA_AUDIO_MODEL || 'gemma3:12b',
      maxTokens = 4000,
      prompt = 'Transcribe this audio verbatim. Output only the transcript text.',
    } = options;

    let wavPath = audioPath;
    let tmpDir = null;
    try {
      const converted = await this.convertAudioToWav16kMono(audioPath);
      wavPath = converted.wavPath;
      tmpDir = converted.tmpDir;

      const audioBase64 = fs.readFileSync(wavPath).toString('base64');
      const modelLower = String(model).toLowerCase();
      const requestBody = {
        model,
        stream: false,
        messages: [
          {
            role: 'user',
            content: prompt,
            images: [audioBase64],
          },
        ],
        options: {
          num_predict: maxTokens,
          temperature: 0.1,
        },
      };
      // Gemma 4 defaults to thinking mode for audio; disable for transcription.
      if (modelLower.includes('gemma')) {
        requestBody.options.thinking = false;
        requestBody.think = false;
      }

      const wavStat = fs.statSync(wavPath);
      logger.info(
        `Ollama audio request: model=${model} wav_bytes=${wavStat.size} base64_chars=${audioBase64.length}`
      );

      const res = await fetch(`${String(baseURL).replace(/\/$/, '')}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(requestBody),
      });

      if (!res.ok) {
        let detail = '';
        try {
          const j = await res.json();
          detail = j?.error || j?.message || JSON.stringify(j);
        } catch {
          try {
            detail = await res.text();
          } catch {
            detail = '';
          }
        }
        throw new Error(`Ollama audio request failed (${res.status}): ${detail || res.statusText}`);
      }

      const data = await res.json();
      const text = this.extractOllamaMessageText(data);
      const contentLen = String(data?.message?.content || '').length;
      const thinkingPreview = String(data?.message?.thinking || '').slice(0, 120);
      if (!text) {
        logger.warn(
          `Ollama audio transcription returned empty text: model=${model} ` +
            `content_len=${contentLen} thinking_preview=${JSON.stringify(thinkingPreview)} ` +
            `eval_count=${data?.eval_count ?? '?'} done_reason=${data?.done_reason ?? '?'}`
        );
      } else {
        logger.info(
          `Ollama audio transcription ok: model=${model} chars=${text.length} eval_count=${data?.eval_count ?? '?'}`
        );
      }
      return {
        text,
        metadata: {
          type: 'audio',
          transcriber: 'ollama',
          model,
          baseURL,
          ...(text ? {} : { error: 'Ollama returned empty transcript (see server logs)' }),
        },
      };
    } finally {
      if (tmpDir) {
        try {
          await fs.promises.rm(tmpDir, { recursive: true, force: true });
        } catch (e) {
          logger.warn(`Failed cleaning temp dir ${tmpDir}: ${e.message || e}`);
        }
      }
    }
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

    try {
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
    } catch (err) {
      const errMsg = err?.message || String(err);
      logger.error(`Whisper transcription failed: ${errMsg}`);
      return {
        text: '',
        metadata: {
          type: 'audio',
          transcriber: 'whisper',
          model,
          error: errMsg,
        },
      };
    }
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

