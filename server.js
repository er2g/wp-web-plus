/**
 * WhatsApp Web Panel - Main Server v2
 */
const express = require('express');
const session = require('express-session');
const { rateLimit, ipKeyGenerator } = require('express-rate-limit');
const csrf = require('csurf');
const cors = require('cors');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const { randomUUID, randomBytes } = require('crypto');

const config = require('./config');
const accountManager = require('./services/accountManager');
const { logger, requestContext } = require('./services/logger');

const authRoutes = require('./routes/auth');
const apiRoutes = require('./routes/api');

const app = express();
const server = http.createServer(app);

const isProduction = process.env.NODE_ENV === 'production';
const insecureDefaults = [];

if (config.SESSION_SECRET === 'change-this-secret-in-production') {
    insecureDefaults.push('SESSION_SECRET');
}

if (config.ADMIN_BOOTSTRAP_PASSWORD === 'changeme') {
    insecureDefaults.push('ADMIN_BOOTSTRAP_PASSWORD');
}

if (isProduction && insecureDefaults.length > 0) {
    throw new Error(`Insecure default secrets detected: ${insecureDefaults.join(', ')}. Configure environment variables before start.`);
}

if (!isProduction && insecureDefaults.length > 0) {
    console.warn(`Insecure default secrets detected (${insecureDefaults.join(', ')}). Set environment variables before deploying.`);
}

if (!config.CORS_ORIGINS) {
    throw new Error('CORS_ORIGINS environment variable is required.');
}

if (config.CORS_ORIGINS === '*') {
    if (isProduction) {
        throw new Error('CORS_ORIGINS cannot be "*" in production.');
    }
    console.warn('CORS_ORIGINS is set to "*". This should not be used in production.');
}

// Parse CORS origins from config
const corsOrigins = config.CORS_ORIGINS === '*' ? '*' : config.CORS_ORIGINS.split(',').map(o => o.trim());
const corsOptions = {
    origin: corsOrigins === '*' ? true : corsOrigins,
    credentials: true
};

// Socket.IO with path support for reverse proxy
const io = new Server(server, {
    path: '/socket.io/',
    cors: {
        origin: corsOrigins,
        credentials: true
    }
});

// Middleware
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(cors(corsOptions));

const generateRequestId = () => (typeof randomUUID === 'function' ? randomUUID() : randomBytes(16).toString('hex'));
app.use((req, res, next) => {
    const headerRequestId = req.headers['x-request-id'];
    const requestId = headerRequestId || generateRequestId();
    res.setHeader('x-request-id', requestId);

    requestContext.run({ requestId }, () => {
        req.requestId = requestId;
        req.log = logger.child({ requestId });
        next();
    });
});

// Security Headers
app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('X-XSS-Protection', '1; mode=block');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    next();
});

// Session with cookie path for reverse proxy
const sessionMiddleware = session({
    secret: config.SESSION_SECRET,
    name: "whatsapp.sid",
    resave: false,
    saveUninitialized: false,
    cookie: {
        secure: isProduction, // Use secure cookies in production
        httpOnly: true,
        sameSite: 'lax', // CSRF protection
        maxAge: 24 * 60 * 60 * 1000, // 24 hours (reduced from 7 days)
        path: '/'
    }
});
app.use(sessionMiddleware);

const csrfProtection = csrf();
app.use(csrfProtection);

app.use((req, res, next) => {
    if (typeof req.csrfToken === 'function') {
        res.cookie('XSRF-TOKEN', req.csrfToken(), {
            httpOnly: false,
            secure: isProduction,
            sameSite: 'lax',
            path: '/'
        });
    }
    next();
});

// Trust proxy for proper IP detection
app.set('trust proxy', 1);

// Static files (but not index.html automatically)
app.use(express.static(path.join(__dirname, 'public'), { index: false }));

// Routes
app.use('/auth', authRoutes);

const apiIpLimiter = rateLimit({
    windowMs: config.API_RATE_LIMIT.IP_WINDOW_MS,
    max: config.API_RATE_LIMIT.IP_MAX,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => ipKeyGenerator(req.ip || '')
});

const apiUserLimiter = rateLimit({
    windowMs: config.API_RATE_LIMIT.USER_WINDOW_MS,
    max: config.API_RATE_LIMIT.USER_MAX,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => req.session?.accountId || req.sessionID || ipKeyGenerator(req.ip || '')
});

app.use('/api', apiRoutes);

// Serve login page for unauthenticated users
app.get('/', (req, res) => {
    if (req.session && req.session.authenticated) {
        res.sendFile(path.join(__dirname, 'public', 'index.html'));
    } else {
        res.sendFile(path.join(__dirname, 'public', 'login.html'));
    }
});

// Socket.IO authentication
io.use((socket, next) => {
    sessionMiddleware(socket.request, {}, next);
});

io.on('connection', (socket) => {
    const session = socket.request.session;
    if (!session || !session.authenticated) {
        socket.disconnect();
        return;
    }

    const requestedAccount = socket.handshake.auth?.accountId;
    const accountId = requestedAccount || session.accountId || accountManager.getDefaultAccountId();
    const context = accountManager.getAccountContext(accountId);
    session.accountId = accountId;

    socket.join(accountId);
    logger.info('Client connected', { socketId: socket.id, accountId });
    socket.emit('status', context.whatsapp.getStatus());

    socket.on('disconnect', () => {
        logger.info('Client disconnected', { socketId: socket.id, accountId });
    });
});

app.use((err, req, res, next) => {
    if (err.code === 'EBADCSRFTOKEN') {
        return res.status(403).json({ error: 'Invalid CSRF token' });
    }
    return next(err);
});

// Initialize services
accountManager.setSocketIO(io);

// Global error handler
app.use((err, req, res, next) => {
    logger.error('Unhandled error', {
        requestId: req.requestId,
        error: err.message,
        stack: err.stack
    });

    res.status(err.status || 500).json({
        error: 'Internal Server Error',
        requestId: req.requestId
    });
});

// Start server
server.listen(config.PORT, () => {
    logger.info('='.repeat(50));
    logger.info('WhatsApp Web Panel v2');
    logger.info('='.repeat(50));
    logger.info('Server: http://localhost:' + config.PORT);
    logger.info('Password: [PROTECTED]');
    logger.info('='.repeat(50));

    const defaultContext = accountManager.getAccountContext(accountManager.getDefaultAccountId());

    setTimeout(() => {
        defaultContext.whatsapp.initialize().catch(err => {
            logger.error('WhatsApp init error', { error: err.message });
        });
    }, 2000);
});

// Graceful shutdown
process.on('SIGINT', () => {
    logger.info('Shutting down...');
    server.close(async () => {
        await accountManager.shutdown();
        process.exit(0);
    });
});

process.on('SIGTERM', () => {
    server.close(async () => {
        await accountManager.shutdown();
        process.exit(0);
    });
});
