const express = require('express');
const router = express.Router();
const { requireAuth } = require('../middleware/authMiddleware');
const { supabaseAdmin } = require('../lib/supabaseClient');

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
