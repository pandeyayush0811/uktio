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
// CONFIRMED FIX: Sarvam's WS API reference lists the `model` query param's
// allowed values as `bulbul:v2` (default) ONLY — unlike the REST endpoint,
// which does accept `bulbul:v3` (that's why REST fallback always worked
// fine while WS never connected). We were reusing SARVAM_MODEL (defaults
// to 'bulbul:v3', tuned for REST) for the WS query string too, so every WS
// connect request had an invalid `model` value and got rejected before the
// config message was even parsed — surfacing as the same generic
// "Input parameters has to be a valid dictionary" error regardless of what
// was inside `config.data`. Use a separate, WS-specific model constant.
const SARVAM_WS_MODEL = process.env.LITE_SARVAM_WS_TTS_MODEL || 'bulbul:v2';
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

    const ws = new WebSocket(`${WS_URL}?model=${encodeURIComponent(SARVAM_WS_MODEL)}`, {
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
          min_buffer_size: 10, // lowered from 50 — Sarvam was holding back audio until 50 chars accumulated, adding a fixed floor to every sentence's TTS latency regardless of length
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
// ============================================================
// LiveTtsSession — persistent-connection TTS for one whole turn
// ============================================================
// synthesizeSpeechWS() above (still used by the 'websocket' transport
// option) opens a FRESH WebSocket per sentence — better than REST (keeps
// the streaming time-to-first-byte benefit) but still pays a full
// connect + config handshake every single sentence, which is exactly the
// overhead a persistent connection is supposed to eliminate.
//
// This class keeps ONE connection open across an entire turn and reuses
// it for every sentence that shares the same target language. Sarvam's
// docs only show `config` as the first message on a connection — there's
// no documented way to change target_language_code on an already-open
// connection — so when a turn switches language mid-reply (e.g. an
// English sentence followed by a <hi>-tagged Hindi correction, see
// llmClient.js), this class closes the old connection and opens a new
// one configured for the new language, rather than assuming
// reconfiguration works. Net effect: a turn that's all one language pays
// ONE handshake total instead of one per sentence; a turn that switches
// language twice pays two, not (previously) N.
//
// NOT tested against Sarvam's live WebSocket server from this
// environment (no outbound network access here) — same honest caveat as
// synthesizeSpeechWS() above. Test with a real turn before relying on it
// in production; synthesizeSpeech() (REST) remains available as an
// unconditional fallback if a sentence's TTS ever fails on this path.
// One connection "lane" — same single-connection-reuse idea as before,
// but now this is ONE of N lanes in a pool (see LiveTtsSession below)
// instead of the whole session's only connection. Each lane still
// serializes its OWN sentences one-at-a-time (that part of the earlier
// fix was correct and stays — a connection's listeners must never have
// two sentences racing on them). What changes is that a turn is no
// longer forced through a single lane: sentence 1 and sentence 2 can now
// run on two DIFFERENT lanes' connections at the same time, so the LLM
// generating sentence 2 doesn't have to wait for Sarvam to finish
// synthesizing + returning sentence 1's audio before sentence 2's TTS
// even starts. That serialization — not connect-handshake time — was
// the single biggest remaining chunk of "gap" after the ordering-bug fix.
class TtsLane {
  constructor() {
    this.ws = null;
    this.configuredLanguage = null;
    this._closed = false;
    this._queue = Promise.resolve();
    this._connectPromise = null; // in-flight connect, so prewarm() and speak() can't both dial
  }

  // Opens (or reuses) the connection ahead of time, before any sentence
  // text exists yet. Called from LiveTtsSession.prewarm() the MOMENT a
  // turn starts (in parallel with STT finalizing + the LLM's first
  // tokens) — by the time sentence 1 is actually ready to speak, the
  // handshake is very likely already done, so that ~100-300ms round trip
  // is hidden under work that had to happen anyway instead of sitting in
  // front of the user. Best-effort: if this fails or guesses the wrong
  // language, speak() below reconnects normally, so a failed prewarm
  // costs nothing beyond not having gotten the head start.
  prewarm(language) {
    if (this._closed) return;
    this._ensureConnection(language).catch(() => { /* speak() will retry for real */ });
  }

  async _ensureConnection(language) {
    if (this.ws && this.configuredLanguage === language && this.ws.readyState === WebSocket.OPEN) {
      return; // reuse — same language, connection still open
    }
    if (this._connectPromise) return this._connectPromise; // dedupe concurrent prewarm()+speak()
    if (this.ws) {
      try { this.ws.close(1000); } catch (_) { /* already closing */ }
    }
    this._connectPromise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Sarvam TTS WebSocket (live session) connect timed out after ${WS_TIMEOUT_MS}ms`)), WS_TIMEOUT_MS);
      const ws = new WebSocket(`${WS_URL}?model=${encodeURIComponent(SARVAM_WS_MODEL)}`, {
        headers: { 'Api-Subscription-Key': process.env.SARVAM_API_KEY }
      });
      let settled = false;
      // BUG FIX: previously nothing listened for a `message` event during
      // the connect phase — only 'open' and the socket-level 'error' event.
      // If Sarvam rejects the config message itself (a JSON {type:'error',...}
      // message sent back over an otherwise successfully OPENED connection),
      // that rejection was silently dropped: _ensureConnection() had already
      // resolved on 'open' before the config message even went out, so the
      // caller thought the connection was healthy. The real rejection only
      // ever surfaced later, misleadingly, as if it were about whatever
      // sentence happened to be sent next. Listening here catches it at the
      // actual moment it happens and fails prewarm()/connect() immediately
      // with the real reason.
      const onConfigError = (raw) => {
        let msg;
        try { msg = JSON.parse(raw.toString()); } catch (_) { return; }
        if (msg.type === 'error' && !settled) {
          console.error('[lite live/tts] config rejected by Sarvam, raw message:', JSON.stringify(msg));
          settled = true;
          clearTimeout(timer);
          ws.removeListener('message', onConfigError);
          try { ws.terminate(); } catch (_) {}
          reject(new Error((msg.data && msg.data.message) || 'Sarvam TTS WebSocket rejected the config message'));
        }
      };
      ws.on('message', onConfigError);
      ws.on('open', () => {
        clearTimeout(timer);
        const configPayload = {
          type: 'config',
          data: {
            // CONFIRMED FIX (checked against Sarvam's published WS docs):
            // `model` is NOT a field of the config `data` object — it is a
            // connect-time param only (`wss://.../ws?model=...`, matching the
            // official SDK's `connect({ model: "bulbul:v3" })`). The previous
            // attempt to also add it here was a wrong guess and was itself
            // the cause of "Input parameters has to be a valid dictionary" —
            // Sarvam's config schema only accepts the fields listed below, so
            // one unexpected extra field failed validation for every single
            // sentence. Do not add `model` back here.
            speaker: SARVAM_SPEAKER,
            target_language_code: language,
            min_buffer_size: 10, // lowered from 50 — Sarvam was holding back audio until 50 chars accumulated, adding a fixed floor to every sentence's TTS latency regardless of length
            max_chunk_length: 200,
            output_audio_codec: 'wav'
          }
        };
        console.log('[lite live/tts] sending config:', JSON.stringify(configPayload));
        ws.send(JSON.stringify(configPayload));
        this.ws = ws;
        this.configuredLanguage = language;
        // Give Sarvam a brief window to reject the config (onConfigError
        // above) before declaring the connection ready — if nothing comes
        // back in that window, treat it as accepted (Sarvam's docs don't
        // document a positive config-ack message, only error-on-failure).
        setTimeout(() => {
          if (!settled) {
            settled = true;
            ws.removeListener('message', onConfigError);
            resolve();
          }
        }, 150);
      });
      ws.on('error', (err) => { if (!settled) { settled = true; clearTimeout(timer); reject(err); } });
    });
    try {
      await this._connectPromise;
    } finally {
      this._connectPromise = null;
    }
  }

  // Queues this sentence behind whatever this LANE is currently
  // speaking (still one-at-a-time PER LANE — that's the correctness
  // guarantee). LiveTtsSession spreads sentences across lanes round-robin
  // so different lanes run genuinely concurrently.
  speak(text, targetLanguage) {
    if (this._closed) return Promise.reject(new Error('LiveTtsSession already closed'));
    const run = () => this._speakOne(text, targetLanguage);
    const result = this._queue.then(run, run);
    this._queue = result.then(() => {}, () => {});
    return result;
  }

  async _speakOne(text, targetLanguage) {
    if (this._closed) throw new Error('LiveTtsSession already closed');
    const language = targetLanguage || SARVAM_DEFAULT_LANGUAGE;

    try {
      await this._ensureConnection(language);
    } catch (err) {
      throw new Error(`LiveTtsSession connect failed: ${err.message}`);
    }

    const ws = this.ws;
    return new Promise((resolve, reject) => {
      let settled = false;
      const chunks = [];
      const timer = setTimeout(() => fail(new Error(`Sarvam TTS WebSocket (live session) timed out after ${WS_TIMEOUT_MS}ms waiting for sentence audio`)), WS_TIMEOUT_MS);

      const onMessage = (raw) => {
        let msg;
        try { msg = JSON.parse(raw.toString()); } catch (_) { return; }
        if (msg.type === 'audio' && msg.data && msg.data.audio) {
          chunks.push(msg.data.audio);
        } else if (msg.type === 'event' && msg.data && msg.data.event_type === 'final') {
          finish();
        } else if (msg.type === 'error') {
          // DEBUG: log the FULL raw error payload, not just msg.data.message
          // — need to see every field Sarvam sends back (error code, which
          // field it's complaining about, etc.) to pin down the exact cause,
          // since "Input parameters has to be a valid dictionary" alone
          // doesn't say WHICH parameter.
          console.error('[lite live/tts] raw error message from Sarvam:', JSON.stringify(msg));
          fail(new Error((msg.data && msg.data.message) || 'Sarvam TTS WebSocket (live session) reported an error'));
        }
      };
      const onError = (err) => fail(err);
      const onClose = () => {
        if (!settled) fail(new Error('Sarvam TTS WebSocket (live session) closed before this sentence finished'));
      };

      ws.on('message', onMessage);
      ws.on('error', onError);
      ws.on('close', onClose);

      ws.send(JSON.stringify({ type: 'text', data: { text } }));
      ws.send(JSON.stringify({ type: 'flush' }));
      console.log(`[lite live/tts] sent text (${text.length} chars) + flush, waiting for audio...`);

      function cleanup() {
        clearTimeout(timer);
        ws.removeListener('message', onMessage);
        ws.removeListener('error', onError);
        ws.removeListener('close', onClose);
      }
      function finish() {
        if (settled) return;
        settled = true;
        cleanup();
        if (!chunks.length) { reject(new Error('Sarvam TTS WebSocket (live session) returned no audio.')); return; }
        resolve({ audio_base64: chunks.join(''), mime_type: 'audio/wav' });
      }
      function fail(err) {
        if (settled) return;
        settled = true;
        cleanup();
        reject(err);
      }
    });
  }

  close() {
    this._closed = true;
    if (this.ws) {
      try { this.ws.close(1000); } catch (_) { /* already closing */ }
    }
  }
}

