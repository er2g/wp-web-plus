/**
 * WhatsApp Web Panel - API Routes v3
 * Drive entegrasyonu ile
 */
const express = require('express');
const router = express.Router();
const accountManager = require('../services/accountManager');
const { requireAuth } = require('./middleware/auth');
const accountsRouter = require('./api/accounts');
const whatsappRouter = require('./api/whatsapp');
const scheduledRouter = require('./api/scheduled');
const webhooksRouter = require('./api/webhooks');
const scriptsRouter = require('./api/scripts');
const templatesRouter = require('./api/templates');
const aiRouter = require('./api/ai');
const logsRouter = require('./api/logs');
const statsRouter = require('./api/stats');
const reportsRouter = require('./api/reports');
const rolesRouter = require('./api/roles');
const usersRouter = require('./api/users');
const chatsRouter = require('./api/chats');
const messagesRouter = require('./api/messages');
const tagsRouter = require('./api/tags');
const contactsRouter = require('./api/contacts');
const sendRouter = require('./api/send');
const autoRepliesRouter = require('./api/autoReplies');
const mediaRouter = require('./api/media');
const driveRouter = require('./api/drive');

router.use(requireAuth);
router.use(accountManager.attachAccount.bind(accountManager));

router.use('/accounts', accountsRouter);
router.use('/', whatsappRouter);
router.use('/scheduled', scheduledRouter);
router.use('/webhooks', webhooksRouter);
router.use('/scripts', scriptsRouter);
router.use('/ai', aiRouter);
router.use('/templates', templatesRouter);
router.use('/logs', logsRouter);
router.use('/stats', statsRouter);
router.use('/reports', reportsRouter);
router.use('/roles', rolesRouter);
router.use('/users', usersRouter);

router.use('/chats', chatsRouter);
router.use('/messages', messagesRouter);
router.use('/tags', tagsRouter);
router.use('/contacts', contactsRouter);
router.use('/send', sendRouter);
router.use('/auto-replies', autoRepliesRouter);
router.use('/media', mediaRouter);
router.use('/drive', driveRouter);

module.exports = router;
