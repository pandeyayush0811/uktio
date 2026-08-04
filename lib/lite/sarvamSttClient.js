// LITE FEATURE — speech-to-text via Sarvam AI's Saaras v3.
// Swapped in from Gemini (gemini-3.1-flash-lite) for speed: Gemini's STT
// round-trip measured at ~2.0-2.4s (it's a full LLM call under the hood).
// Saaras v3 is a dedicated ASR model purpose-built for Indian languages
// and code-mixed Hindi/English speech — sub-150ms time-to-first-token on
// their streaming API, and much faster than a full LLM call even on the
// plain REST endpoint used here.
// Isolated on purpose, same pattern as the other lite/ clients.

const SARVAM_STT_URL = 'https://api.sarvam.ai/speech-to-text';
const SARVAM_MODEL = process.env.LITE_SARVAM_STT_MODEL || 'saaras:v3';
// transcribe = standard transcription, keeps original script, handles
// code-mixed Hindi/English natively per Sarvam's docs. 'codemix' mode is
// also available if you want output forced into a specific code-mixed
// style — override via env if 'transcribe' isn't giving what you want.
const SARVAM_MODE = process.env.LITE_SARVAM_STT_MODE || 'transcribe';

const REQUEST_TIMEOUT_MS = Number(process.env.LITE_SARVAM_TIMEOUT_MS) || 10000;

// audioBuffer: raw audio bytes (Buffer, decoded from the base64 the app sent).
// mimeType: whatever the browser/app recorded with, e.g. 'audio/webm;codecs=opus'.
// NOTE: Sarvam's sync REST endpoint caps audio at 30 seconds — fine for
// turn-based short clips, but if you ever allow longer recording you'll
// need their Batch API instead.
async function transcribeAudio(audioBuffer, mimeType) {
  if (!process.env.SARVAM_API_KEY) {
    throw new Error('SARVAM_API_KEY missing — add it to .env for the lite feature to work.');
  }

  const ext = mimeType.includes('wav') ? 'wav' : mimeType.includes('webm') ? 'webm' : 'm4a';

  // One retry, only for transient failures (network error / 5xx / our own
  // timeout) — a 4xx (bad audio, bad auth) won't succeed on retry, so
  // fail fast on those instead of doubling the user's wait for nothing.
  let lastErr;
  for (let attempt = 0; attempt < 2; attempt++) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const form = new FormData();
      form.append('file', new Blob([audioBuffer], { type: mimeType }), `turn.${ext}`);
      form.append('model', SARVAM_MODEL);
      form.append('mode', SARVAM_MODE);

      const res = await fetch(SARVAM_STT_URL, {
        method: 'POST',
        headers: { 'api-subscription-key': process.env.SARVAM_API_KEY },
        body: form,
        signal: controller.signal
      });

      if (!res.ok) {
        const text = await res.text().catch(() => '');
        const err = new Error(`Sarvam STT failed (${res.status}): ${text.slice(0, 300)}`);
        err.status = res.status;
        throw err;
      }

      const data = await res.json();
      console.log(`Lite STT (Sarvam): language=${data.language_code || 'unknown'} text="${(data.transcript || '').slice(0, 80)}"`);
      return (data.transcript || '').trim();
    } catch (err) {
      lastErr = err.name === 'AbortError' ? new Error(`Sarvam STT timed out after ${REQUEST_TIMEOUT_MS}ms`) : err;
      const isRetryable = err.name === 'AbortError' || !err.status || err.status >= 500;
      if (!isRetryable || attempt === 1) throw lastErr;
      console.warn(`Sarvam STT attempt ${attempt + 1} failed (${lastErr.message}), retrying once...`);
    } finally {
      clearTimeout(timeoutId);
    }
  }
  throw lastErr;
}

module.exports = { transcribeAudio };
