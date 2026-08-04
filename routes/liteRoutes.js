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
    const MAX_TTS_CHARS = 220; // ~2 short sentences of spoken English
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

module.exports = router;