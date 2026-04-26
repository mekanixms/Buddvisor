const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const bodyParser = require('body-parser');
const path = require('path');
require('dotenv').config();

const errorHandler = require('./src/middleware/errorHandler');
const logger = require('./src/utils/logger');
const { runMigrations } = require('./config/database');
const { taskExecutor } = require('./src/services/tasks/TaskExecutor');
const { registerBuiltinTools } = require('./src/services/tools/builtinTools');
const { registerWebSearchTool } = require('./src/services/tools/webSearchTool');
const { registerWebhookRequestTool } = require('./src/services/tools/webhookRequestTool');
const { registerMediaProcessingTool } = require('./src/services/tools/mediaProcessingTool');
const { registerSqliteLocalDbTool, cleanupAllDatabases } = require('./src/services/tools/sqliteLocalDbTool');
const { registerLocalWorkingFolderTool } = require('./src/services/tools/localWorkingFolderTool');
const { registerWorkspaceExecTool } = require('./src/services/tools/workspaceExecTool');
const { registerStatePersistTool, stopCleanupInterval } = require('./src/services/tools/statePersistTool');
const { registerSessionPoolTool, stopCleanupInterval: stopSessionPoolCleanupInterval } = require('./src/services/tools/sessionPoolTool');
const { registerEfApiTool } = require('./src/services/tools/efApiTool');
const { registerOpenMemoryTool } = require('./src/services/tools/openMemoryTool');
const { registerConversationHistoryTool } = require('./src/services/tools/conversationHistoryTool');
const { registerConversationRoundsTool } = require('./src/services/tools/conversationRoundsTool');
const { registerSessionScheduleTool } = require('./src/services/tools/sessionScheduleTool');
const { schedulerService } = require('./src/services/scheduler/SchedulerService');
const { toolRegistry } = require('./src/services/tools/ToolRegistry');

// Initialize Express app
const app = express();
const PORT = process.env.PORT || 3000;

// Security middleware
app.use(helmet({
  contentSecurityPolicy: {
  // Helmet's CSP defaults include `upgrade-insecure-requests`, which breaks
  // LAN HTTP usage (it upgrades /css + /js requests to https:// and fails).
  // We provide explicit directives and disable defaults.
  useDefaults: false,
    directives: {
      defaultSrc: ["'self'"],
      baseUri: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'", "https://cdn.jsdelivr.net"],
      scriptSrc: ["'self'", "'unsafe-inline'", "https://cdn.jsdelivr.net"],
      imgSrc: ["'self'", "data:", "https:"],
      connectSrc: ["'self'"],
      fontSrc: ["'self'", "https://cdn.jsdelivr.net"],
      objectSrc: ["'none'"],
      mediaSrc: ["'self'"],
      frameSrc: ["'self'", "blob:"],
      frameAncestors: ["'self'"], // Allow artifacts to be embedded in iframes
      formAction: ["'self'"],
    },
  },
  crossOriginEmbedderPolicy: false,
}));

// CORS configuration
const corsOptions = {
  origin: process.env.CORS_ORIGIN || 'http://localhost:3000',
  credentials: true,
  optionsSuccessStatus: 200
};
app.use(cors(corsOptions));

// Rate limiting
const limiter = rateLimit({
  windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS) || 15 * 60 * 1000, // 15 minutes
  max: parseInt(process.env.RATE_LIMIT_MAX_REQUESTS) || ((process.env.NODE_ENV || 'development') === 'development' ? 1000 : 100),
  message: 'Too many requests from this IP, please try again later.',
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res, next, options) => {
    const message = typeof options.message === 'string'
      ? options.message
      : 'Too many requests, please try again later.';

    res.status(options.statusCode).json({
      success: false,
      error: {
        message,
        code: 'RATE_LIMIT',
      },
    });
  },
});
app.use('/api/', limiter);

// Body parser middleware
app.use(bodyParser.json({ limit: '50mb' }));
app.use(bodyParser.urlencoded({ extended: true, limit: '50mb' }));

