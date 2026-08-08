// LITE PRACTICE FEATURE — fully isolated router.
// Nothing in this file imports from chatRoutes.js, and chatRoutes.js
// imports nothing from here. Delete this file + lib/lite/ + the lite_*
// tables + the one mount line in index.js to remove the feature entirely.
//
// NOTE ON SCOPE: this feature is intentionally TEXT+VOICE conversation
// only — no live mistake/correction analysis. That used to be bundled
// into the same LLM call (a "mistakes" array alongside "reply"), but it
// was pure latency/cost with no benefit to the live conversation itself,
// so it's been removed from this hot path entirely. Grammar/correction
// analysis is a separate future "report" feature: run it asynchronously,
// after the fact, off the stored `lite_turns` transcript — never inline
// with a turn the user is actively waiting on.

const express = require('express');
const router = express.Router();
const { requireAuth } = require('../middleware/authMiddleware');
const { supabaseAdmin, supabaseAnon } = require('../lib/supabaseClient');
const { transcribeAudio } = require('../lib/lite/sarvamSttClient');
const { streamReply } = require('../lib/lite/llmClient');
const { synthesize, LiveTtsSession } = require('../lib/lite/sarvamTtsClient');
const { LiveSttSession } = require('../lib/lite/sarvamSttStreamClient');

// How many past turns get fed back as context on each new turn — kept
// deliberately small. This is a quick-practice chat, not a long-term
// memory app: the last few exchanges are enough for natural flow and
// for the model to notice a repeated mistake (see REPETITION-BASED
// INTENSITY in llmClient.js's prompt), and every turn beyond this is
// pure token cost + latency with no real benefit. Tuned down from an
// earlier 20 after discussion — 20 turns of history on every single
// call was paying for context depth this feature doesn't need.
const MAX_TURNS_CONTEXT = 10;

// Starts a new lite session. Called once when the practice page opens.
router.post('/sessions', requireAuth, async (req, res, next) => {
  try {
    if (!supabaseAdmin) return res.status(500).json({ error: 'Server misconfigured: SUPABASE_SERVICE_ROLE_KEY missing.' });

    const now = new Date().toISOString();
    const { data, error } = await supabaseAdmin
      .from('lite_sessions')
      .insert({ user_id: req.user.id, started_at: now, ended_at: now, turn_count: 0 })
      .select()
      .single();

    if (error) return res.status(500).json({ error: error.message });
    res.json({ session_id: data.id });
  } catch (err) { next(err); }
});

// Lightweight list for a future history view — mirrors GET /chat/sessions.
router.get('/sessions', requireAuth, async (req, res, next) => {
  try {
    if (!supabaseAdmin) return res.status(500).json({ error: 'Server misconfigured.' });

    const { data, error } = await supabaseAdmin
      .from('lite_sessions')
      .select('id, started_at, ended_at, turn_count, created_at')
      .eq('user_id', req.user.id)
      .order('started_at', { ascending: false });

    if (error) return res.status(500).json({ error: error.message });
    res.json({ sessions: data });
  } catch (err) { next(err); }
});

// Full transcript for one session.
router.get('/sessions/:id', requireAuth, async (req, res, next) => {
  try {
    if (!supabaseAdmin) return res.status(500).json({ error: 'Server misconfigured.' });

    const { data: session, error: sessionErr } = await supabaseAdmin
      .from('lite_sessions')
      .select('*')
      .eq('id', req.params.id)
      .eq('user_id', req.user.id)
      .single();
    if (sessionErr || !session) return res.status(404).json({ error: 'Session not found' });

    const { data: turns, error: turnsErr } = await supabaseAdmin
      .from('lite_turns')
      .select('role, content, turn_index')
      .eq('session_id', req.params.id)
      .order('turn_index', { ascending: true });
    if (turnsErr) return res.status(500).json({ error: turnsErr.message });

    res.json({ session, turns });
  } catch (err) { next(err); }
});

