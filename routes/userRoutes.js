const express = require('express');
const router = express.Router();
const { requireAuth } = require('../middleware/authMiddleware');
const { supabaseAdmin } = require('../lib/supabaseClient');

// Allowed goal / level / time values — keeps bad data out of the DB.
const VALID_GOALS = ['interview', 'daily_confidence', 'exam_prep', 'travel', 'content_creation', 'general'];
const VALID_LEVELS = ['beginner', 'intermediate', 'advanced'];
const VALID_TIMES = ['5_10', '15_20', '30_plus'];

// Called once, right after signup, from the mandatory onboarding screen.
// Saves the collected profile info and flips onboarding_completed to true.
router.post('/onboarding', requireAuth, async (req, res, next) => {
  try {
    if (!supabaseAdmin) {
      return res.status(500).json({ error: 'Server misconfigured: SUPABASE_SERVICE_ROLE_KEY missing.' });
    }

    const { name, age_or_class, city, goal, self_level, english_sample, daily_time } = req.body;

    if (!name || !String(name).trim()) {
      return res.status(400).json({ error: 'name is required' });
    }
    if (!goal || !VALID_GOALS.includes(goal)) {
      return res.status(400).json({ error: `goal must be one of: ${VALID_GOALS.join(', ')}` });
    }
    if (!self_level || !VALID_LEVELS.includes(self_level)) {
      return res.status(400).json({ error: `self_level must be one of: ${VALID_LEVELS.join(', ')}` });
    }
    if (!daily_time || !VALID_TIMES.includes(daily_time)) {
      return res.status(400).json({ error: `daily_time must be one of: ${VALID_TIMES.join(', ')}` });
    }

    const { data, error } = await supabaseAdmin
      .from('profiles')
      .update({
        name: String(name).trim(),
        age_or_class: age_or_class ? String(age_or_class).trim() : null,
        city: city ? String(city).trim() : null,
        goal,
        self_level,
        english_sample: english_sample ? String(english_sample).trim() : null,
        daily_time,
        onboarding_completed: true
      })
      .eq('id', req.user.id)
      .select()
      .single();

    if (error) return res.status(500).json({ error: error.message });

    res.json({ profile: data });
  } catch (err) { next(err); }
});

router.get('/me', requireAuth, async (req, res, next) => {
  try {
    let profile = null;
    if (supabaseAdmin) {
      const { data, error } = await supabaseAdmin
        .from('profiles')
        .select('*')
        .eq('id', req.user.id)
        .single();
      if (!error) profile = data;
    }

    res.json({
      id: req.user.id,
      email: req.user.email,
      created_at: req.user.created_at,
      profile
    });
  } catch (err) { next(err); }
});

module.exports = router;
