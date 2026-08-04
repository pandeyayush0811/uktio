// LITE PRACTICE FEATURE — fully isolated router.
// Nothing in this file imports from chatRoutes.js, and chatRoutes.js
// imports nothing from here. Delete this file + lib/lite/ + the lite_*
// tables + the one mount line in index.js to remove the feature entirely.

const express = require('express');
const router = express.Router();
const { requireAuth } = require('../middleware/authMiddleware');
const { supabaseAdmin } = require('../lib/supabaseClient');
const { transcribeAudio } = require('../lib/lite/sarvamSttClient');
const { getReplyAndCorrections } = require('../lib/lite/llmClient');
const { synthesizeSpeech } = require('../lib/lite/sarvamTtsClient');

// How many past turns get fed back as context on each new turn — keeps
// LLM cost/latency bounded even in a long practice session.
const MAX_TURNS_CONTEXT = 20;

// Same safety net as the non-streaming route: bound how much text ever
// reaches TTS, regardless of what the LLM decides to send back.
const MAX_TTS_CHARS = 220; // ~2 short sentences of spoken English

// Splits reply text into sentence-sized pieces for pipelined TTS — each
// sentence gets synthesized (and streamed to the client) independently,
// so audio can start playing after the FIRST sentence is ready instead
// of waiting for the entire reply to finish synthesizing. Falls back to
// treating the whole string as one "sentence" if no boundary is found
// (e.g. a short reply with no punctuation).
function splitIntoSentences(text) {
  const trimmed = (text || '').trim();
  if (!trimmed) return [];
  const matches = trimmed.match(/[^.!?]+[.!?]+(\s+|$)/g);
  const sentences = (matches && matches.length ? matches : [trimmed])
    .map(s => s.trim())
    .filter(Boolean);
  return sentences.length ? sentences : [trimmed];
}

// Applies the same MAX_TTS_CHARS boundary as the non-streaming route,
// but returns it as an array of sentences ready for pipelined TTS instead
// of one big string.
function capTextForTts(replyText) {
  let capped = replyText;
  if (capped.length > MAX_TTS_CHARS) {
    const cut = capped.slice(0, MAX_TTS_CHARS);
    const lastBoundary = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('? '), cut.lastIndexOf('! '));
    capped = lastBoundary > 40 ? cut.slice(0, lastBoundary + 1) : cut;
  }
  return splitIntoSentences(capped);
}

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

// Full transcript for one session (with corrections attached to each reply).
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
      .select('role, content, mistakes, turn_index')
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

