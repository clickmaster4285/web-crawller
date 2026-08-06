require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const mongoose = require('mongoose');

const { connectDatabase } = require('./config/database');
const errorHandler = require('./middleware/errorHandler');
const authRoutes = require('./routes/auth');
const dataRoutes = require('./routes/data');
const jobRoutes = require('./routes/jobs');
const matchRoutes = require('./routes/match');
const storeRoutes = require('./routes/stores');
const { spawnCrawlInfra } = require('./workers/spawn');
const { ensureDemoUser } = require('./seed');

const app = express();
const PORT = process.env.PORT;

// Rate limiting — generous enough for a demo where every page fires several
// /api/data calls plus a live crawl in one session.
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 500,
  message: 'Too many requests from this IP, please try again later.'
});

// Middleware
app.use(helmet());
app.use(cors());

app.use(limiter);
// Generous payloads: crawl results now carry the full catalogue (thousands
// of products per snapshot, capped history per origin).
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// Health check endpoint
app.get('/health', (req, res) => {
  res.status(200).json({
    status: 'OK',
    message: 'Server is running',
    timestamp: new Date().toISOString(),
    uptime: process.uptime()
  });
});

// API Routes
app.use('/api/auth', authRoutes);
app.use('/api/data', dataRoutes);
app.use('/api/crawl-jobs', jobRoutes);
app.use('/api/match', matchRoutes);
// Phase 5 read path — normalized Store/Product/Snapshot/Event reads (D1).
app.use('/api/stores', storeRoutes);

// 404 handler
app.use('*', (req, res) => {
  res.status(404).json({
    success: false,
    message: 'Route not found'
  });
});

// Global error handler
app.use(errorHandler);

// Start server
async function startServer() {
  try {
    await connectDatabase();
    // The CrawlResult model moved from one-doc-per-origin (unique origin
    // index) to snapshot history (multiple docs per origin). Drop the legacy
    // unique index on boot so history inserts don't collide. Best-effort.
    try {
      await mongoose.connection
        .collection('crawlresults')
        .dropIndex('origin_1');
      console.log('🧹 Dropped legacy crawlresults unique index');
    } catch {
      // Index already absent — nothing to do.
    }
    await ensureDemoUser();
    app.listen(PORT, () => {
      console.log(`🚀 Server is running on port ${PORT}`);
      console.log(`📊 Health check available at http://localhost:${PORT}/health`);
      console.log(`📦 Demo data available at http://localhost:${PORT}/api/data/workspace`);
      // Phase 2: crawl workers + scheduler run as separate processes. In dev
      // they're spawned alongside the API (disable with PARITY_INFRA=0); in
      // production run them independently via `npm run worker` / `npm run
      // scheduler` (or the deployment's process manager).
      spawnCrawlInfra();
    });
  } catch (error) {
    console.error('Failed to start server:', error);
    process.exit(1);
  }
}

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('SIGTERM received, shutting down gracefully');
  process.exit(0);
});

process.on('SIGINT', () => {
  console.log('SIGINT received, shutting down gracefully');
  process.exit(0);
});

startServer();