// Clear all lite history — mirrors DELETE /chat/sessions, own table only.
router.delete('/sessions', requireAuth, async (req, res, next) => {
  try {
    if (!supabaseAdmin) return res.status(500).json({ error: 'Server misconfigured.' });

    const { error } = await supabaseAdmin.from('lite_sessions').delete().eq('user_id', req.user.id);
    if (error) return res.status(500).json({ error: error.message });

    res.json({ ok: true });
  } catch (err) { next(err); }
});

// Shared by both routes below: looks up the session (auth-scoped) and
// kicks off STT + history-fetch in parallel, since neither depends on
// the other. Throws a small typed error object on failure so each route
// can translate it to its own response shape (JSON status vs SSE event).
async function runSttAndHistory(sessionRowId, userId, audioBuffer, mimeType) {
  const { data: session, error: sessionErr } = await supabaseAdmin
    .from('lite_sessions')
    .select('id, turn_count')
    .eq('id', sessionRowId)
    .eq('user_id', userId)
    .single();
  if (sessionErr || !session) throw { kind: 'not_found', message: 'Session not found' };

  const historyPromise = supabaseAdmin
    .from('lite_turns')
    .select('role, content')
    .eq('session_id', session.id)
    .order('turn_index', { ascending: false })
    .limit(MAX_TURNS_CONTEXT);

  let userText, historyResult;
  try {
    [userText, historyResult] = await Promise.all([transcribeAudio(audioBuffer, mimeType), historyPromise]);
  } catch (sttErr) {
    console.error('Lite STT failed:', sttErr);
    throw { kind: 'stt_failed', message: 'Transcription failed — please try again.' };
  }
  if (!userText) throw { kind: 'no_speech', message: 'Could not hear any speech — try again a bit louder/closer to mic.' };
  if (historyResult.error) throw { kind: 'db_error', message: historyResult.error.message };

  return { session, userText, history: (historyResult.data || []).reverse() };
}

// Persists both turns of the exchange (one bulk insert) + bumps the
// session's turn_count/ended_at. Shared by both routes.
async function persistTurn(session, userText, replyText) {
  const startIndex = session.turn_count;
  const rows = [
    { session_id: session.id, role: 'user', content: userText, turn_index: startIndex },
    { session_id: session.id, role: 'assistant', content: replyText, turn_index: startIndex + 1 }
  ];
  const { error: insertErr } = await supabaseAdmin.from('lite_turns').insert(rows);
  if (insertErr) throw { kind: 'db_error', message: insertErr.message };

  await supabaseAdmin
    .from('lite_sessions')
    .update({ ended_at: new Date().toISOString(), turn_count: startIndex + 2 })
    .eq('id', session.id);
}

