/**
 * WhatsApp Web Panel - Main Server v2
 */
const express = require('express');
const session = require('express-session');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const config = require('./config');
const whatsapp = require('./whatsapp');
const autoReply = require('./services/autoReply');
const scheduler = require('./services/scheduler');
const webhook = require('./services/webhook');
const scriptRunner = require('./services/scriptRunner');

const authRoutes = require('./routes/auth');
const apiRoutes = require('./routes/api');

const app = express();
const server = http.createServer(app);

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
const isProduction = process.env.NODE_ENV === 'production';
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

// Trust proxy for proper IP detection
app.set('trust proxy', 1);

// Static files (but not index.html automatically)
app.use(express.static(path.join(__dirname, 'public'), { index: false }));

// Routes
app.use('/auth', authRoutes);
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

    console.log('Client connected:', socket.id);
    socket.emit('status', whatsapp.getStatus());

    socket.on('disconnect', () => {
        console.log('Client disconnected:', socket.id);
    });
});

// Initialize services
whatsapp.setSocketIO(io);
autoReply.setWhatsApp(whatsapp);
scheduler.setWhatsApp(whatsapp);
scriptRunner.setWhatsApp(whatsapp);

// Handle incoming messages for all services
const originalHandleMessage = whatsapp.handleMessage.bind(whatsapp);
whatsapp.handleMessage = async function(msg, fromMe) {
    const result = await originalHandleMessage(msg, fromMe);

    if (result) {
        // Process auto-reply (only for incoming)
        if (!fromMe) {
            await autoReply.processMessage(result.msgData);
        }

        // Trigger webhooks
        await webhook.trigger('message', result.msgData);

        // Run scripts
        await scriptRunner.processMessage(result.msgData);
    }

    return result;
};

// Start server
server.listen(config.PORT, () => {
    console.log('='.repeat(50));
    console.log('WhatsApp Web Panel v2');
    console.log('='.repeat(50));
    console.log('Server: http://localhost:' + config.PORT);
    console.log('Password: [PROTECTED]');
    console.log('='.repeat(50));

    scheduler.start();

    setTimeout(() => {
        whatsapp.initialize().catch(err => {
            console.error('WhatsApp init error:', err.message);
        });
    }, 2000);
});

// Graceful shutdown
process.on('SIGINT', async () => {
    console.log('\nShutting down...');
    scheduler.stop();
    await whatsapp.destroy();
    process.exit(0);
});

process.on('SIGTERM', async () => {
    scheduler.stop();
    await whatsapp.destroy();
    process.exit(0);
});