// THE CORE LOOP: one spoken turn in, one spoken (+ corrected) reply out.
// Body: { audio_base64: string, mime_type: string }
router.post('/sessions/:id/turn', requireAuth, async (req, res, next) => {
  try {
    if (!supabaseAdmin) return res.status(500).json({ error: 'Server misconfigured.' });

    const { audio_base64, mime_type } = req.body;
    if (!audio_base64 || typeof audio_base64 !== 'string') return res.status(400).json({ error: 'audio_base64 is required' });
    if (!mime_type || typeof mime_type !== 'string') return res.status(400).json({ error: 'mime_type is required' });

    // TEMP TIMING INSTRUMENTATION — remove once we've identified the
    // slow stage. Logs elapsed ms at each step so we can see exactly
    // where the turn's time is going (network upload isn't included
    // here — that happens before Express even sees the request — so
    // compare this server-side total against what the client perceives).
    const t0 = Date.now();
    const elapsed = () => Date.now() - t0;
    const timing = {};

    const { data: session, error: sessionErr } = await supabaseAdmin
      .from('lite_sessions')
      .select('id, turn_count')
      .eq('id', req.params.id)
      .eq('user_id', req.user.id)
      .single();
    if (sessionErr || !session) return res.status(404).json({ error: 'Session not found' });
    console.log(`[lite timing] session lookup done: ${elapsed()}ms`);
    timing.session_lookup_ms = elapsed();

    // 1. Speech -> text (Sarvam) AND 2. history fetch — run in parallel.
    // These two don't depend on each other (history only needs session.id,
    // not the transcribed text), so there's no reason to make one wait
    // for the other. This alone saves the full history-fetch duration
    // off the critical path (was ~100-300ms dead time before).
    const audioBuffer = Buffer.from(audio_base64, 'base64');
    const historyPromise = supabaseAdmin
      .from('lite_turns')
      .select('role, content')
      .eq('session_id', session.id)
      .order('turn_index', { ascending: false })
      .limit(MAX_TURNS_CONTEXT);

    let userText;
    let historyRows, historyErr;
    try {
      const [sttResult, historyResult] = await Promise.all([
        transcribeAudio(audioBuffer, mime_type),
        historyPromise
      ]);
      userText = sttResult;
      historyRows = historyResult.data;
      historyErr = historyResult.error;
    } catch (sttErr) {
      console.error('Lite STT failed:', sttErr);
      return res.status(502).json({ error: 'Transcription failed — please try again.' });
    }
    console.log(`[lite timing] STT + history (parallel) done: ${elapsed()}ms`);
    timing.stt_ms = elapsed();
    if (!userText) return res.status(422).json({ error: 'Could not hear any speech — try again a bit louder/closer to mic.' });
    if (historyErr) return res.status(500).json({ error: historyErr.message });
    const history = (historyRows || []).reverse();
    timing.history_fetch_ms = elapsed(); // now effectively free — ran alongside STT

    // 3. Text reply + inline correction (OpenAI GPT-4.1)
    let parsed;
    try {
      parsed = await getReplyAndCorrections(history, userText);
    } catch (aiErr) {
      console.error('Lite LLM call failed:', aiErr);
      return res.status(502).json({ error: 'Reply generation failed — please try again.' });
    }
    console.log(`[lite timing] LLM reply done: ${elapsed()}`);

    // Defensive validation — same principle as the analysis route: never
    // trust model output blindly even with a schema.
    const replyText = typeof parsed.reply === 'string' ? parsed.reply.slice(0, 2000) : '';
    const mistakes = Array.isArray(parsed.mistakes) ? parsed.mistakes.slice(0, 10).map(m => ({
      wrong: String(m.wrong || '').slice(0, 300),
      correct: String(m.correct || '').slice(0, 300),
      reason: String(m.reason || '').slice(0, 300)
    })) : [];

    // 4. Text -> speech (Gemini TTS). If this fails, don't fail the whole
    // turn — the user still gets the text + corrections, just no audio.
    // TTS time scales with how much text it has to synthesize (measured:
    // ~3.8-6s, the single biggest chunk of turn latency). The prompt
    // already asks for 1-3 short sentences, but the LLM doesn't always
    // obey — so cap what actually goes to TTS as a hard backstop. The
    // full replyText (uncapped) still gets shown in the UI and stored;
    // only the audio is bounded.
    let ttsInput = replyText;
    if (ttsInput.length > MAX_TTS_CHARS) {
      // Cut at the last sentence boundary before the limit so audio
      // doesn't end mid-word; falls back to a hard cut if no boundary found.
      const cut = ttsInput.slice(0, MAX_TTS_CHARS);
      const lastBoundary = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('? '), cut.lastIndexOf('! '));
      ttsInput = lastBoundary > 40 ? cut.slice(0, lastBoundary + 1) : cut;
    }

    let audioOut = null;
    try {
      audioOut = await synthesizeSpeech(ttsInput);
    } catch (ttsErr) {
      console.error('Lite TTS failed (continuing without audio):', ttsErr);
    }
    console.log(`[lite timing] TTS done: ${elapsed()}`);

    // 5. Persist both turns (one bulk insert, matches the existing pattern)
    const startIndex = session.turn_count;
    const rows = [
      { session_id: session.id, role: 'user', content: userText, turn_index: startIndex },
      { session_id: session.id, role: 'assistant', content: replyText, mistakes, turn_index: startIndex + 1 }
    ];
    const { error: insertErr } = await supabaseAdmin.from('lite_turns').insert(rows);
    if (insertErr) return res.status(500).json({ error: insertErr.message });

    await supabaseAdmin
      .from('lite_sessions')
      .update({ ended_at: new Date().toISOString(), turn_count: startIndex + 2 })
      .eq('id', session.id);

    console.log(`[lite timing] TOTAL (server-side, excludes upload/download): ${elapsed()}`);

    res.json({
      user_text: userText,
      reply_text: replyText,
      mistakes,
      audio_base64: audioOut ? audioOut.audio_base64 : null,
      audio_mime_type: audioOut ? audioOut.mime_type : null
    });
  } catch (err) { next(err); }
});

