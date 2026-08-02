const express = require('express');
const router = express.Router();
const { requireAuth } = require('../middleware/authMiddleware');
const { supabaseAdmin } = require('../lib/supabaseClient');

const MAX_MESSAGES_PER_SESSION = 500; // sanity cap — a normal session is a few dozen turns

// Called once, right after a voice session ends (or on app-open recovery
// for a session that never made it to the backend last time). Takes the
// WHOLE session in one shot — session metadata + every turn — and bulk
// inserts it. The frontend is the source of truth for turn ordering
// during the call; this endpoint just persists what it's given.
router.post('/sessions', requireAuth, async (req, res, next) => {
  try {
    if (!supabaseAdmin) {
      return res.status(500).json({ error: 'Server misconfigured: SUPABASE_SERVICE_ROLE_KEY missing.' });
    }

    const { started_at, ended_at, messages } = req.body;

    if (!started_at || isNaN(Date.parse(started_at))) {
      return res.status(400).json({ error: 'started_at must be a valid ISO timestamp' });
    }
    if (!ended_at || isNaN(Date.parse(ended_at))) {
      return res.status(400).json({ error: 'ended_at must be a valid ISO timestamp' });
    }
    if (!Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({ error: 'messages must be a non-empty array' });
    }
    if (messages.length > MAX_MESSAGES_PER_SESSION) {
      return res.status(400).json({ error: `messages exceeds max of ${MAX_MESSAGES_PER_SESSION}` });
    }
    for (let i = 0; i < messages.length; i++) {
      const m = messages[i];
      if (!m || (m.role !== 'user' && m.role !== 'assistant')) {
        return res.status(400).json({ error: `messages[${i}].role must be "user" or "assistant"` });
      }
      if (typeof m.content !== 'string' || !m.content.trim()) {
        return res.status(400).json({ error: `messages[${i}].content must be a non-empty string` });
      }
    }

    // 1) Create the session row.
    const { data: session, error: sessionErr } = await supabaseAdmin
      .from('chat_sessions')
      .insert({
        user_id: req.user.id,
        started_at,
        ended_at,
        turn_count: messages.length
      })
      .select()
      .single();

    if (sessionErr) return res.status(500).json({ error: sessionErr.message });

    // 2) Bulk insert every turn, tagged with its position in the conversation.
    const rows = messages.map((m, i) => ({
      session_id: session.id,
      role: m.role,
      content: m.content.trim(),
      turn_index: i
    }));

    const { error: messagesErr } = await supabaseAdmin.from('chat_messages').insert(rows);

    if (messagesErr) {
      // Don't leave an orphaned empty session behind if the messages failed.
      await supabaseAdmin.from('chat_sessions').delete().eq('id', session.id);
      return res.status(500).json({ error: messagesErr.message });
    }

    res.json({ session_id: session.id, turn_count: rows.length });
  } catch (err) { next(err); }
});

module.exports = router;