// THE CORE LOOP (blocking version) — kept for any caller that isn't set
// up to consume a stream. Same underlying streamReply() as the /stream
// route below, just buffered into one response instead of pushed
// incrementally, so it's slower to FEEL, but does identical work.
// Body: { audio_base64: string, mime_type: string }
router.post('/sessions/:id/turn', requireAuth, async (req, res, next) => {
  try {
    if (!supabaseAdmin) return res.status(500).json({ error: 'Server misconfigured.' });

    const { audio_base64, mime_type } = req.body;
    if (!audio_base64 || typeof audio_base64 !== 'string') return res.status(400).json({ error: 'audio_base64 is required' });
    if (!mime_type || typeof mime_type !== 'string') return res.status(400).json({ error: 'mime_type is required' });

    const t0 = Date.now();
    const elapsed = () => Date.now() - t0;

    let session, userText, history;
    try {
      ({ session, userText, history } = await runSttAndHistory(req.params.id, req.user.id, Buffer.from(audio_base64, 'base64'), mime_type));
    } catch (e) {
      const status = e.kind === 'not_found' ? 404 : e.kind === 'no_speech' ? 422 : 500;
      return res.status(status).json({ error: e.message });
    }
    console.log(`[lite timing] STT + history done: ${elapsed()}ms`);

    // Collect sentences as they stream in, kicking off TTS for each
    // immediately (don't wait for the full reply before starting audio
    // synthesis) — even in the "blocking" route, there's no reason to
    // pay that time serially.
    const sentences = [];
    const ttsPromises = [];
    let replyText;
    try {
      const result = await streamReply(history, userText, (sentence, lang) => {
        sentences.push(sentence);
        ttsPromises.push(synthesize(sentence, lang).catch(err => {
          console.error('Lite TTS sentence failed, skipping that chunk:', err);
          return null;
        }));
      });
      replyText = result.replyText;
    } catch (aiErr) {
      console.error('Lite LLM call failed:', aiErr);
      return res.status(502).json({ error: 'Reply generation failed — please try again.' });
    }
    console.log(`[lite timing] LLM reply done: ${elapsed()}ms`);

    const audioParts = [];
    for (let i = 0; i < ttsPromises.length; i++) {
      const audioOut = await ttsPromises[i];
      if (audioOut) audioParts.push(audioOut);
    }
    console.log(`[lite timing] TTS done: ${elapsed()}ms`);

    try {
      await persistTurn(session, userText, replyText);
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
    console.log(`[lite timing] TOTAL (server-side, excludes upload/download): ${elapsed()}ms`);

    // Single response, so audio has to be one payload — concatenating
    // sentence-level WAVs isn't valid WAV (multiple RIFF headers back to
    // back), so this route sends only the FIRST sentence's audio plus the
    // full text, and documents that callers who want full multi-sentence
    // audio should use /turn/stream instead. In practice every real
    // client uses /turn/stream now; this route exists purely as a
    // simple fallback.
    res.json({
      user_text: userText,
      reply_text: replyText,
      audio_base64: audioParts[0] ? audioParts[0].audio_base64 : null,
      audio_mime_type: audioParts[0] ? audioParts[0].mime_type : null
    });
  } catch (err) { next(err); }
});

// THE "NEGLIGIBLE LATENCY" VERSION of the core loop — delivered as a
// stream, and now TRULY pipelined end-to-end (not just TTS anymore):
//
//   OLD (first streaming version): wait for the ENTIRE LLM reply to
//   finish generating -> THEN split into sentences -> THEN fire TTS for
//   all of them in parallel. Text and audio both still gated on the
//   full LLM generation completing.
//
//   NOW: the LLM call itself streams token-by-token (see llmClient.js).
//   The INSTANT a sentence completes mid-stream, this route (a) sends
//   that sentence's text to the client and (b) fires off its TTS
//   synthesis — WHILE the model is still generating the next sentence.
//   By the time the model finishes the full reply, sentence 1's audio
//   may already be done. Nothing waits for "the whole reply" anymore;
//   everything waits only for "the next unit that's actually needed."
//
// Also: no mistake/correction analysis on this path anymore (see file
// header) — one less thing blocking the reply, and a meaningfully
// shorter/cheaper LLM call besides.
//
// Wire format: Server-Sent-Events framing over a plain POST response —
// NOT the browser EventSource API (POST isn't supported by it). Client
// should POST with fetch() and read response.body with a stream reader.
//
// Events emitted, in order:
//   user_text     { text }                        — as soon as STT is done
//   reply_sentence{ index, text }                  — one per sentence, the MOMENT the LLM finishes generating it
//   audio_chunk   { index, audio_base64, audio_mime_type } — one per sentence, in order, as each finishes synthesizing (may lag behind reply_sentence — that's expected, TTS takes longer than generating the text)
//   done          { total_ms }                     — everything finished + persisted, safe to close the connection
//   error         { error }                        — something failed; connection ends after this, no further events
router.post('/sessions/:id/turn/stream', requireAuth, async (req, res, next) => {
  const { audio_base64, mime_type } = req.body;
  if (!audio_base64 || typeof audio_base64 !== 'string') return res.status(400).json({ error: 'audio_base64 is required' });
  if (!mime_type || typeof mime_type !== 'string') return res.status(400).json({ error: 'mime_type is required' });
  if (!supabaseAdmin) return res.status(500).json({ error: 'Server misconfigured: SUPABASE_SERVICE_ROLE_KEY missing.' });

  const t0 = Date.now();
  const elapsed = () => Date.now() - t0;

  // Headers before any res.write — once we start streaming we can no
  // longer send a normal status-code JSON error, so all failure paths
  // below emit an `error` event on the open stream instead of res.status().
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no' // in case this ever sits behind an nginx/proxy that buffers by default
  });
  const send = (event, data) => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    if (typeof res.flush === 'function') res.flush();
  };
  // If the client disconnects mid-turn (e.g. user navigates away), stop
  // doing further work instead of burning STT/LLM/TTS calls for nobody.
  let clientGone = false;
  req.on('close', () => { clientGone = true; });

  try {
    let session, userText, history;
    try {
      ({ session, userText, history } = await runSttAndHistory(req.params.id, req.user.id, Buffer.from(audio_base64, 'base64'), mime_type));
    } catch (e) {
      send('error', { error: e.message });
      return res.end();
    }
    if (clientGone) return res.end();
    send('user_text', { text: userText });
    console.log(`[lite timing/stream] STT + history done: ${elapsed()}ms`);

    // audioResults + nextAudioIndexToSend: TTS promises are kicked off
    // the instant each sentence's text is ready (in onSentence, below),
    // but they don't all resolve in order — sentence 2's TTS might finish
    // before sentence 1's. This little queue lets each promise send its
    // audio_chunk THE MOMENT IT RESOLVES, while still guaranteeing they
    // reach the client in order (index 0 before index 1, etc.) — a
    // resolved-out-of-order result just waits in the map until its turn
    // comes up. This is what makes audio genuinely progressive: sentence
    // 1's audio can reach the client while the LLM is still generating
    // sentence 4, instead of everything arriving in one burst at the end.
    const audioResults = new Map(); // index -> {audio_base64, mime_type} | null
    let nextAudioIndexToSend = 0;
    function flushAudioQueue() {
      while (audioResults.has(nextAudioIndexToSend)) {
        const result = audioResults.get(nextAudioIndexToSend);
        audioResults.delete(nextAudioIndexToSend);
        if (result && !clientGone) {
          send('audio_chunk', { index: nextAudioIndexToSend, audio_base64: result.audio_base64, audio_mime_type: result.mime_type });
        }
        nextAudioIndexToSend++;
      }
    }

    // Fired synchronously from inside streamReply's token loop, so this
    // must NOT be awaited there — it just sends the text event and kicks
    // off TTS, then returns immediately so the LLM stream keeps being
    // read without stalling on network I/O. The TTS promise's own .then
    // is what actually sends the audio, whenever it happens to resolve —
    // could be during this same LLM stream, could be after.
    const ttsPromises = [];
    let sentenceCount = 0;
    const onSentence = (sentence, lang, index) => {
      if (clientGone) return;
      send('reply_sentence', { index, text: sentence });
      const p = synthesize(sentence, lang)
        .then(audioOut => { audioResults.set(index, audioOut); flushAudioQueue(); })
        .catch(err => {
          console.error('Lite TTS (stream) sentence failed, skipping that chunk:', err);
          audioResults.set(index, null);
          flushAudioQueue();
        });
      ttsPromises.push(p);
      sentenceCount = index + 1;
    };

    let replyText;
    try {
      const result = await streamReply(history, userText, onSentence);
      replyText = result.replyText;
    } catch (aiErr) {
      console.error('Lite LLM (stream) failed:', aiErr);
      send('error', { error: 'Reply generation failed — please try again.' });
      return res.end();
    }
    if (clientGone) return res.end();
    console.log(`[lite timing/stream] LLM stream done, ${sentenceCount} sentence(s): ${elapsed()}ms`);

    // By now most/all audio has likely already streamed out via the
    // .then() handlers above (that's the whole point) — this just waits
    // for any still in flight so we don't persist/close before everything
    // the client needs has actually been sent.
    await Promise.all(ttsPromises);
    if (clientGone) return res.end();
    console.log(`[lite timing/stream] all audio chunks done: ${elapsed()}ms`);

    // Deliberately still AWAITED, not fire-and-forget, even though this
    // is the very last thing before the response closes: by this point
    // the user already has all the text + audio they came for (both were
    // streamed above), so this DB write no longer sits in front of
    // anything they're watching/listening to — the only thing it delays
    // is the mic re-enabling for their NEXT turn, typically well under
    // 100-200ms. Not awaiting it would shave that sliver of time, but
    // opens a real correctness gap: persistTurn also bumps
    // session.turn_count, which the NEXT turn's history fetch and
    // turn_index math both depend on. If the user somehow started a new
    // turn before this write landed, that next turn could read a stale
    // turn_count and collide on turn_index. Not a trade worth making for
    // a race that's already rare and only saves ~100ms.
    try {
      await persistTurn(session, userText, replyText);
    } catch (e) {
      send('error', { error: e.message });
      return res.end();
    }

    console.log(`[lite timing/stream] TOTAL (server-side): ${elapsed()}ms`);
    send('done', { total_ms: elapsed() });
    res.end();
  } catch (err) {
    console.error('Lite turn stream failed unexpectedly:', err);
    try {
      send('error', { error: 'Unexpected server error — please try again.' });
      res.end();
    } catch (_) { /* response likely already closed */ }
  }
});

