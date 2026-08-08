require('dotenv').config();
const express = require('express');
const cors = require('cors');
const morgan = require('morgan');

// Safety net: an awaited async call that rejects without a surrounding
// try/catch becomes an "unhandled rejection" — on Node 15+ that CRASHES
// the whole process by default, taking down every in-flight request
// (including unrelated ones), not just the one that failed. Individual
// routes/handlers should still catch their own errors properly (see
// verifyWsAuth in liteRoutes.js for one example) — this is only the last
// resort backstop so a missed case degrades to a logged error instead of
// a full outage + Render restart loop.
process.on('unhandledRejection', (reason) => {
  console.error('UNHANDLED PROMISE REJECTION (recovered, not crashing):', reason);
});

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
// Render (and most PaaS hosts) sit in front of this app as a reverse
// proxy, adding an X-Forwarded-For header with the real client IP.
// Without this, Express doesn't trust that header (correctly, by
// default — trusting it blindly would let a client fake their own IP
// on a setup with no proxy in front). Since we know there's exactly one
// trusted proxy hop (Render's edge), `1` tells express-rate-limit to use
// the IP one hop back from itself, i.e. the real client — not the
// proxy's own IP for every single request. Was previously throwing an
// ERR_ERL_UNEXPECTED_X_FORWARDED_FOR warning on every request.
app.set('trust proxy', 1);
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

const http = require('http');
const { WebSocketServer } = require('ws');
const { handleLiveTurn, verifyWsAuth } = require('./routes/liteRoutes');

const PORT = process.env.PORT || 3000;
const server = http.createServer(app);

// Manual WebSocket upgrade handling, scoped to exactly one path — every
// other route on this server is untouched, still plain HTTP through
// Express as before. noServer:true means this WSS instance does nothing
// on its own; we decide per-request whether to hand the upgrade to it.
const liteLiveWss = new WebSocketServer({ noServer: true });
const LIVE_TURN_PATH_RE = /^\/lite\/sessions\/([^/]+)\/live$/;

server.on('upgrade', async (req, socket, head) => {
  let url;
  try { url = new URL(req.url, `http://${req.headers.host}`); } catch (_) { socket.destroy(); return; }

  const match = LIVE_TURN_PATH_RE.exec(url.pathname);
  if (!match) { socket.destroy(); return; } // not our path — nothing else uses WS today, so just refuse

  const sessionId = match[1];
  const token = url.searchParams.get('token');
  const user = await verifyWsAuth(token).catch((err) => {
    console.error('WS upgrade auth check threw unexpectedly:', err);
    return null;
  });
  if (!user) { socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n'); socket.destroy(); return; }

  liteLiveWss.handleUpgrade(req, socket, head, (ws) => {
    handleLiveTurn(ws, sessionId, user.id).catch((err) => {
      console.error('handleLiveTurn crashed unexpectedly:', err);
      try { ws.close(1011); } catch (_) { /* already gone */ }
    });
  });
});

server.listen(PORT, () => console.log(`Uktio backend listening on port ${PORT}`));