// Logging middleware
app.use((req, res, next) => {
  logger.info(`${req.method} ${req.url}`, {
    ip: req.ip,
    userAgent: req.get('user-agent')
  });
  next();
});

// Static files
app.use(express.static(path.join(__dirname, 'public')));

// API Routes
const authRoutes = require('./src/routes/auth.routes');
const sessionsRoutes = require('./src/routes/sessions.routes');
const chatRoutes = require('./src/routes/chat.routes');
const agentsRoutes = require('./src/routes/agents.routes');
const documentsRoutes = require('./src/routes/documents.routes');
const tasksRoutes = require('./src/routes/tasks.routes');
const toolsRoutes = require('./src/routes/tools.routes');
const conversationRoutes = require('./src/routes/conversation.routes');
const artifactsRoutes = require('./src/routes/artifacts.routes');

app.use('/api/auth', authRoutes);
app.use('/api/sessions', sessionsRoutes);
app.use('/api/chat', chatRoutes);
app.use('/api/agents', agentsRoutes);
app.use('/api/documents', documentsRoutes);
app.use('/api/tasks', tasksRoutes);
app.use('/api/tools', toolsRoutes);
app.use('/api/conversation', conversationRoutes);
app.use('/api/artifacts', artifactsRoutes);

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    uptime: process.uptime()
  });
});

// Catch-all route for SPA
app.get('*', (req, res) => {
  if (req.path.startsWith('/api/')) {
    return res.status(404).json({ error: 'API endpoint not found' });
  }
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Error handling middleware (must be last)
app.use(errorHandler);

// Register built-in tools before starting server
registerBuiltinTools();
registerWebSearchTool();
registerWebhookRequestTool();
registerMediaProcessingTool();
registerSqliteLocalDbTool();
registerLocalWorkingFolderTool();
registerWorkspaceExecTool();
registerStatePersistTool();
registerSessionPoolTool();
registerEfApiTool();
registerOpenMemoryTool();
registerConversationHistoryTool();
registerConversationRoundsTool();
registerSessionScheduleTool();
logger.info(`Registered ${toolRegistry.count} built-in tools`);

// Run database migrations and start server
runMigrations().then(() => {
  app.listen(PORT, () => {
    logger.info(`Server started on port ${PORT}`);
    logger.info(`Environment: ${process.env.NODE_ENV || 'development'}`);
    logger.info(`API available at http://localhost:${PORT}/api`);

    // Start the background task executor
    taskExecutor.start();
    logger.info('Task executor started');

    // Start the session scheduled jobs runner (cron)
    schedulerService.start();
    logger.info('Scheduler service started');

    console.log(`\n🚀 Badvisor Server`);
    console.log(`📡 Server running on port ${PORT}`);
    console.log(`🌐 Open http://localhost:${PORT} in your browser\n`);
  });
}).catch((err) => {
  logger.error('Failed to run migrations:', err);
  process.exit(1);
});

// Graceful shutdown
const gracefulShutdown = async (signal) => {
  logger.info(`${signal} signal received: closing HTTP server`);
  
  // Stop task executor
  taskExecutor.stop();

  // Stop scheduler service
  schedulerService.stop();
  
  // Stop state persist cleanup interval
  try {
    stopCleanupInterval();
  } catch (error) {
    logger.error('Error stopping state persist cleanup:', error);
  }

  // Stop session pool cleanup interval
  try {
    stopSessionPoolCleanupInterval();
  } catch (error) {
    logger.error('Error stopping session pool cleanup:', error);
  }
  
  // Checkpoint all agent SQLite databases to ensure data is persisted
  try {
    await cleanupAllDatabases();
  } catch (error) {
    logger.error('Error during database cleanup:', error);
  }
  
  // Close main database connection
  const { closeDatabase } = require('./config/database');
  try {
    await closeDatabase();
  } catch (error) {
    logger.error('Error closing main database:', error);
  }
  
  process.exit(0);
};

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

module.exports = app;