// LiveTtsSession = a small POOL of TtsLane connections (default 2, tune
// via LITE_TTS_POOL_SIZE) for one whole turn. Sentences are assigned to
// lanes round-robin (sentence 0 -> lane 0, sentence 1 -> lane 1, sentence
// 2 -> lane 0, ...), so up to POOL_SIZE sentences can be synthesizing on
// Sarvam AT THE SAME TIME instead of strictly one-after-another. This is
// the real fix for the remaining "gap": before, a 3-sentence reply paid
// TTS-time-1 + TTS-time-2 + TTS-time-3 back to back; with a 2-lane pool
// it pays roughly TTS-time-1 (lane 0 and lane 1 overlap for sentences 1
// and 2, sentence 3 queues behind sentence 1 on lane 0) — meaningfully
// less than half the wait on a typical 3-4 sentence reply.
// Public API (speak/close) is UNCHANGED from before — callers don't need
// to know a pool exists underneath. Playback order is still guaranteed
// correct because liteRoutes.js sends `index` with every audio_chunk and
// the frontend now plays strictly by index (see practice-lite.html),
// regardless of which lane a sentence's audio came back from or in what
// order lanes happen to resolve.
const POOL_SIZE = Math.max(1, Number(process.env.LITE_TTS_POOL_SIZE) || 2);