// ============================================================
// LIVE (WebSocket) TURN HANDLER — the "negligible latency" version
// ============================================================
// Everything above this point (POST /turn and POST /turn/stream) is
// untouched — this is a NEW, separate path, not a replacement, so the
// old routes remain a safe fallback while this gets validated live.
//
// Fixes, vs. the REST/SSE routes above:
//   - Audio streams to Sarvam's STT WebSocket AS THE USER TALKS (see
//     sarvamSttStreamClient.js), instead of buffering the whole
//     recording client-side and uploading it as one blob after the user
//     stops. By the time the user finishes speaking, transcription is
//     usually already mostly/fully done.
//   - TTS reuses ONE WebSocket connection across the whole turn (see
//     LiveTtsSession in sarvamTtsClient.js) instead of paying a fresh
//     TCP+TLS handshake per sentence.
//
// Wire protocol (JSON text frames both directions):
//   Client -> Server:
//     { type: 'audio_chunk', data: '<base64 raw PCM, 16kHz mono>' }  — sent repeatedly while recording
//     { type: 'stop' }                                                — user ended their turn (manual, authoritative in v1 — see note below)
//   Server -> Client:
//     { type: 'ready' }
//     { type: 'user_text', text }
//     { type: 'reply_sentence', index, text }
//     { type: 'audio_chunk', index, audio_base64, audio_mime_type }
//     { type: 'done', total_ms }
//     { type: 'error', error }
//
// NOTE ON END-OF-TURN DETECTION: Sarvam's STT WebSocket can emit
// speech_start/speech_end VAD events (see sarvamSttStreamClient.js), and
// the doc guide this was built from suggested using that to auto-end the
// turn with no manual tap needed. That part is DELIBERATELY NOT wired up
// here yet — VAD auto-cutoff changes the app's UX (users get cut off if
// the silence threshold isn't tuned right for real devices/networks) and
// can't be safely tuned or tested from this environment. `speech_end`
// still fires and is logged/available on the session object if you want
// to experiment with it, but the manual 'stop' message remains the
// authoritative turn-end trigger for now — same UX the app already has,
// just with the upload+STT latency already gone.
//
// Auth: WS handshakes from browsers can't set an Authorization header,
// so the access token comes via a query param instead:
//   wss://.../lite/sessions/:id/live?token=<supabase-access-token>
// verifyWsAuth() below wraps the Supabase call in try/catch specifically
// because an unhandled rejection from an awaited async call can crash
// the whole Node process on Node 15+ — this is the same underlying
// supabaseAnon.auth.getUser() call requireAuth() uses for the REST
// routes, just wrapped defensively here since this is new code on a new
// path. (Worth applying the same wrap to middleware/authMiddleware.js
// itself at some point — that file's outside lite/'s scope so it hasn't
// been touched here.)
async function verifyWsAuth(token) {
  if (!token) return null;
  try {
    const { data, error } = await supabaseAnon.auth.getUser(token);
    if (error || !data.user) return null;
    return data.user;
  } catch (err) {
    console.error('WS auth check threw unexpectedly:', err);
    return null;
  }
}

