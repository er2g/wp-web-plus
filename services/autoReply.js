/**
 * WhatsApp Web Panel - Auto Reply Service
 */
const db = require('../database');

class AutoReplyService {
    constructor() {
        this.whatsapp = null;
    }

    setWhatsApp(whatsapp) {
        this.whatsapp = whatsapp;
    }

    async processMessage(msgData) {
        if (!this.whatsapp || !msgData || msgData.isFromMe) {
            return false;
        }

        const rules = db.autoReplies.getActive.all();
        const messageBody = msgData.body.toLowerCase();

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
                        console.error('Invalid regex:', rule.trigger_word);
                    }
                    break;
                case 'contains':
                default:
                    matched = messageBody.includes(trigger);
                    break;
            }

            if (matched) {
                try {
                    // Replace placeholders in response
                    let response = rule.response
                        .replace(/{name}/g, msgData.fromName || 'Friend')
                        .replace(/{message}/g, msgData.body)
                        .replace(/{time}/g, new Date().toLocaleTimeString())
                        .replace(/{date}/g, new Date().toLocaleDateString());

                    await this.whatsapp.sendMessage(msgData.chatId, response);
                    db.autoReplies.incrementCount.run(rule.id);

                    db.logs.add.run('info', 'auto-reply',
                        'Auto-reply sent for trigger: ' + rule.trigger_word,
                        JSON.stringify({ chatId: msgData.chatId, trigger: rule.trigger_word })
                    );

                    return true;
                } catch (error) {
                    db.logs.add.run('error', 'auto-reply',
                        'Failed to send auto-reply',
                        JSON.stringify({ error: error.message, rule: rule.id })
                    );
                }
            }
        }

        return false;
    }
}

module.exports = new AutoReplyService();
