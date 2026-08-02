const express = require('express');
const router = express.Router();
const { requireAuth } = require('../middleware/authMiddleware');
const { supabaseAdmin } = require('../lib/supabaseClient');

const MAX_MESSAGES_PER_SESSION = 500; // sanity cap — a normal session is a few dozen turns

function validateMessages(messages) {
  if (!Array.isArray(messages) || messages.length === 0) return 'messages must be a non-empty array';
  if (messages.length > MAX_MESSAGES_PER_SESSION) return `messages exceeds max of ${MAX_MESSAGES_PER_SESSION}`;
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (!m || (m.role !== 'user' && m.role !== 'assistant')) return `messages[${i}].role must be "user" or "assistant"`;
    if (typeof m.content !== 'string' || !m.content.trim()) return `messages[${i}].content must be a non-empty string`;
  }
  return null;
}

// List the current user's past sessions (most recent first). Lightweight —
// no message content here, that's a separate call (GET /sessions/:id) so
// the history list loads fast even with lots of past sessions.
router.get('/sessions', requireAuth, async (req, res, next) => {
  try {
    if (!supabaseAdmin) return res.status(500).json({ error: 'Server misconfigured: SUPABASE_SERVICE_ROLE_KEY missing.' });

    const { data, error } = await supabaseAdmin
      .from('chat_sessions')
      .select('id, started_at, ended_at, turn_count, created_at')
      .eq('user_id', req.user.id)
      .order('started_at', { ascending: false });

    if (error) return res.status(500).json({ error: error.message });
    res.json({ sessions: data });
  } catch (err) { next(err); }
});

// Full transcript for one session — used by the History page (expand to
// read) and by chat.html when resuming (to seed Bolo's memory).
router.get('/sessions/:id', requireAuth, async (req, res, next) => {
  try {
    if (!supabaseAdmin) return res.status(500).json({ error: 'Server misconfigured: SUPABASE_SERVICE_ROLE_KEY missing.' });

    const { id } = req.params;

    const { data: session, error: sessionErr } = await supabaseAdmin
      .from('chat_sessions')
      .select('*')
      .eq('id', id)
      .eq('user_id', req.user.id) // ownership check — can't fetch someone else's session
      .single();

    if (sessionErr || !session) return res.status(404).json({ error: 'Session not found' });

    const { data: messages, error: messagesErr } = await supabaseAdmin
      .from('chat_messages')
      .select('role, content, turn_index')
      .eq('session_id', id)
      .order('turn_index', { ascending: true });

    if (messagesErr) return res.status(500).json({ error: messagesErr.message });

    res.json({ session, messages });
  } catch (err) { next(err); }
});

// Called once a voice session ends (or on app-open recovery for a
// session that never made it to the backend last time). Two modes:
//   - No session_id  -> creates a brand new session (turn_index starts at 0)
//   - session_id set -> RESUME: appends these turns to an existing
//                        session (turn_index continues where it left off,
//                        ended_at + turn_count get updated)
router.post('/sessions', requireAuth, async (req, res, next) => {
  try {
    if (!supabaseAdmin) return res.status(500).json({ error: 'Server misconfigured: SUPABASE_SERVICE_ROLE_KEY missing.' });

    const { session_id, started_at, ended_at, messages } = req.body;

    if (!started_at || isNaN(Date.parse(started_at))) return res.status(400).json({ error: 'started_at must be a valid ISO timestamp' });
    if (!ended_at || isNaN(Date.parse(ended_at))) return res.status(400).json({ error: 'ended_at must be a valid ISO timestamp' });
    const msgError = validateMessages(messages);
    if (msgError) return res.status(400).json({ error: msgError });

    // ---- Resume mode: append to an existing session ----
    if (session_id) {
      const { data: existing, error: existErr } = await supabaseAdmin
        .from('chat_sessions')
        .select('id, turn_count')
        .eq('id', session_id)
        .eq('user_id', req.user.id) // ownership check
        .single();

      if (existErr || !existing) return res.status(404).json({ error: 'Session to resume was not found' });

      const startIndex = existing.turn_count;
      const rows = messages.map((m, i) => ({
        session_id,
        role: m.role,
        content: m.content.trim(),
        turn_index: startIndex + i
      }));

      const { error: insertErr } = await supabaseAdmin.from('chat_messages').insert(rows);
      if (insertErr) return res.status(500).json({ error: insertErr.message });

      const newTurnCount = startIndex + rows.length;
      const { error: updateErr } = await supabaseAdmin
        .from('chat_sessions')
        .update({ ended_at, turn_count: newTurnCount })
        .eq('id', session_id);

      if (updateErr) return res.status(500).json({ error: updateErr.message });

      return res.json({ session_id, turn_count: newTurnCount });
    }

    // ---- Normal mode: brand new session ----
    const { data: session, error: sessionErr } = await supabaseAdmin
      .from('chat_sessions')
      .insert({ user_id: req.user.id, started_at, ended_at, turn_count: messages.length })
      .select()
      .single();

    if (sessionErr) return res.status(500).json({ error: sessionErr.message });

    const rows = messages.map((m, i) => ({ session_id: session.id, role: m.role, content: m.content.trim(), turn_index: i }));
    const { error: messagesErr } = await supabaseAdmin.from('chat_messages').insert(rows);

    if (messagesErr) {
      await supabaseAdmin.from('chat_sessions').delete().eq('id', session.id); // don't leave an orphaned empty session
      return res.status(500).json({ error: messagesErr.message });
    }

    res.json({ session_id: session.id, turn_count: rows.length });
  } catch (err) { next(err); }
});

module.exports = router;