// KILL-SWITCH — default OFF. Two independent attempts at Sarvam's WS
// `config` envelope, each grounded in their own published docs (fixing the
// stray `model` field, then fixing the WS-only model enum), both still got
// rejected with the same generic "Input parameters has to be a valid
// dictionary" (422). That means the real envelope Sarvam's WS server wants
// has at least one more undocumented requirement — continuing to guess
// blindly just burns another production test cycle each time for no
// guaranteed payoff. Turning this off entirely means every sentence goes
// straight to the REST path (see synthesize() below), which already works
// reliably AND already runs in parallel across sentences (liteRoutes.js's
// onSentence fires each ttsSession.speak()/synthesize() call independently,
// without waiting on the previous sentence) — so this is not a regression
// to "one at a time", it just removes the ~0.5s wasted connect-then-reject
// round trip every sentence was paying before falling back anyway.
// Flip LITE_LIVE_TTS_WS_ENABLED=true to re-enable the WS attempt once
// Sarvam's actual required fields are confirmed (e.g. via their support or
// SDK source), without touching any other code.
const LIVE_TTS_WS_ENABLED = process.env.LITE_LIVE_TTS_WS_ENABLED === 'true';

class LiveTtsSession {
  constructor() {
    this._lanes = Array.from({ length: POOL_SIZE }, () => new TtsLane());
    this._nextLane = 0;
    this._closed = false;
  }

