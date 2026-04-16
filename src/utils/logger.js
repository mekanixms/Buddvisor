const winston = require('winston');
const path = require('path');
const fs = require('fs');

// Define log format
const logFormat = winston.format.combine(
  winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
  winston.format.errors({ stack: true }),
  winston.format.splat(),
  winston.format.json()
);

// Define log levels
const levels = {
  error: 0,
  warn: 1,
  info: 2,
  http: 3,
  debug: 4,
};

// Define colors for console output
const colors = {
  error: 'red',
  warn: 'yellow',
  info: 'green',
  http: 'magenta',
  debug: 'blue',
};

winston.addColors(colors);

// Console format for development
const consoleFormat = winston.format.combine(
  winston.format.colorize({ all: true }),
  winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
  winston.format.printf(
    (info) => `${info.timestamp} ${info.level}: ${info.message}`
  )
);

// Create logger instance
const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  levels,
  format: logFormat,
  transports: [
    // Write all logs to console
    new winston.transports.Console({
      format: consoleFormat,
    }),
    // Write all logs to file
    new winston.transports.File({
      filename: process.env.LOG_FILE || path.join(__dirname, '../../logs/app.log'),
      maxsize: 5242880, // 5MB
      maxFiles: 5,
    }),
    // Write error logs to separate file
    new winston.transports.File({
      filename: path.join(__dirname, '../../logs/error.log'),
      level: 'error',
      maxsize: 5242880,
      maxFiles: 5,
    }),
  ],
  // Handle uncaught exceptions
  exceptionHandlers: [
    new winston.transports.File({
      filename: path.join(__dirname, '../../logs/exceptions.log'),
    }),
  ],
  rejectionHandlers: [
    new winston.transports.File({
      filename: path.join(__dirname, '../../logs/rejections.log'),
    }),
  ],
});

// Create stream for Morgan HTTP logging middleware
logger.stream = {
  write: (message) => logger.http(message.trim()),
};

// Dedicated logger for agent/orchestrator prompts — writes to logs/prompts.log
// (same directory as app.log so it appears next to other logs).
const promptsLogFormat = winston.format.combine(
  winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
  winston.format.printf((info) => `${info.timestamp} ${info.message}`)
);

const appLogPath = process.env.LOG_FILE || path.join(__dirname, '../../logs/app.log');
const logsDir = path.resolve(path.dirname(appLogPath));
try {
  fs.mkdirSync(logsDir, { recursive: true });
} catch (e) { /* ignore */ }

const promptsLogger = winston.createLogger({
  level: 'info',
  format: promptsLogFormat,
  transports: [
    new winston.transports.File({
      filename: path.join(logsDir, 'prompts.log'),
      maxsize: 5242880, // 5MB
      maxFiles: 5,
    }),
  ],
});

logger.promptsLogger = promptsLogger;
module.exports = logger;
