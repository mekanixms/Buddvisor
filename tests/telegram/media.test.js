const {
  extractAttachment,
  extractOutboundMedia,
  normalizeMime,
  sanitizeFilename,
  formatBytes,
  telegramUploadMethod,
} = require('../../src/services/telegram/TelegramMedia');

describe('extractAttachment', () => {
  test('returns null for plain text and unsupported kinds', () => {
    expect(extractAttachment({ text: 'hi' })).toBeNull();
    expect(extractAttachment({ sticker: { file_id: 's' } })).toBeNull();
    expect(extractAttachment({ photo: [{}] })).toBeNull();
    expect(extractAttachment(null)).toBeNull();
  });

  test('picks the largest photo size and names it as a JPEG', () => {
    const a = extractAttachment({
      date: 1700000000,
      photo: [
        { file_id: 'a', width: 100, height: 100 },
        { file_id: 'c', file_unique_id: 'XyZ_12345', width: 2000, height: 1500 },
        { file_id: 'b', width: 800, height: 600 },
      ],
    });
    expect(a).toMatchObject({ kind: 'photo', fileId: 'c', mimeType: 'image/jpeg' });
    expect(a.filename).toBe('photo_20231114_221320_XyZ123.jpg');
  });

  test('keeps the original file name of a document and appends a missing extension', () => {
    expect(extractAttachment({ document: { file_id: 'd', file_name: 'report.xlsx', mime_type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' } }))
      .toMatchObject({ filename: 'report.xlsx' });
    expect(extractAttachment({ document: { file_id: 'd', file_name: 'notes', mime_type: 'text/plain' } }))
      .toMatchObject({ filename: 'notes.txt', mimeType: 'text/plain' });
  });

  test('infers the MIME type from the extension when Telegram sends a generic one', () => {
    expect(extractAttachment({ document: { file_id: 'd', file_name: 'a.pdf', mime_type: 'application/octet-stream' } }).mimeType)
      .toBe('application/pdf');
    expect(extractAttachment({ document: { file_id: 'd', file_name: 'a.pdf' } }).mimeType).toBe('application/pdf');
  });

  test('generates names for videos, animations, video notes and audio', () => {
    const base = { date: 1700000000 };
    expect(extractAttachment({ ...base, video: { file_id: 'v', mime_type: 'video/mp4' } }).filename).toMatch(/^video_20231114_221320\.mp4$/);
    expect(extractAttachment({ ...base, animation: { file_id: 'g' } })).toMatchObject({ kind: 'animation', mimeType: 'video/mp4' });
    expect(extractAttachment({ ...base, video_note: { file_id: 'n' } })).toMatchObject({ kind: 'video_note', mimeType: 'video/mp4' });
    expect(extractAttachment({ ...base, audio: { file_id: 'a', mime_type: 'audio/mpeg' } }).filename).toMatch(/\.mp3$/);
    expect(extractAttachment({ ...base, voice: { file_id: 'o', file_unique_id: 'VOICE1' } })).toMatchObject({
      kind: 'voice', mimeType: 'audio/ogg', filename: 'audio_20231114_221320_VOICE1.ogg',
    });
  });

  test('reports the declared size', () => {
    expect(extractAttachment({ document: { file_id: 'd', file_name: 'a.txt', file_size: 12 } }).fileSize).toBe(12);
    expect(extractAttachment({ document: { file_id: 'd', file_name: 'a.txt' } }).fileSize).toBeNull();
  });
});

describe('helpers', () => {
  test('normalizeMime maps aliases and strips parameters', () => {
    expect(normalizeMime('image/jpg')).toBe('image/jpeg');
    expect(normalizeMime('Audio/X-M4A; codecs=mp4a')).toBe('audio/mp4');
  });

  test('sanitizeFilename removes path separators and leading dots', () => {
    expect(sanitizeFilename('../../etc/passwd')).toBe('_.._etc_passwd');
    expect(sanitizeFilename('.hidden.txt')).toBe('hidden.txt');
    const long = sanitizeFilename(`${'a'.repeat(300)}.pdf`);
    expect(long.length).toBe(120);
    expect(long.endsWith('.pdf')).toBe(true);
  });

  test('formatBytes', () => {
    expect(formatBytes(500)).toBe('500 B');
    expect(formatBytes(2048)).toBe('2.0 KB');
    expect(formatBytes(5 * 1024 * 1024)).toBe('5.0 MB');
  });

  test('telegramUploadMethod picks a photo for an inline image and a document otherwise', () => {
    expect(telegramUploadMethod('image/jpeg', 1000)).toEqual({ method: 'sendPhoto', field: 'photo' });
    expect(telegramUploadMethod('image/jpeg', 11 * 1024 * 1024)).toEqual({ method: 'sendDocument', field: 'document' });
    expect(telegramUploadMethod('video/mp4', 1000)).toEqual({ method: 'sendVideo', field: 'video' });
    expect(telegramUploadMethod('audio/ogg', 1000)).toEqual({ method: 'sendAudio', field: 'audio' });
    expect(telegramUploadMethod('application/zip', 1000)).toEqual({ method: 'sendDocument', field: 'document' });
  });
});

describe('extractOutboundMedia', () => {
  const payload = Buffer.alloc(40, 7).toString('base64');

  test('lifts an HTML attachment card into a file and drops the card text', () => {
    const html = `<div class="card"><h2>trigRatios.jpeg</h2><p class="desc">Rendered directly from assigned session storage</p><img src="data:image/jpeg;base64,${payload}"></div>`;
    const { text, files } = extractOutboundMedia(html);
    expect(text).toBe('');
    expect(files).toHaveLength(1);
    expect(files[0].filename).toBe('trigRatios.jpeg');
    expect(files[0].mimeType).toBe('image/jpeg');
    expect(files[0].buffer.equals(Buffer.alloc(40, 7))).toBe(true);
  });

  test('keeps the prose around an html fence and still extracts the file', () => {
    const content = `Here is the chart.\n\n\`\`\`html\n<h2>trigRatios.jpeg</h2>\n<img src="data:image/jpeg;base64,${payload}">\n\`\`\``;
    const { text, files } = extractOutboundMedia(content);
    expect(text).toBe('Here is the chart.');
    expect(files[0].filename).toBe('trigRatios.jpeg');
  });

  test('leaves ordinary text alone', () => {
    expect(extractOutboundMedia('Sent nothing.')).toEqual({ text: 'Sent nothing.', files: [] });
  });
});
