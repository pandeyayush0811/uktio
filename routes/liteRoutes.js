// LITE PRACTICE FEATURE — fully isolated router.
// Nothing in this file imports from chatRoutes.js, and chatRoutes.js
// imports nothing from here. Delete this file + lib/lite/ + the lite_*
// tables + the one mount line in index.js to remove the feature entirely.

const express = require('express');
const router = express.Router();
const { requireAuth } = require('../middleware/authMiddleware');
const { supabaseAdmin } = require('../lib/supabaseClient');
const { transcribeAudio } = require('../lib/lite/geminiSttClient');
const { getReplyAndCorrections } = require('../lib/lite/llmClient');
const { synthesizeSpeech } = require('../lib/lite/ttsClient');

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

    const { data: session, error: sessionErr } = await supabaseAdmin
      .from('lite_sessions')
      .select('id, turn_count')
      .eq('id', req.params.id)
      .eq('user_id', req.user.id)
      .single();
    if (sessionErr || !session) return res.status(404).json({ error: 'Session not found' });

    // 1. Speech -> text (Groq Whisper)
    const audioBuffer = Buffer.from(audio_base64, 'base64');
    let userText;
    try {
      userText = await transcribeAudio(audioBuffer, mime_type);
    } catch (sttErr) {
      console.error('Lite STT failed:', sttErr);
      return res.status(502).json({ error: 'Transcription failed — please try again.' });
    }
    if (!userText) return res.status(422).json({ error: 'Could not hear any speech — try again a bit louder/closer to mic.' });

    // 2. Pull recent context so the reply isn't stateless
    const { data: historyRows, error: historyErr } = await supabaseAdmin
      .from('lite_turns')
      .select('role, content')
      .eq('session_id', session.id)
      .order('turn_index', { ascending: false })
      .limit(MAX_TURNS_CONTEXT);
    if (historyErr) return res.status(500).json({ error: historyErr.message });
    const history = (historyRows || []).reverse();

    // 3. Text reply + inline correction (OpenAI GPT-4.1)
    let parsed;
    try {
      parsed = await getReplyAndCorrections(history, userText);
    } catch (aiErr) {
      console.error('Lite LLM call failed:', aiErr);
      return res.status(502).json({ error: 'Reply generation failed — please try again.' });
    }

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
    let audioOut = null;
    try {
      audioOut = await synthesizeSpeech(replyText);
    } catch (ttsErr) {
      console.error('Lite TTS failed (continuing without audio):', ttsErr);
    }

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