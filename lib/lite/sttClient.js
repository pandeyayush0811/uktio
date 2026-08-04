// LITE FEATURE — speech-to-text via Groq's hosted Whisper.
// Isolated on purpose: this file imports nothing from the rest of the
// app, and nothing outside lib/lite/ or routes/liteRoutes.js imports it.
// Delete the whole lib/lite/ folder + liteRoutes.js to remove the feature.

const GROQ_STT_URL = 'https://api.groq.com/openai/v1/audio/transcriptions';
const GROQ_MODEL = process.env.LITE_GROQ_STT_MODEL || 'whisper-large-v3-turbo';

// audioBuffer: raw audio bytes (Buffer, decoded from the base64 the app sent).
// mimeType: whatever the browser/app recorded with, e.g. 'audio/webm;codecs=opus'.
async function transcribeAudio(audioBuffer, mimeType) {
  if (!process.env.GROQ_API_KEY) {
    throw new Error('GROQ_API_KEY missing — add it to .env for the lite feature to work.');
  }

  const ext = mimeType.includes('wav') ? 'wav' : mimeType.includes('webm') ? 'webm' : 'm4a';

  const form = new FormData();
  form.append('file', new Blob([audioBuffer], { type: mimeType }), `turn.${ext}`);
  form.append('model', GROQ_MODEL);
  form.append('response_format', 'json');
  form.append('language', 'en'); // hints the model — user is practicing English

  const res = await fetch(GROQ_STT_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.GROQ_API_KEY}` },
    body: form
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Groq STT failed (${res.status}): ${text.slice(0, 300)}`);
  }

  const data = await res.json();
  return (data.text || '').trim();
}

module.exports = { transcribeAudio };
