/**
 * WhatsApp Web Panel - Main Server v2
 */
const express = require('express');
const session = require('express-session');
const rateLimit = require('express-rate-limit');
const csrf = require('csurf');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const config = require('./config');
const accountManager = require('./services/accountManager');

const authRoutes = require('./routes/auth');
const apiRoutes = require('./routes/api');

const app = express();
const server = http.createServer(app);

const isProduction = process.env.NODE_ENV === 'production';

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
app.use((req, res, next) => {
    if (req.method === 'POST' && req.path === '/auth/login') {
        return next();
    }
    return csrfProtection(req, res, next);
});

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
    keyGenerator: (req) => req.ip || 'unknown'
});

const apiUserLimiter = rateLimit({
    windowMs: config.API_RATE_LIMIT.USER_WINDOW_MS,
    max: config.API_RATE_LIMIT.USER_MAX,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => req.session?.accountId || req.sessionID || req.ip || 'unknown'
});

app.use('/api', apiIpLimiter, apiUserLimiter, apiRoutes);

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
    console.log('Client connected:', socket.id, 'account:', accountId);
    socket.emit('status', context.whatsapp.getStatus());

    socket.on('disconnect', () => {
        console.log('Client disconnected:', socket.id);
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

// Start server
server.listen(config.PORT, () => {
    console.log('='.repeat(50));
    console.log('WhatsApp Web Panel v2');
    console.log('='.repeat(50));
    console.log('Server: http://localhost:' + config.PORT);
    console.log('Password: [PROTECTED]');
    console.log('='.repeat(50));

    const defaultContext = accountManager.getAccountContext(accountManager.getDefaultAccountId());

    setTimeout(() => {
        defaultContext.whatsapp.initialize().catch(err => {
            console.error('WhatsApp init error:', err.message);
        });
    }, 2000);
});

// Graceful shutdown
process.on('SIGINT', async () => {
    console.log('\nShutting down...');
    await accountManager.shutdown();
    process.exit(0);
});

process.on('SIGTERM', async () => {
    await accountManager.shutdown();
    process.exit(0);
});
