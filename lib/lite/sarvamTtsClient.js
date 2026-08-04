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
// Fallback only — used if a caller doesn't pass a language (shouldn't
// happen on the normal path, since llmClient tags every sentence). The
// practice partner switches between en-IN and hi-IN per sentence based on
// what the LLM actually said, matching the user's language + corrections,
// same as the realtime feature. Bulbul v3 handles code-mixed Hinglish text
// natively within either target language.
const SARVAM_DEFAULT_LANGUAGE = process.env.LITE_SARVAM_TTS_LANGUAGE || 'en-IN';

const REQUEST_TIMEOUT_MS = Number(process.env.LITE_SARVAM_TIMEOUT_MS) || 10000;

// text: the sentence to speak.
// targetLanguage: BCP-47 code ('en-IN' | 'hi-IN' | ...) — the language this
// specific sentence should be voiced in. Callers should pass this per
// sentence (see llmClient.js's onSentence lang argument); falls back to
// SARVAM_DEFAULT_LANGUAGE only if omitted.
async function synthesizeSpeech(text, targetLanguage) {
  if (!process.env.SARVAM_API_KEY) {
    throw new Error('SARVAM_API_KEY missing — add it to .env for the lite feature to work.');
  }
  const language = targetLanguage || SARVAM_DEFAULT_LANGUAGE;

  // One retry, only for transient failures — matches sarvamSttClient's
  // policy. Each sentence-level TTS call already runs in parallel with
  // its siblings (see liteRoutes.js), so a single retry here costs at
  // most one extra round trip for THAT sentence, not the whole turn.
  let lastErr;
  for (let attempt = 0; attempt < 2; attempt++) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const res = await fetch(SARVAM_TTS_URL, {
        method: 'POST',
        headers: {
          'api-subscription-key': process.env.SARVAM_API_KEY,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          text,
          target_language_code: language,
          model: SARVAM_MODEL,
          speaker: SARVAM_SPEAKER
        }),
        signal: controller.signal
      });

      if (!res.ok) {
        const t = await res.text().catch(() => '');
        const err = new Error(`Sarvam TTS failed (${res.status}): ${t.slice(0, 300)}`);
        err.status = res.status;
        throw err;
      }

      const data = await res.json();
      const audioBase64 = Array.isArray(data.audios) ? data.audios.join('') : null;
      if (!audioBase64) throw new Error('Sarvam TTS returned no audio data.');

      // Sarvam returns base64-encoded WAV (proper header), unlike
      // Gemini's raw PCM — decode with AudioContext.decodeAudioData()
      // client-side rather than assuming raw PCM samples.
      return { audio_base64: audioBase64, mime_type: 'audio/wav' };
    } catch (err) {
      lastErr = err.name === 'AbortError' ? new Error(`Sarvam TTS timed out after ${REQUEST_TIMEOUT_MS}ms`) : err;
      const isRetryable = err.name === 'AbortError' || !err.status || err.status >= 500;
      if (!isRetryable || attempt === 1) throw lastErr;
      console.warn(`Sarvam TTS attempt ${attempt + 1} failed (${lastErr.message}), retrying once...`);
    } finally {
      clearTimeout(timeoutId);
    }
  }
  throw lastErr;
}

module.exports = { synthesizeSpeech };