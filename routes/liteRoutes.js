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
const { supabaseAdmin } = require('../lib/supabaseClient');
const { transcribeAudio } = require('../lib/lite/sarvamSttClient');
const { streamReply } = require('../lib/lite/llmClient');
const { synthesizeSpeech } = require('../lib/lite/sarvamTtsClient');

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
        ttsPromises.push(synthesizeSpeech(sentence, lang).catch(err => {
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

    // Fired synchronously from inside streamReply's token loop, so this
    // must NOT be awaited there — it just sends the text event and
    // pushes a TTS promise onto the queue, then returns immediately so
    // the LLM stream keeps being read without stalling on network I/O.
    const ttsPromises = [];
    let sentenceCount = 0;
    const onSentence = (sentence, lang, index) => {
      if (clientGone) return;
      send('reply_sentence', { index, text: sentence });
      ttsPromises.push(
        synthesizeSpeech(sentence, lang).catch(err => {
          console.error('Lite TTS (stream) sentence failed, skipping that chunk:', err);
          return null;
        })
      );
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

    // TTS calls were already fired as each sentence completed above —
    // this just waits for them and emits in order, so playback never
    // jumbles sentence 2 before sentence 1 even if sentence 2's TTS
    // happens to finish first (e.g. it was shorter).
    for (let i = 0; i < ttsPromises.length; i++) {
      const audioOut = await ttsPromises[i];
      if (clientGone) return res.end();
      if (audioOut) {
        send('audio_chunk', { index: i, audio_base64: audioOut.audio_base64, audio_mime_type: audioOut.mime_type });
      }
    }
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

module.exports = router;