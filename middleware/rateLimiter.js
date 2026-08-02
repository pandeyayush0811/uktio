const rateLimit = require('express-rate-limit');

// General API traffic. Generous on purpose — your BYOK model means the
// heavy real-time voice traffic never touches this backend at all, so
// even at 1000 concurrent users this stays light (mostly login/profile calls).
const generalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please slow down.' }
});

// Auth routes (signup/login/google) — stricter, since these are what
// credential-stuffing bots and abuse scripts target.
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many auth attempts, please try again later.' }
});

// Writes (chat session saves, profile/onboarding updates) — tighter than
// the general limiter. These touch the database and, once the analysis
// LLM feature ships, some of these will trigger paid API calls — this
// limiter is the first line of defense against a script hammering them.
const writeLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please slow down.' }
});

module.exports = { generalLimiter, authLimiter, writeLimiter };
