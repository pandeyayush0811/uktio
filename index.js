require('dotenv').config();
const express = require('express');
const cors = require('cors');
const morgan = require('morgan');

// Fail fast with a clear message instead of a confusing crash later.
const requiredEnv = ['SUPABASE_URL', 'SUPABASE_ANON_KEY'];
for (const key of requiredEnv) {
  if (!process.env[key]) {
    console.error(`Missing required env var: ${key}. Copy .env.example to .env and fill it in.`);
    process.exit(1);
  }
}

// Error monitoring — optional. If SENTRY_DSN isn't set (e.g. local dev),
// this just silently no-ops, so nothing breaks without it.
const Sentry = require('@sentry/node');
if (process.env.SENTRY_DSN) {
  Sentry.init({
    dsn: process.env.SENTRY_DSN,
    tracesSampleRate: 0.1,
    // Privacy: this app handles personal conversation data (and some
    // users are minors) — never send request bodies or user PII to
    // Sentry, only the error itself.
    sendDefaultPii: false,
    dataCollection: { httpBodies: [] }
  });
  console.log('Sentry error monitoring enabled.');
} else {
  console.log('SENTRY_DSN not set — error monitoring disabled (fine for local dev).');
}

const { generalLimiter, authLimiter, writeLimiter } = require('./middleware/rateLimiter');
const { notFoundHandler, errorHandler } = require('./middleware/errorHandler');
const authRoutes = require('./routes/authRoutes');
const userRoutes = require('./routes/userRoutes');
const chatRoutes = require('./routes/chatRoutes');
const liteRoutes = require('./routes/liteRoutes');

const app = express();
app.use(cors());
app.use(express.json({ limit: '5mb' })); // was: app.use(express.json());
app.use(morgan('combined'));
app.use(generalLimiter);

app.get('/health', (req, res) => res.json({ status: 'ok', time: new Date().toISOString() }));

app.use('/auth', authLimiter, authRoutes);
// writeLimiter only kicks in for POST/PATCH — GETs (like /users/me,
// /chat/sessions) stay under the general limiter only.
app.use('/users', (req, res, next) => (req.method === 'GET' ? next() : writeLimiter(req, res, next)), userRoutes);
app.use('/chat', (req, res, next) => (req.method === 'GET' ? next() : writeLimiter(req, res, next)), chatRoutes);
app.use('/lite', (req, res, next) => (req.method === 'GET' ? next() : writeLimiter(req, res, next)), liteRoutes);

app.use(notFoundHandler);
if (process.env.SENTRY_DSN) Sentry.setupExpressErrorHandler(app); // reports to Sentry, then falls through
app.use(errorHandler); // still sends the JSON response to the client either way

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Uktio backend listening on port ${PORT}`));