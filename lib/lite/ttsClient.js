// LITE FEATURE — text-to-speech via the Gemini API's generateContent audio
// output (the free, no-credit-card AI Studio route) — deliberately NOT
// Google Cloud Text-to-Speech, which requires a billing account even to
// stay inside its free quota.
//
// IMPORTANT: verify the exact TTS-capable model name in Google AI Studio
// before first run (model availability/names shift faster than most APIs) —
// set LITE_TTS_MODEL in .env if the default below is no longer current.
const TTS_MODEL = process.env.LITE_TTS_MODEL || 'gemini-2.5-flash-preview-tts';
const VOICE_NAME = process.env.LITE_TTS_VOICE || 'Kore';

async function synthesizeSpeech(text) {
  if (!process.env.LITE_GEMINI_TTS_KEY) {
    throw new Error('LITE_GEMINI_TTS_KEY missing — add a free Google AI Studio key to .env.');
  }

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${TTS_MODEL}:generateContent?key=${encodeURIComponent(process.env.LITE_GEMINI_TTS_KEY)}`;

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts: [{ text }] }],
      generationConfig: {
        responseModalities: ['AUDIO'],
        speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: VOICE_NAME } } }
      }
    })
  });

  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error(`Gemini TTS failed (${res.status}): ${t.slice(0, 300)}`);
  }

  const data = await res.json();
  const part = data?.candidates?.[0]?.content?.parts?.find(p => p.inlineData);
  if (!part) throw new Error('Gemini TTS returned no audio data.');

  // Gemini's audio output is raw 16-bit PCM at 24kHz — same format the
  // existing BYOK Live API already plays in chat.html, so the frontend
  // player logic is the same shape (just not shared code).
  return { audio_base64: part.inlineData.data, mime_type: part.inlineData.mimeType || 'audio/pcm;rate=24000' };
}

module.exports = { synthesizeSpeech };
