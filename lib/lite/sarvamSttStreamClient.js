// LITE FEATURE — streaming (live) speech-to-text via Sarvam AI's Saaras v3
// WebSocket API. This is the fix for the biggest latency problem in the
// old flow: the old sarvamSttClient.js only gets called AFTER the client
// has recorded the ENTIRE utterance, merged it into one WAV, base64-encoded
// it, and uploaded it as a single HTTP POST — meaning nothing happens
// while the user is actually talking.
//
// This module instead opens ONE WebSocket per turn, accepts raw PCM audio
// chunks pushed in as they're captured (see liteRoutes.js's handleLiveTurn
// and practice-lite.html), and streams them to Sarvam continuously. By the
// time the user stops talking, the transcript is usually already sitting
// in the buffer or arrives within ~300ms — instead of only starting the
// full round trip at that point.
//
// Wire format used here is the raw WebSocket protocol (not Sarvam's SDK),
// confirmed against Sarvam's own API reference examples (not inferred from
// SDK method names — see the two message shapes below, both copied
// verbatim from https://docs.sarvam.ai's STT WebSocket reference page):
//   SEND  (per audio chunk): { "audio": { "data": "<base64 WAV>", "sample_rate": "16000", "encoding": "audio/wav" } }
//   RECV  (final transcript): { "type": "data", "data": { "transcript": "...", "metrics": {...} } }
//   RECV  (VAD signal, when vad_signals=true): { "type": "events", "data": { "signal_type": "START_SPEECH" | "END_SPEECH" } }
// The ONE inferred (not byte-for-byte confirmed) piece is the "flush"
// message used in finish() below — Sarvam's docs describe a
// `flush_signal` connection parameter and an SDK method `ws.flush()` for
// "instant processing," but don't show the raw JSON for it on the public
// reference page. Modeled on the exact same shape as the TTS WebSocket's
// confirmed `{"type":"flush"}` message (see sarvamTtsClient.js), which is
// a strong signal but not a confirmed spec for the STT side specifically.
// TEST THIS LIVE before shipping — see the caveat in liteRoutes.js.

const WebSocket = require('ws');
const { EventEmitter } = require('events');

const STT_WS_URL = 'wss://api.sarvam.ai/speech-to-text/ws';
const SAMPLE_RATE = 16000; // must match the client's mic capture rate (PCM_SAMPLE_RATE in practice-lite.html)
const CONNECT_TIMEOUT_MS = Number(process.env.LITE_SARVAM_STT_WS_CONNECT_TIMEOUT_MS) || 5000;
// If the user goes silent after speaking and finish() is never called
// (e.g. a dropped 'stop' message from the client), don't hang the
// session open forever burning a connection slot.
const IDLE_TIMEOUT_MS = Number(process.env.LITE_SARVAM_STT_WS_IDLE_TIMEOUT_MS) || 20000;

// Wraps a raw 16-bit PCM chunk (mono, SAMPLE_RATE Hz) in a minimal
// 44-byte WAV header before sending. Sarvam's docs list pcm_s16le as a
// valid streaming encoding, but the LIVE server currently rejects it
// ("Input should be 'audio/wav'", a pydantic enum validation error
// observed in production testing) — the docs are out of sync with the
// deployed API here, so every chunk goes out as its own small
// self-contained WAV instead. Slight overhead (44 bytes/chunk) but
// correct against what the server actually accepts today.
function wrapPcmAsWav(pcmBuffer, sampleRate) {
  const dataSize = pcmBuffer.length;
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + dataSize, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16);        // fmt chunk size
  header.writeUInt16LE(1, 20);         // PCM
  header.writeUInt16LE(1, 22);         // mono
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28); // byte rate (16-bit mono)
  header.writeUInt16LE(2, 32);         // block align
  header.writeUInt16LE(16, 34);        // bits per sample
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(dataSize, 40);
  return Buffer.concat([header, pcmBuffer]);
}

// Emits:
//   'speechStart'          — Sarvam's VAD detected the user starting to talk
//   'speechEnd'             — Sarvam's VAD detected the user going silent
//                             (informational only in v1 — see the caveat
//                             in liteRoutes.js on why this doesn't
//                             automatically end the turn yet)
//   'transcript', text      — a transcript became available. Sarvam may
//                             send this more than once (interim/partial
//                             behavior isn't documented as guaranteed on
//                             this endpoint the way the newer beta
//                             realtime endpoint promises) — treat the
//                             LAST one received before finish() resolves
//                             as authoritative.
//   'error', err
//   'close'
class LiveSttSession extends EventEmitter {
  constructor({ languageCode, mode = 'transcribe' } = {}) {
    super();
    this.languageCode = languageCode; // e.g. 'en-IN', 'hi-IN' — omit to let Sarvam auto-detect, if supported for your account
    this.mode = mode;
    this.ws = null;
    this.lastTranscript = '';
    this._connected = false;
    this._finished = false;
    this._idleTimer = null;
  }

