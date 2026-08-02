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

const { generalLimiter, authLimiter } = require('./middleware/rateLimiter');
const { notFoundHandler, errorHandler } = require('./middleware/errorHandler');
const authRoutes = require('./routes/authRoutes');
const userRoutes = require('./routes/userRoutes');

const app = express();
app.use(cors());
app.use(express.json());
app.use(morgan('combined'));
app.use(generalLimiter);

app.get('/health', (req, res) => res.json({ status: 'ok', time: new Date().toISOString() }));

app.use('/auth', authLimiter, authRoutes);
app.use('/users', userRoutes);

app.use(notFoundHandler);
app.use(errorHandler);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Uktio backend listening on port ${PORT}`));