// THE "NEGLIGIBLE LATENCY" VERSION of the core loop, same inputs/outputs
// as POST /sessions/:id/turn, but delivered as a stream instead of one
// big blocking JSON response. The old /turn route stays exactly as-is
// above (nothing about it changed) — this is additive, so any client
// still calling /turn keeps working unmodified.
//
// Why this is the real fix, not just another shave: in the blocking
// version, TOTAL time = STT + LLM + TTS, all stacked, and the user sees
// NOTHING until all three finish. Here, the user sees the reply text the
// MOMENT the LLM is done (skips waiting for TTS entirely), and hears the
// first sentence of audio while later sentences are still being
// synthesized in the background. Server-side total work done is
// basically the same — what changes is when the client gets to react to
// each piece, which is what "feels negligible" actually means.
//
// Wire format: standard Server-Sent-Events framing (`event: NAME\ndata:
// JSON\n\n`) written over a plain POST response — NOT the browser
// EventSource API (that only supports GET). The client should POST with
// fetch() and read `response.body` with a ReadableStream reader, parsing
// `event:`/`data:` lines itself (a few lines of code — this is a very
// common pattern for streaming POST responses, same idea as how
// ChatGPT-style token streaming works over fetch).
//
// Events emitted, in order:
//   user_text   { text }                                            — as soon as STT is done
//   reply       { reply_text, mistakes }                             — as soon as the LLM is done (audio not ready yet)
//   audio_chunk { index, total, text, audio_base64, mime_type }      — one per sentence, in order, as each finishes synthesizing
//   done        { total_ms }                                        — everything finished + persisted, safe to close the connection
//   error       { error }                                            — something failed; connection ends after this, no further events
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
    const { data: session, error: sessionErr } = await supabaseAdmin
      .from('lite_sessions')
      .select('id, turn_count')
      .eq('id', req.params.id)
      .eq('user_id', req.user.id)
      .single();
    if (sessionErr || !session) { send('error', { error: 'Session not found' }); return res.end(); }

    // Same parallel STT + history fetch as the blocking route.
    const audioBuffer = Buffer.from(audio_base64, 'base64');
    const historyPromise = supabaseAdmin
      .from('lite_turns')
      .select('role, content')
      .eq('session_id', session.id)
      .order('turn_index', { ascending: false })
      .limit(MAX_TURNS_CONTEXT);

    let userText, historyRows, historyErr;
    try {
      const [sttResult, historyResult] = await Promise.all([transcribeAudio(audioBuffer, mime_type), historyPromise]);
      userText = sttResult;
      historyRows = historyResult.data;
      historyErr = historyResult.error;
    } catch (sttErr) {
      console.error('Lite STT (stream) failed:', sttErr);
      send('error', { error: 'Transcription failed — please try again.' });
      return res.end();
    }
    if (clientGone) return res.end();
    if (!userText) { send('error', { error: 'Could not hear any speech — try again a bit louder/closer to mic.' }); return res.end(); }
    if (historyErr) { send('error', { error: historyErr.message }); return res.end(); }
    const history = (historyRows || []).reverse();
    send('user_text', { text: userText });
    console.log(`[lite timing/stream] STT + history done: ${elapsed()}ms`);

    // Text reply — client already sees the user's own transcribed text;
    // now they get the reply too, WITHOUT waiting for any audio.
    let parsed;
    try {
      parsed = await getReplyAndCorrections(history, userText);
    } catch (aiErr) {
      console.error('Lite LLM (stream) failed:', aiErr);
      send('error', { error: 'Reply generation failed — please try again.' });
      return res.end();
    }
    if (clientGone) return res.end();

    const replyText = typeof parsed.reply === 'string' ? parsed.reply.slice(0, 2000) : '';
    const mistakes = Array.isArray(parsed.mistakes) ? parsed.mistakes.slice(0, 10).map(m => ({
      wrong: String(m.wrong || '').slice(0, 300),
      correct: String(m.correct || '').slice(0, 300),
      reason: String(m.reason || '').slice(0, 300)
    })) : [];

    send('reply', { reply_text: replyText, mistakes });
    console.log(`[lite timing/stream] LLM reply done (text sent): ${elapsed()}ms`);

    // Pipelined TTS: fire off every sentence's synthesis in parallel right
    // away (so total wall-clock time is bounded by the slowest sentence,
    // not the sum of all of them), then emit them to the client strictly
    // in order so playback never jumbles sentence 2 before sentence 1 —
    // even if sentence 2 happens to come back from Sarvam first.
    const sentences = capTextForTts(replyText);
    const ttsPromises = sentences.map(s =>
      synthesizeSpeech(s).catch(err => {
        console.error('Lite TTS (stream) sentence failed, skipping that chunk:', err);
        return null;
      })
    );
    for (let i = 0; i < sentences.length; i++) {
      const audioOut = await ttsPromises[i];
      if (clientGone) return res.end();
      if (audioOut) {
        send('audio_chunk', {
          index: i,
          total: sentences.length,
          text: sentences[i],
          audio_base64: audioOut.audio_base64,
          audio_mime_type: audioOut.mime_type
        });
      }
    }
    console.log(`[lite timing/stream] all audio chunks done: ${elapsed()}ms`);

    // Persist exactly like the blocking route — happens after streaming
    // so a slow/failed DB write never delays what the user hears.
    const startIndex = session.turn_count;
    const rows = [
      { session_id: session.id, role: 'user', content: userText, turn_index: startIndex },
      { session_id: session.id, role: 'assistant', content: replyText, mistakes, turn_index: startIndex + 1 }
    ];
    const { error: insertErr } = await supabaseAdmin.from('lite_turns').insert(rows);
    if (insertErr) { send('error', { error: insertErr.message }); return res.end(); }

    await supabaseAdmin
      .from('lite_sessions')
      .update({ ended_at: new Date().toISOString(), turn_count: startIndex + 2 })
      .eq('id', session.id);

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