  connect() {
    return new Promise((resolve, reject) => {
      const params = new URLSearchParams({
        model: 'saaras:v3',
        mode: this.mode,
        sample_rate: String(SAMPLE_RATE),
        high_vad_sensitivity: 'true',
        vad_signals: 'true'
      });
      if (this.languageCode) params.set('language_code', this.languageCode);

      const connectTimer = setTimeout(() => {
        this._fail(new Error(`Sarvam STT WebSocket connect timed out after ${CONNECT_TIMEOUT_MS}ms`));
        reject(new Error('STT WebSocket connect timeout'));
      }, CONNECT_TIMEOUT_MS);

      this.ws = new WebSocket(`${STT_WS_URL}?${params.toString()}`, {
        headers: { 'Api-Subscription-Key': process.env.SARVAM_API_KEY }
      });

      this.ws.on('open', () => {
        clearTimeout(connectTimer);
        this._connected = true;
        this._resetIdleTimer();
        resolve();
      });

      this.ws.on('message', (raw) => {
        this._resetIdleTimer();
        let msg;
        try { msg = JSON.parse(raw.toString()); } catch (_) { return; }

        if (msg.type === 'data' && msg.data && typeof msg.data.transcript === 'string') {
          this.lastTranscript = msg.data.transcript;
          this.emit('transcript', this.lastTranscript);
        } else if (msg.type === 'events' && msg.data) {
          const signal = msg.data.signal_type;
          if (signal === 'START_SPEECH') this.emit('speechStart');
          else if (signal === 'END_SPEECH') this.emit('speechEnd');
        } else if (msg.type === 'error') {
          this._fail(new Error((msg.data && msg.data.message) || 'Sarvam STT WebSocket reported an error'));
        }
      });

      this.ws.on('error', (err) => {
        clearTimeout(connectTimer);
        this._fail(err);
        reject(err);
      });

      this.ws.on('close', (code, reasonBuf) => {
        clearTimeout(connectTimer);
        clearTimeout(this._idleTimer);
        this._connected = false;
        if (!this._finished) {
          // Closed before we asked it to — surface as an error so the
          // caller doesn't hang waiting on a promise that'll never
          // resolve. A clean 1000 after finish() is expected and NOT an
          // error (handled in finish() itself).
          this.emit('error', new Error(`Sarvam STT WebSocket closed unexpectedly (code ${code}): ${(reasonBuf || '').toString().slice(0, 200)}`));
        }
        this.emit('close');
      });
    });
  }

  _resetIdleTimer() {
    clearTimeout(this._idleTimer);
    this._idleTimer = setTimeout(() => {
      this._fail(new Error(`Sarvam STT WebSocket idle timeout after ${IDLE_TIMEOUT_MS}ms — no message received`));
    }, IDLE_TIMEOUT_MS);
  }

  // pcmChunk: a Buffer of raw 16-bit PCM samples (mono, SAMPLE_RATE Hz) —
  // exactly what MicCapture already produces per chunk, no WAV wrapping
  // needed. Call this repeatedly as chunks arrive; don't wait for the
  // user to finish speaking.
// pcmChunk: a Buffer of raw 16-bit PCM samples (mono, SAMPLE_RATE Hz) —
// exactly what MicCapture already produces per chunk. Wrapped in a
// minimal 44-byte WAV header before sending — Sarvam's docs list
// pcm_s16le as a valid streaming encoding, but the LIVE server currently
// rejects it ("Input should be 'audio/wav'", a pydantic enum validation
// error observed in production testing) — the docs are wrong /
// out of sync with the deployed API here, so this sends each chunk as
// its own small self-contained WAV instead. Slight overhead (44 bytes
// per chunk) but correct against what the server actually accepts today.
  pushAudioChunk(pcmChunk) {
    if (!this._connected || this._finished) return;
    this.ws.send(JSON.stringify({
      audio: {
        data: wrapPcmAsWav(pcmChunk, SAMPLE_RATE).toString('base64'),
        sample_rate: String(SAMPLE_RATE),
        encoding: 'audio/wav'
      }
    }));
  }

  // Tell Sarvam "no more audio for this utterance, finish processing now"
  // and resolve with whatever transcript it settles on. See the file-level
  // comment: the exact 'flush' wire shape is inferred from the TTS
  // WebSocket's confirmed pattern, not confirmed for STT specifically —
  // validate this resolves promptly in a real test run before relying on
  // it in production. Falls back to a short grace-period wait + whatever
  // lastTranscript already arrived if no further message shows up.
  finish({ graceMs = 1500 } = {}) {
    if (this._finished) return Promise.resolve(this.lastTranscript);
    this._finished = true;

    return new Promise((resolve) => {
      let settled = false;
      const done = () => {
        if (settled) return;
        settled = true;
        clearTimeout(graceTimer);
        this.removeListener('transcript', onTranscript);
        try { if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.close(1000); } catch (_) { /* already closing */ }
        resolve(this.lastTranscript);
      };
      const onTranscript = () => done();
      this.once('transcript', onTranscript);

      try {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
          this.ws.send(JSON.stringify({ type: 'flush' }));
        }
      } catch (_) { /* connection already gone — grace timer below still fires */ }

      // Grace period backstop: if no transcript/flush-ack arrives in
      // time, resolve with whatever we already have rather than hanging
      // the whole turn.
      const graceTimer = setTimeout(done, graceMs);
    });
  }

  _fail(err) {
    if (this._finished) return;
    this.emit('error', err);
    try { this.ws && this.ws.terminate(); } catch (_) { /* already gone */ }
  }

  // Hard stop, no flush — for client-disconnect / abort paths.
  abort() {
    this._finished = true;
    clearTimeout(this._idleTimer);
    try { this.ws && this.ws.terminate(); } catch (_) { /* already gone */ }
  }
}

module.exports = { LiveSttSession };