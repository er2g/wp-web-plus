/**
 * WhatsApp Web Panel - Auto Reply Service
 */
const { logger } = require('./logger');
class AutoReplyService {
    constructor(db, whatsapp) {
        this.db = db;
        this.whatsapp = whatsapp;
    }

    setWhatsApp(whatsapp) {
        this.whatsapp = whatsapp;
    }

    buildTemplateContext(msgData) {
        return {
            name: msgData.fromName || 'Friend',
            message: msgData.body || '',
            time: new Date().toLocaleTimeString(),
            date: new Date().toLocaleDateString(),
            chatId: msgData.chatId || '',
            from: msgData.from || ''
        };
    }

    renderTemplate(content, context) {
        if (!content) return '';
        return content.replace(/{(\w+)}/g, (match, key) => {
            if (Object.prototype.hasOwnProperty.call(context, key)) {
                return String(context[key]);
            }
            return match;
        });
    }

    async processMessage(msgData) {
        if (!this.whatsapp || !msgData || msgData.isFromMe) {
            return false;
        }

        const rules = this.db.autoReplies.getActive.all();
        const messageBody = msgData.body.toLowerCase();
        const context = this.buildTemplateContext(msgData);

        for (const rule of rules) {
            const trigger = rule.trigger_word.toLowerCase();
            let matched = false;

            switch (rule.match_type) {
                case 'exact':
                    matched = messageBody === trigger;
                    break;
                case 'starts':
                    matched = messageBody.startsWith(trigger);
                    break;
                case 'ends':
                    matched = messageBody.endsWith(trigger);
                    break;
                case 'regex':
                    try {
                        const regex = new RegExp(rule.trigger_word, 'i');
                        matched = regex.test(msgData.body);
                    } catch (e) {
                        logger.warn('Invalid regex', {
                            category: 'auto-reply',
                            trigger: rule.trigger_word
                        });
                    }
                    break;
                case 'contains':
                default:
                    matched = messageBody.includes(trigger);
                    break;
            }

            if (matched) {
                try {
                    let responseTemplate = rule.response;
                    if (rule.template_id) {
                        const template = this.db.messageTemplates.getById.get(rule.template_id);
                        if (template) {
                            responseTemplate = template.content;
                        }
                    }

                    const response = this.renderTemplate(responseTemplate, context);
                    if (!response) {
                        this.db.logs.add.run('error', 'auto-reply',
                            'Auto-reply template rendered empty response',
                            JSON.stringify({ rule: rule.id })
                        );
                        return false;
                    }

                    await this.whatsapp.sendMessage(msgData.chatId, response);
                    this.db.autoReplies.incrementCount.run(rule.id);

                    this.db.logs.add.run('info', 'auto-reply',
                        'Auto-reply sent for trigger: ' + rule.trigger_word,
                        JSON.stringify({ chatId: msgData.chatId, trigger: rule.trigger_word })
                    );

                    return true;
                } catch (error) {
                    this.db.logs.add.run('error', 'auto-reply',
                        'Failed to send auto-reply',
                        JSON.stringify({ error: error.message, rule: rule.id })
                    );
                }
            }
        }

        return false;
    }
}

function createAutoReplyService(db, whatsapp) {
    return new AutoReplyService(db, whatsapp);
}

module.exports = { createAutoReplyService };
