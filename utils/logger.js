const winston = require('winston');
const path = require('path');

// Create logs directory if it doesn't exist
const fs = require('fs');
const logsDir = path.join(__dirname, '..', 'logs');
if (!fs.existsSync(logsDir)) {
    fs.mkdirSync(logsDir, { recursive: true });
}

// Log format
const logFormat = winston.format.combine(
    winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
    winston.format.errors({ stack: true }),
    winston.format.json()
);

// Console format for development
const consoleFormat = winston.format.combine(
    winston.format.colorize(),
    winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
    winston.format.printf(({ level, message, timestamp, stack }) => {
        return `${timestamp} [${level}]: ${stack || message}`;
    })
);

// Logger instance
const logger = winston.createLogger({
    level: process.env.LOG_LEVEL || 'info',
    format: logFormat,
    defaultMeta: { service: 'bot' },
    transports: [
        // Console transport
        new winston.transports.Console({
            format: consoleFormat
        }),
        
        // File transport for all logs
        new winston.transports.File({
            filename: path.join(logsDir, 'combined.log'),
            format: logFormat,
            level: 'info'
        }),
        
        // File transport for error logs
        new winston.transports.File({
            filename: path.join(logsDir, 'error.log'),
            format: logFormat,
            level: 'error'
        })
    ],
    
    // Handle exceptions and rejections
    exceptionHandlers: [
        new winston.transports.File({ 
            filename: path.join(logsDir, 'exceptions.log'),
            format: logFormat 
        })
    ],
    
    rejectionHandlers: [
        new winston.transports.File({ 
            filename: path.join(logsDir, 'rejections.log'),
            format: logFormat 
        })
    ]
});


module.exports = logger;