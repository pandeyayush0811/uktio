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

module.exports = { synthesizeSpeech, synthesize };

// ============================================================
// OPTIONAL: WebSocket streaming transport (wss://api.sarvam.ai/text-to-speech/ws)
// ============================================================
// The REST call above still pays a full HTTP request/response cycle
// (TCP+TLS handshake, headers, full JSON response) for every single
// sentence — even parallelized, that's real fixed overhead per call.
// Sarvam's WebSocket API removes that: open ONE connection, stream
// sentences in as text messages, audio comes back progressively as it's
// synthesized (Sarvam's own docs cite sub-250ms time-to-first-byte here,
// vs. a full REST round trip per sentence).
//
// THIS IS OFF BY DEFAULT (LITE_TTS_TRANSPORT defaults to 'rest') and
// falls back to the REST path automatically on any WebSocket error —
// turning it on can't make things worse than today, at most it silently
// behaves exactly like the REST path already does. Two honest caveats
// before you flip it on for real users:
//   1. This couldn't be tested against Sarvam's live WebSocket server
//      from the environment this was written in (no outbound network
//      access there) — the message envelope for `text`/`flush`/`ping`
//      is inferred from Sarvam's documented `config` message shape (see
//      below) plus their SDK's public method names (ws.convert(text) /
//      ws.flush() / ws.ping()), which is a strong signal but not a
//      byte-for-byte confirmed spec for those three.
//   2. Test it with LITE_TTS_TRANSPORT=websocket on a non-production
//      deploy first, watch the [lite timing/stream] logs, confirm audio
//      actually comes back correctly, THEN flip it on production.
//
// Requires the `ws` package (added to package.json).
const WebSocket = require('ws');

const WS_URL = 'wss://api.sarvam.ai/text-to-speech/ws';
const WS_TIMEOUT_MS = Number(process.env.LITE_SARVAM_WS_TIMEOUT_MS) || 8000;
const TTS_TRANSPORT = process.env.LITE_TTS_TRANSPORT || 'rest'; // 'rest' | 'websocket'

// One text-in/audio-out round trip over a fresh WebSocket connection.
// (Not yet reusing one connection across sentences within a turn — that's
// the natural next step once this transport is validated live, since
// "config once, stream text continuously" is exactly what the persistent
// connection is for. Kept to one-shot-per-call for now so this is a
// drop-in replacement for synthesizeSpeech() with the same signature,
// easy to A/B against the REST path sentence-for-sentence.)
function synthesizeSpeechWS(text, targetLanguage) {
  const language = targetLanguage || SARVAM_DEFAULT_LANGUAGE;

  return new Promise((resolve, reject) => {
    let settled = false;
    const chunks = [];

    const ws = new WebSocket(`${WS_URL}?model=${encodeURIComponent(SARVAM_MODEL)}`, {
      headers: { 'Api-Subscription-Key': process.env.SARVAM_API_KEY }
    });

    const timer = setTimeout(() => fail(new Error(`Sarvam TTS WebSocket timed out after ${WS_TIMEOUT_MS}ms`)), WS_TIMEOUT_MS);

    ws.on('open', () => {
      // Config MUST be the first message (documented requirement).
      ws.send(JSON.stringify({
        type: 'config',
        data: {
          speaker: SARVAM_SPEAKER,
          target_language_code: language,
          min_buffer_size: 50,
          max_chunk_length: 200,
          output_audio_codec: 'wav'
        }
      }));
      ws.send(JSON.stringify({ type: 'text', data: { text } }));
      // Flush = "no more text coming for this utterance, start finishing
      // up" — without it the server may keep buffering waiting for more.
      ws.send(JSON.stringify({ type: 'flush' }));
    });

    ws.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch (_) { return; }
      if (msg.type === 'audio' && msg.data && msg.data.audio) {
        chunks.push(msg.data.audio);
      } else if (msg.type === 'event' && msg.data && msg.data.event_type === 'final') {
        finish();
      } else if (msg.type === 'error') {
        fail(new Error((msg.data && msg.data.message) || 'Sarvam TTS WebSocket reported an error'));
      }
    });

    ws.on('error', (err) => fail(err));
    ws.on('close', (code, reasonBuf) => {
      if (settled) return;
      // No explicit "final" event, but a clean close with audio already
      // collected — treat as done rather than as a failure.
      if (code === 1000 && chunks.length) { finish(); return; }
      fail(new Error(`Sarvam TTS WebSocket closed unexpectedly (code ${code}): ${(reasonBuf || '').toString().slice(0, 200)}`));
    });

    function finish() {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { ws.close(1000); } catch (_) { /* already closing */ }
      if (!chunks.length) { reject(new Error('Sarvam TTS WebSocket returned no audio.')); return; }
      resolve({ audio_base64: chunks.join(''), mime_type: 'audio/wav' });
    }
    function fail(err) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { ws.terminate(); } catch (_) { /* already gone */ }
      reject(err);
    }
  });
}

// Drop-in for synthesizeSpeech() that routes to WebSocket or REST based
// on LITE_TTS_TRANSPORT, with automatic fallback — this is the function
// liteRoutes.js should import instead of synthesizeSpeech directly.
async function synthesize(text, targetLanguage) {
  if (TTS_TRANSPORT !== 'websocket') return synthesizeSpeech(text, targetLanguage);

  try {
    return await synthesizeSpeechWS(text, targetLanguage);
  } catch (err) {
    console.warn(`Sarvam TTS WebSocket failed (${err.message}) — falling back to REST for this sentence.`);
    return synthesizeSpeech(text, targetLanguage);
  }
}