  // Call this the MOMENT a turn starts (liteRoutes.js does this right
  // after opening the STT WebSocket) — opens EVERY lane's connection
  // speculatively (not just lane 0) using a guessed language, so the
  // handshake round-trip for ALL lanes overlaps with STT finalization +
  // the LLM's first-token latency instead of sitting on the critical
  // path.
  // BUG FIX: this used to prewarm only lane 0. Sentence 1 (lane 0) then
  // came back fast, but sentence 2 (lane 1, still cold) had to pay its
  // full connect handshake AFTER the LLM had already produced its text —
  // i.e. sentence 2's audio arrived late relative to sentence 1's, even
  // though sentence 2 was requested first from Sarvam's perspective in
  // wall-clock terms. Warming every lane up front removes that
  // lane-dependent latency asymmetry entirely.
  prewarm(language) {
    if (!LIVE_TTS_WS_ENABLED) return; // don't bother opening connections we know get rejected
    if (this._closed || !this._lanes.length) return;
    for (const lane of this._lanes) lane.prewarm(language || SARVAM_DEFAULT_LANGUAGE);
  }

  speak(text, targetLanguage) {
    if (this._closed) return Promise.reject(new Error('LiveTtsSession already closed'));
    // WS disabled — go straight to REST. Still fully parallel across
    // sentences: liteRoutes.js never awaits one speak() before starting
    // the next, so this is the same concurrency as before, just without
    // the pointless WS round trip in front of it.
    if (!LIVE_TTS_WS_ENABLED) return synthesize(text, targetLanguage);
    const lane = this._lanes[this._nextLane];
    this._nextLane = (this._nextLane + 1) % this._lanes.length;
    return lane.speak(text, targetLanguage);
  }

  close() {
    this._closed = true;
    for (const lane of this._lanes) lane.close();
  }
}

module.exports.LiveTtsSession = LiveTtsSession;