// LITE FEATURE — text-to-speech via Sarvam AI's Bulbul v3.
// Swapped in from Gemini TTS for speed: Gemini's generateContent audio
// output is non-streaming (waits for the ENTIRE audio to synthesize
// before returning anything) — measured at 3.8-6s per turn, the single
// biggest chunk of turn latency. Bulbul v3 is purpose-built for Indian
// languages, handles code-mixed Hinglish text natively (no preprocessing
// needed), and is sub-250ms first-byte on Sarvam's streaming API.
// This file uses the plain REST endpoint (still much faster than Gemini,
// simpler than streaming) — see the WebSocket/HTTP-stream docs later if
// you want to push latency down further once the REST swap is validated.
// Isolated on purpose, same pattern as the other lite/ clients.

const SARVAM_TTS_URL = 'https://api.sarvam.ai/text-to-speech';
const SARVAM_MODEL = process.env.LITE_SARVAM_TTS_MODEL || 'bulbul:v3';
const SARVAM_SPEAKER = process.env.LITE_SARVAM_TTS_SPEAKER || 'shubh';
// The practice partner speaks English (with natural Hinglish handled
// automatically by Bulbul v3) — Indian-accent English voice.
const SARVAM_TARGET_LANGUAGE = process.env.LITE_SARVAM_TTS_LANGUAGE || 'en-IN';

async function synthesizeSpeech(text) {
  if (!process.env.SARVAM_API_KEY) {
    throw new Error('SARVAM_API_KEY missing — add it to .env for the lite feature to work.');
  }

  const res = await fetch(SARVAM_TTS_URL, {
    method: 'POST',
    headers: {
      'api-subscription-key': process.env.SARVAM_API_KEY,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      text,
      target_language_code: SARVAM_TARGET_LANGUAGE,
      model: SARVAM_MODEL,
      speaker: SARVAM_SPEAKER
    })
  });

  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error(`Sarvam TTS failed (${res.status}): ${t.slice(0, 300)}`);
  }

  const data = await res.json();
  const audioBase64 = Array.isArray(data.audios) ? data.audios.join('') : null;
  if (!audioBase64) throw new Error('Sarvam TTS returned no audio data.');

  // Sarvam returns base64-encoded WAV by default (unlike Gemini's raw PCM),
  // so the frontend audio player may need a small adjustment — WAV has a
  // proper header, so most <audio>/native players handle it more easily
  // than raw PCM actually.
  return { audio_base64: audioBase64, mime_type: 'audio/wav' };
}

module.exports = { synthesizeSpeech };