// One call per open WebSocket connection. `ws` is a `ws` package socket
// already accepted by the upgrade handler in index.js; `sessionRowId` and
// `userId` have already been resolved/verified by the caller.
async function handleLiveTurn(ws, sessionRowId, userId) {
  const t0 = Date.now();
  const elapsed = () => Date.now() - t0;
  const send = (type, payload) => {
    if (ws.readyState !== ws.OPEN) return;
    try { ws.send(JSON.stringify({ type, ...payload })); } catch (_) { /* socket likely closing */ }
  };

  if (!supabaseAdmin) { send('error', { error: 'Server misconfigured.' }); ws.close(1011); return; }

  let session;
  try {
    const { data, error } = await supabaseAdmin
      .from('lite_sessions')
      .select('id, turn_count')
      .eq('id', sessionRowId)
      .eq('user_id', userId)
      .single();
    if (error || !data) { send('error', { error: 'Session not found' }); ws.close(1008); return; }
    session = data;
  } catch (err) {
    console.error('Live turn: session lookup failed:', err);
    send('error', { error: 'Server error looking up session.' });
    ws.close(1011);
    return;
  }

  // History fetch starts immediately, in parallel with the STT session —
  // same principle as runSttAndHistory() above, neither depends on the
  // other.
  const historyPromise = supabaseAdmin
    .from('lite_turns')
    .select('role, content')
    .eq('session_id', session.id)
    .order('turn_index', { ascending: false })
    .limit(MAX_TURNS_CONTEXT)
    .then(r => ({ ...r, data: (r.data || []).reverse() }));

  const stt = new LiveSttSession({}); // no fixed languageCode — let Sarvam auto-detect per turn
  let sttReady = false;
  try {
    await stt.connect();
    sttReady = true;
  } catch (err) {
    console.error('Live turn: STT WebSocket connect failed:', err);
    send('error', { error: 'Could not start live transcription — please try again.' });
    ws.close(1011);
    return;
  }
  send('ready', {});
  console.log(`[lite timing/live] STT session ready: ${elapsed()}ms`);

  let clientGone = false;
  let stopReceived = false;
  const ttsSession = new LiveTtsSession();
  // Fire the TTS pool's first connection immediately, in parallel with
  // the rest of turn setup — see LiveTtsSession.prewarm()'s comment.
  // Best-effort, never awaited: if the guess is wrong or it fails, the
  // first real speak() call just reconnects as it always did.
  ttsSession.prewarm('en-IN'); // most turns open in English; wrong guess just costs a reconnect, not a delay

  ws.on('close', () => {
    clientGone = true;
    stt.abort();
    ttsSession.close();
  });

  stt.on('error', (err) => {
    console.error('Live turn: STT session error:', err);
    if (!clientGone && !stopReceived) send('error', { error: 'Transcription connection failed — please try again.' });
  });

  // Kept for future use (see the note above on VAD auto-endpointing) —
  // not wired to anything yet, just observable via logs today.
  stt.on('speechStart', () => console.log('[lite live] speech_start'));
  stt.on('speechEnd', () => console.log('[lite live] speech_end'));

  ws.on('message', (raw) => {
    if (stopReceived) return; // ignore stray audio after stop
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch (_) { return; }

    if (msg.type === 'audio_chunk' && typeof msg.data === 'string') {
      try {
        stt.pushAudioChunk(Buffer.from(msg.data, 'base64'));
      } catch (err) {
        console.error('Live turn: failed to push audio chunk:', err);
      }
    } else if (msg.type === 'stop') {
      stopReceived = true;
      runTurn().catch(err => {
        console.error('Live turn: unexpected failure:', err);
        if (!clientGone) { send('error', { error: 'Unexpected server error — please try again.' }); try { ws.close(1011); } catch (_) {} }
      });
    }
  });

  async function runTurn() {
    // DEBUG TIMING LOG — prints user text, every LLM sentence, and every
    // TTS audio chunk, each tagged with a wall-clock timestamp AND
    // elapsed-since-turn-start ms, so a full turn's timeline can be read
    // straight off the server logs. `turnId` ties every line from this
    // turn together when multiple turns/sockets are logging concurrently.
    const turnId = `${sessionRowId}-${t0}`;
    const ts = () => new Date().toISOString();
    const log = (label, extra) => {
      console.log(`[lite live][${turnId}] t=+${elapsed()}ms @${ts()} — ${label}${extra !== undefined ? ': ' + extra : ''}`);
    };

    log('turn started (stop received, finishing STT)');
    const userText = (await stt.finish()).trim();
    log('USER TEXT (final STT)', JSON.stringify(userText));

    const historyResult = await historyPromise;
    if (historyResult.error) { send('error', { error: historyResult.error.message }); return ws.close(1011); }
    const history = historyResult.data;

    if (!userText) {
      log('no speech detected — aborting turn');
      send('error', { error: 'Could not hear any speech — try again a bit louder/closer to mic.' });
      return ws.close(1000);
    }
    if (clientGone) return;
    send('user_text', { text: userText });

    const ttsPromises = [];
    let sentenceCount = 0;
    const onSentence = (sentence, lang, index) => {
      if (clientGone) return;
      log(`LLM SENTENCE #${index} (${lang})`, JSON.stringify(sentence));
      send('reply_sentence', { index, text: sentence });
      const ttsStartedAt = elapsed();
      const p = ttsSession.speak(sentence, lang)
        .catch(err => {
          console.warn(`Live TTS session failed for sentence ${index} (${err.message}), falling back to REST.`);
          return synthesize(sentence, lang).catch(err2 => {
            console.error('Live turn: REST TTS fallback also failed, skipping that chunk:', err2);
            return null;
          });
        })
        .then(audioOut => {
          if (audioOut) {
            const bytes = Math.round((audioOut.audio_base64 || '').length * 0.75); // rough base64->bytes size, just for the log
            log(`AUDIO #${index} ready (took ${elapsed() - ttsStartedAt}ms to synthesize, ~${bytes} bytes)`);
            send('audio_chunk', { index, audio_base64: audioOut.audio_base64, audio_mime_type: audioOut.mime_type });
          } else {
            log(`AUDIO #${index} FAILED — no audio produced, sentence will play silent`);
          }
        });
      ttsPromises.push(p);
      sentenceCount = index + 1;
    };

    let replyText;
    try {
      const result = await streamReply(history, userText, onSentence);
      replyText = result.replyText;
    } catch (aiErr) {
      log('LLM CALL FAILED', aiErr.message);
      console.error('Live turn: LLM call failed:', aiErr);
      send('error', { error: 'Reply generation failed — please try again.' });
      return ws.close(1011);
    }
    log(`LLM FULL REPLY (${sentenceCount} sentence(s))`, JSON.stringify(replyText));
    console.log(`[lite timing/live] LLM stream done, ${sentenceCount} sentence(s): ${elapsed()}ms`);

    await Promise.all(ttsPromises);
    if (clientGone) return;
    log('ALL AUDIO CHUNKS DONE');
    console.log(`[lite timing/live] all audio chunks done: ${elapsed()}ms`);

    try {
      await persistTurn(session, userText, replyText);
    } catch (e) {
      send('error', { error: e.message });
      return ws.close(1011);
    }

    log('TURN COMPLETE');
    console.log(`[lite timing/live] TOTAL: ${elapsed()}ms`);
    send('done', { total_ms: elapsed() });
    ttsSession.close();
    try { ws.close(1000); } catch (_) { /* already closing */ }
  }
}

module.exports = router;
module.exports.handleLiveTurn = handleLiveTurn;
module.exports.verifyWsAuth = verifyWsAuth;