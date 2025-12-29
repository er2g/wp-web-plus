/**
 * WhatsApp Web Panel - App Factory
 * Creates an Express app + HTTP server + Socket.IO without listening.
 */
const express = require('express');
const session = require('express-session');
const csrf = require('csurf');
const cors = require('cors');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const { randomUUID, randomBytes } = require('crypto');
const { rateLimit, ipKeyGenerator } = require('express-rate-limit');
const swaggerUi = require('swagger-ui-express');

const config = require('./config');
const { sendError } = require('./lib/httpResponses');
const accountManager = require('./services/accountManager');
const { logger, requestContext } = require('./services/logger');
const { requireAuth, requireRole } = require('./routes/middleware/auth');

const authRoutes = require('./routes/auth');
const apiRoutes = require('./routes/api');
const openapiSpec = require('./docs/openapi.json');

function createApp() {
    const app = express();
    const server = http.createServer(app);
    const startupTasks = [];
    const shutdownTasks = [];
    let redisClient = null;
    let redisPubClient = null;
    let redisSubClient = null;
    let metrics = null;

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

    const corsOrigins = config.CORS_ORIGINS === '*'
        ? '*'
        : config.CORS_ORIGINS.split(',').map(origin => origin.trim()).filter(Boolean);

    const corsOptions = {
        origin: corsOrigins === '*' ? true : corsOrigins,
        credentials: true
    };

    const io = new Server(server, {
        path: '/socket.io/',
        cors: {
            origin: corsOrigins,
            credentials: true
        }
    });

    if (config.METRICS_ENABLED) {
        const client = require('prom-client');
        const register = new client.Registry();
        register.setDefaultLabels({ instanceId: config.INSTANCE_ID });

        client.collectDefaultMetrics({ register, prefix: 'wp_panel_' });

        const httpRequestDurationSeconds = new client.Histogram({
            name: 'wp_panel_http_request_duration_seconds',
            help: 'HTTP request duration in seconds',
            labelNames: ['method', 'route', 'status'],
            buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
            registers: [register]
        });

        const httpRequestsTotal = new client.Counter({
            name: 'wp_panel_http_requests_total',
            help: 'Total number of HTTP requests',
            labelNames: ['method', 'route', 'status'],
            registers: [register]
        });

        const messagePipelineMessagesTotal = new client.Counter({
            name: 'wp_panel_message_pipeline_messages_total',
            help: 'Total number of messages entering the message pipeline',
            labelNames: ['direction'],
            registers: [register]
        });

        const messagePipelineTaskTotal = new client.Counter({
            name: 'wp_panel_message_pipeline_task_total',
            help: 'Total number of pipeline task executions by outcome',
            labelNames: ['task', 'outcome'],
            registers: [register]
        });

        metrics = {
            register,
            httpRequestDurationSeconds,
            httpRequestsTotal,
            messagePipelineMessagesTotal,
            messagePipelineTaskTotal
        };
    }

    app.use(express.json({ limit: '10mb' }));
    app.use(express.urlencoded({ extended: true }));
    app.use(cors(corsOptions));
    app.set('trust proxy', 1);

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

    app.use((req, res, next) => {
        res.setHeader('X-Content-Type-Options', 'nosniff');
        res.setHeader('X-Frame-Options', 'DENY');
        res.setHeader('X-XSS-Protection', '1; mode=block');
        res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
        next();
    });

    app.use((req, res, next) => {
        const startNs = process.hrtime.bigint();

        res.on('finish', () => {
            const routePath = req.path || req.url;
            const shouldSkip = routePath === '/healthz'
                || routePath === '/readyz'
                || routePath === '/metrics'
                || routePath.startsWith('/socket.io')
                || (!routePath.startsWith('/api') && !routePath.startsWith('/auth') && routePath.includes('.'));

            if (shouldSkip) return;

            const durationMs = Number(process.hrtime.bigint() - startNs) / 1e6;
            const routeLabel = req.route?.path
                ? `${req.baseUrl || ''}${req.route.path}`
                : 'unmatched';

            if (metrics) {
                const labels = {
                    method: req.method,
                    route: routeLabel,
                    status: String(res.statusCode)
                };
                metrics.httpRequestsTotal.inc(labels, 1);
                metrics.httpRequestDurationSeconds.observe(labels, durationMs / 1000);
            }

            const meta = {
                requestId: req.requestId,
                method: req.method,
                path: req.originalUrl || req.url,
                status: res.statusCode,
                durationMs: Math.round(durationMs * 100) / 100,
                ip: req.ip,
                accountId: req.session?.accountId,
                userId: req.session?.userId,
                role: req.session?.role
            };

            if (res.statusCode >= 500) {
                req.log.error('HTTP request failed', meta);
            } else if (res.statusCode >= 400) {
                req.log.warn('HTTP request', meta);
            } else {
                req.log.info('HTTP request', meta);
            }
        });

        next();
    });

    const sessionOptions = {
        secret: config.SESSION_SECRET,
        name: 'whatsapp.sid',
        resave: false,
        saveUninitialized: false,
        cookie: {
            secure: isProduction,
            httpOnly: true,
            sameSite: 'lax',
            maxAge: 24 * 60 * 60 * 1000,
            path: '/'
        }
    };

    if (config.REDIS_URL) {
        const { createClient } = require('redis');
        const { RedisStore } = require('connect-redis');
        const { createAdapter } = require('@socket.io/redis-adapter');

        redisClient = createClient({ url: config.REDIS_URL });
        redisClient.on('error', (error) => {
            logger.error('Redis client error', { error: error.message });
        });

        startupTasks.push(
            redisClient.connect().catch((error) => {
                logger.error('Redis connection failed', { error: error.message });
                throw error;
            })
        );

        sessionOptions.store = new RedisStore({
            client: redisClient,
            prefix: `${config.REDIS_PREFIX}sess:`
        });

        redisPubClient = redisClient.duplicate();
        redisSubClient = redisClient.duplicate();

        startupTasks.push(
            Promise.all([redisPubClient.connect(), redisSubClient.connect()])
                .then(() => {
                    io.adapter(createAdapter(redisPubClient, redisSubClient, { key: `${config.REDIS_PREFIX}socket.io` }));
                })
                .catch((error) => {
                    logger.error('Socket.IO Redis adapter init failed', { error: error.message });
                    throw error;
                })
        );

        shutdownTasks.push(async () => {
            try {
                await redisClient.quit();
            } catch (error) {
                logger.warn('Redis quit failed', { error: error.message });
            }
        });

        shutdownTasks.push(async () => {
            try {
                await redisPubClient?.quit();
            } catch (error) {
                logger.warn('Redis pubClient quit failed', { error: error.message });
            }
            try {
                await redisSubClient?.quit();
            } catch (error) {
                logger.warn('Redis subClient quit failed', { error: error.message });
            }
        });
    }

    const sessionMiddleware = session(sessionOptions);
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

    app.use(express.static(path.join(__dirname, 'public'), { index: false }));

    app.get('/healthz', (req, res) => {
        res.json({
            ok: true,
            uptime: process.uptime(),
            timestamp: Date.now()
        });
    });

    app.get('/readyz', (req, res) => {
        const redisConfigured = Boolean(config.REDIS_URL);
        const redisConnected = redisConfigured ? Boolean(redisClient?.isOpen) : false;

        const ok = redisConfigured ? redisConnected : true;

        res.status(ok ? 200 : 503).json({
            ok,
            instanceId: config.INSTANCE_ID,
            dependencies: {
                redis: {
                    configured: redisConfigured,
                    connected: redisConnected
                }
            },
            timestamp: Date.now()
        });
    });

    app.get('/openapi.json', (req, res) => {
        res.json(openapiSpec);
    });

    app.use('/docs', requireAuth, requireRole(['admin']), swaggerUi.serve, swaggerUi.setup(openapiSpec));

    if (config.METRICS_ENABLED && metrics) {
        app.get('/metrics', async (req, res) => {
            if (config.METRICS_TOKEN) {
                const authHeader = req.headers.authorization || '';
                const expected = `Bearer ${config.METRICS_TOKEN}`;
                if (authHeader !== expected) {
                    return sendError(req, res, 401, 'Unauthorized');
                }
            }

            res.setHeader('Content-Type', metrics.register.contentType);
            const payload = await metrics.register.metrics();
            return res.end(payload);
        });
    }

    const authRouter = authRoutes({ redisClient, redisPrefix: config.REDIS_PREFIX });
    app.use('/auth', authRouter);

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

    app.use('/api', apiIpLimiter, apiUserLimiter, apiRoutes);

    app.get('/', (req, res) => {
        if (req.session && req.session.authenticated) {
            res.sendFile(path.join(__dirname, 'public', 'index.html'));
        } else {
            res.sendFile(path.join(__dirname, 'public', 'login.html'));
        }
    });

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
            return sendError(req, res, 403, 'Invalid CSRF token');
        }
        return next(err);
    });

    accountManager.setSocketIO(io);
    accountManager.setMetrics(metrics);

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

    let isReady = startupTasks.length === 0;
    let readyError = null;
    const ready = Promise.all(startupTasks)
        .then(() => {
            isReady = true;
        })
        .catch((error) => {
            readyError = error;
            throw error;
        });
    const shutdown = async () => {
        for (const task of shutdownTasks) {
            await task();
        }
    };

    return {
        app,
        server,
        io,
        ready,
        shutdown,
        getReadiness: () => ({ ready: isReady, error: readyError ? String(readyError.message || readyError) : null })
    };
}

module.exports = { createApp };
