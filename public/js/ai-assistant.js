/**
 * WhatsApp Web Panel - AI Assistant Frontend Logic
 */

/* global api, showToast, loadScriptsData, escapeHtml, formatDateTime, renderAvatarContent, chats, archivedChats, archivedChatsLoaded, currentChat, normalizeTimestamp, getDisplayNameFromMessage, formatSenderName, getMessagePreviewText */

const AI_ASSISTANT_HISTORY_KEY = 'aiAssistantHistoryV1';
const AI_ASSISTANT_HISTORY_LIMIT = 40;

let aiAssistantState = {
    chats: [],
    chatSearch: '',
    selectedChatIds: new Set(),
    history: []
};

let aiAssistantFlow = null;

function resetAiAssistantFlow() {
    aiAssistantFlow = {
        step: 'idle',
        intent: '',
        autoReply: false,
        includeHistory: null,
        historyLimit: 40,
        persona: null,
        delayMinMs: 2000,
        delayMaxMs: 6000,
        chatIds: [],
        pendingChatMatches: []
    };
}

function aiAssistantRespond(text) {
    aiAssistantAppendHistory('assistant', text);
}

function aiAssistantParseYesNo(text) {
    const lowered = String(text || '').toLowerCase();
    if (/(evet|olur|tamam|onay|ok|yes|aynen)/.test(lowered)) return true;
    if (/(hayir|hayır|istemiyorum|olmasin|olmasın|yok|no)/.test(lowered)) return false;
    return null;
}

function aiAssistantParseHistoryAnswer(text) {
    const lowered = String(text || '').toLowerCase();
    if (/(hayir|hayır|yok|dahil etme|ekleme|istemiyorum|gerek yok)/.test(lowered)) {
        return { includeHistory: false };
    }
    const numberMatch = lowered.match(/\b(\d{1,3})\b/);
    if (numberMatch) {
        const parsed = Number.parseInt(numberMatch[1], 10);
        if (Number.isFinite(parsed)) {
            const bounded = Math.max(10, Math.min(200, parsed));
            return { includeHistory: true, historyLimit: bounded };
        }
    }
    if (/(evet|olur|dahil|ekle)/.test(lowered)) {
        return { includeHistory: true };
    }
    return null;
}

function aiAssistantParsePersona(text) {
    const lowered = String(text || '').toLowerCase();
    if (/(farketmez|normal|standart|default|bosver)/.test(lowered)) return '';
    return String(text || '').trim();
}

function aiAssistantParsePersonaHint(text) {
    const lowered = String(text || '').toLowerCase();
    if (/(samimi|kanka|muhabbet|sohbet|geyik)/.test(lowered)) {
        return 'Samimi, muhabbetci ve akici bir dil';
    }
    if (/(resmi|ciddi|kurumsal|profesyonel)/.test(lowered)) {
        return 'Resmi, net ve kisa bir dil';
    }
    if (/(esprili|komik|saka|ironik|eglenceli)/.test(lowered)) {
        return 'Hafif esprili, sicak ve samimi bir dil';
    }
    if (/(kisa|oz|ozet|tek cumle)/.test(lowered)) {
        return 'Kisa ve oz cevaplar';
    }
    return null;
}

function aiAssistantParseDelayHint(text) {
    const lowered = String(text || '').toLowerCase();
    if (/(hemen|cok hizli|acil|aninda)/.test(lowered)) {
        return { delayMinMs: 300, delayMaxMs: 1500 };
    }
    if (/(bekle biraz|biraz bekle|yavas|acele etme|sonra)/.test(lowered)) {
        return { delayMinMs: 3000, delayMaxMs: 9000 };
    }
    if (/(bekle|beklesin|dur|firsat bulunca)/.test(lowered)) {
        return { delayMinMs: 5000, delayMaxMs: 12000 };
    }
    return null;
}

function aiAssistantClampDelayRange(minMs, maxMs) {
    const rawMin = Number.isFinite(minMs) ? minMs : 0;
    const rawMax = Number.isFinite(maxMs) ? maxMs : rawMin;
    const clampedMin = Math.max(0, Math.min(30000, rawMin));
    const clampedMax = Math.max(clampedMin, Math.min(30000, rawMax));
    return { minMs: clampedMin, maxMs: clampedMax };
}

function aiAssistantDetectAutoReplyIntent(text) {
    const lowered = String(text || '').toLowerCase();
    return /(yapay zeka|\bai\b|asistan|bot|otomatik|cevap|cevapla|yazsin|yazsın|sen cevap ver|sen bak|bakarmisin|bakarmısın|bakar misin|bakar mısın|mesajlara bak|mesajlara cevap|sohbeti sen|sohbet et|muhabbet et|devam ettir)/.test(lowered);
}

function aiAssistantMatchChatsByText(text) {
    const lowered = String(text || '').toLowerCase();
    const chatsList = Array.isArray(aiAssistantState.chats) ? aiAssistantState.chats : [];
    const matches = [];
    const seen = new Set();

    const quoted = lowered.match(/["'“”‘’]([^"'“”‘’]{2,})["'“”‘’]/);
    const quotedToken = quoted ? quoted[1].trim() : '';

    chatsList.forEach((chat) => {
        const name = String(chat.name || '').trim();
        const id = String(chat.chat_id || '').trim();
        if (!id || seen.has(id)) return;

        const nameLower = name.toLowerCase();
        const idLower = id.toLowerCase();

        const nameHit = nameLower.length >= 3 && lowered.includes(nameLower);
        const idHit = idLower && lowered.includes(idLower);
        const quotedHit = quotedToken && nameLower.includes(quotedToken.toLowerCase());

        if (nameHit || idHit || quotedHit) {
            matches.push(chat);
            seen.add(id);
        }
    });

    return matches;
}

function aiAssistantFormatChatMatches(matches) {
    return matches.map((chat, idx) => {
        const name = String(chat?.name || chat?.chat_id || 'Sohbet');
        const id = String(chat?.chat_id || '').trim();
        const label = id ? `${name} (${id})` : name;
        return `${idx + 1}) ${label}`;
    }).join('\n');
}

function aiAssistantResolveChatSelection(text) {
    const lowered = String(text || '').toLowerCase();
    if (/(hepsi|tum sohbetler|tumunu|tumu)/.test(lowered)) {
        const all = (Array.isArray(aiAssistantState.chats) ? aiAssistantState.chats : [])
            .map((chat) => String(chat?.chat_id || '').trim())
            .filter(Boolean);
        return { chatIds: Array.from(new Set(all)) };
    }

    if (/(bu sohbet|su sohbet|burasi|burası)/.test(lowered) && typeof currentChat !== 'undefined' && currentChat) {
        return { chatIds: [String(currentChat)] };
    }

    const idMatch = lowered.match(/([0-9]{5,}@c\.us|[0-9a-zA-Z._-]+@g\.us)/);
    if (idMatch) {
        return { chatIds: [idMatch[1]] };
    }

    if (aiAssistantFlow && aiAssistantFlow.pendingChatMatches && aiAssistantFlow.pendingChatMatches.length) {
        const indexMatch = lowered.match(/\b(\d{1,2})\b/);
        if (indexMatch) {
            const idx = Number.parseInt(indexMatch[1], 10) - 1;
            const match = aiAssistantFlow.pendingChatMatches[idx];
            if (match?.chat_id) {
                return { chatIds: [String(match.chat_id)] };
            }
        }

        const fallback = aiAssistantFlow.pendingChatMatches.find((chat) => {
            const name = String(chat?.name || '').toLowerCase();
            return name && lowered.includes(name);
        });
        if (fallback?.chat_id) {
            return { chatIds: [String(fallback.chat_id)] };
        }
    }

    const matches = aiAssistantMatchChatsByText(text);
    if (matches.length === 1) {
        return { chatIds: [String(matches[0].chat_id)] };
    }
    if (matches.length > 1) {
        return { matches };
    }

    return { matches: [] };
}

function aiAssistantAskForChat() {
    aiAssistantFlow.step = 'awaiting_chat';
    aiAssistantRespond('Hangi sohbet(ler) icin kurayim? Sohbet adini yaz veya ID paylas. Istersen "hepsi" yazabilirsin.');
}

function aiAssistantAskForHistory() {
    aiAssistantFlow.step = 'awaiting_history';
    aiAssistantRespond('Sohbet gecmisini dahil edeyim mi? Kac mesaj olsun? (Ornek: 40). "Hayir" yazarsan eklemem.');
}

function aiAssistantAskForPersona() {
    aiAssistantFlow.step = 'awaiting_persona';
    aiAssistantRespond('Konusma tavri nasil olsun? (Ornek: samimi, resmi, kisa, esprili). "Farketmez" yazabilirsin.');
}

function aiAssistantAskForConfirm() {
    aiAssistantFlow.step = 'awaiting_confirm';
    const chatNames = aiAssistantFlow.chatIds
        .map((id) => {
            const match = (Array.isArray(aiAssistantState.chats) ? aiAssistantState.chats : []).find((c) => c?.chat_id === id);
            return match?.name || id;
        })
        .join(', ');
    const lines = [];
    lines.push('Ayarlar hazir:');
    lines.push(`- Sohbet: ${chatNames || 'Belirsiz'}`);
    lines.push(`- Mod: ${aiAssistantFlow.autoReply ? 'AI otomatik cevap' : 'Script'}`);
    if (aiAssistantFlow.autoReply) {
        const historyText = aiAssistantFlow.includeHistory
            ? `${aiAssistantFlow.historyLimit} mesaj`
            : 'Kapali';
        const personaText = aiAssistantFlow.persona ? aiAssistantFlow.persona : 'Standart';
        const delay = aiAssistantClampDelayRange(aiAssistantFlow.delayMinMs, aiAssistantFlow.delayMaxMs);
        const delayText = (delay.minMs || delay.maxMs)
            ? `${Math.round(delay.minMs / 1000)}-${Math.round(delay.maxMs / 1000)} sn`
            : 'Yok';
        lines.push(`- Gecmis: ${historyText}`);
        lines.push(`- Tavir: ${personaText}`);
        lines.push(`- Gecikme: ${delayText}`);
    }
    lines.push('Botu aktif edeyim mi? (evet/hayir)');
    aiAssistantRespond(lines.join('\n'));
}

function aiAssistantAdvanceFlow() {
    if (!aiAssistantFlow) return;
    if (!aiAssistantFlow.chatIds.length) {
        return aiAssistantAskForChat();
    }
    if (aiAssistantFlow.autoReply) {
        if (aiAssistantFlow.includeHistory === null) {
            return aiAssistantAskForHistory();
        }
        if (aiAssistantFlow.persona === null) {
            return aiAssistantAskForPersona();
        }
    }
    return aiAssistantAskForConfirm();
}

function aiAssistantBuildAutoReplyScript() {
    const chatCount = Array.isArray(aiAssistantFlow.chatIds) ? aiAssistantFlow.chatIds.length : 0;
    const chatLabel = (() => {
        if (chatCount === 1) {
            const chatId = aiAssistantFlow.chatIds[0];
            const match = (Array.isArray(aiAssistantState.chats) ? aiAssistantState.chats : []).find((c) => c?.chat_id === chatId);
            return match?.name || chatId || 'Sohbet';
        }
        if (chatCount > 1) return `${chatCount} sohbet`;
        return 'Sohbet';
    })();

    const historyLimit = aiAssistantFlow.includeHistory ? aiAssistantFlow.historyLimit : 0;
    const persona = aiAssistantFlow.persona ? aiAssistantFlow.persona.trim() : '';
    const delayRange = aiAssistantClampDelayRange(aiAssistantFlow.delayMinMs, aiAssistantFlow.delayMaxMs);

    const safePersona = JSON.stringify(persona);
    const safeHistory = Number.isFinite(historyLimit) ? Math.max(0, Math.min(200, historyLimit)) : 0;
    const minDelay = delayRange.minMs;
    const maxDelay = delayRange.maxMs;

    const code = `
const chatId = msg && msg.chatId;
const messageId = msg && msg.messageId;
if (!msg || !chatId || !messageId || msg.isFromMe) return;
if (msg.type === 'revoked') return;
if (!msg.body || !String(msg.body).trim()) return;

const storagePrefix = 'ai_auto_reply:' + chatId + ':';
const lastHandledKey = storagePrefix + 'lastHandledMessageId';
if (storage.get(lastHandledKey) === messageId) return;
storage.set(lastHandledKey, messageId);

const now = Date.now();
const windowKey = storagePrefix + 'replyWindow';
let window = storage.get(windowKey);
if (!Array.isArray(window)) window = [];
window = window.filter((ts) => typeof ts === 'number' && (now - ts) < 10 * 60 * 1000);
if (window.length >= 8) {
    storage.set(windowKey, window);
    log('AI rate limit: cevaplanmadi (chat=' + chatId + ')');
    return;
}
window.push(now);
storage.set(windowKey, window);

const minDelay = ${minDelay};
const maxDelay = ${maxDelay};
const range = Math.max(0, maxDelay - minDelay);
const delayMs = range ? Math.floor(Math.random() * (range + 1)) + minDelay : minDelay;

const run = async () => {
    const historyLimit = ${safeHistory};
    const incomingText = (msg.body && String(msg.body).trim())
        ? String(msg.body).trim()
        : (msg.type ? '[' + msg.type + ']' : '[mesaj]');

    let prompt = '';
    if (historyLimit > 0) {
        const rows = getMessages(chatId, historyLimit);
        const ordered = Array.isArray(rows)
            ? rows.slice().sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0))
            : [];
        const lines = ordered.map((m) => {
            const name = m.is_from_me ? 'Sen' : (m.from_name || m.from_number || 'Karsi taraf');
            const time = new Date(m.timestamp || Date.now()).toLocaleString();
            const body = (m.body && String(m.body).trim())
                ? String(m.body).trim()
                : (m.type ? '[' + m.type + ']' : '[mesaj]');
            return name + ' | ' + time + ' | ' + body;
        });
        if (lines.length) {
            prompt += 'Sohbet gecmisi:\\n' + lines.join('\\n') + '\\n\\n';
        }
        const lastOutgoing = ordered.slice().reverse().find((m) => m.is_from_me && m.body);
        if (lastOutgoing && lastOutgoing.body) {
            prompt += 'Son gonderilen yanit: ' + String(lastOutgoing.body).trim() + '\\n';
        }
    }

    const senderName = msg.fromName || msg.fromNumber || 'Karsi taraf';
    const persona = ${safePersona};
    prompt += 'Yeni gelen mesaj (' + senderName + '): ' + incomingText + '\\n';
    prompt += 'Dogal, akici ve insan gibi bir cevap yaz (Turkce). ';
    prompt += 'Ayni ifadeleri tekrar etme, ezbere yanit verme, kendinden bahsetme (AI oldugunu soyleme).\\n';
    prompt += 'Gerektiginde kisa bir soru sorarak muhabbeti surdur.\\n';
    if (persona) {
        prompt += 'Konusma tavri: ' + persona + '\\n';
    }
    const jitter = Math.random().toString(36).slice(2, 8);
    prompt += 'Stil tohumu: ' + jitter + '\\n';
    prompt += 'Sadece yanit metnini yaz.\\n';

    const response = await aiGenerate(prompt, { temperature: 0.7, maxTokens: 512 });
    const replyText = String(response || '').trim();
    if (!replyText) return;
    await reply(replyText);
};

if (delayMs > 0) {
    setTimeout(() => { run().catch((err) => log('AI hata: ' + err.message)); }, delayMs);
} else {
    await run();
}
`.trim();

    return {
        name: `AI Otomatik Cevap - ${chatLabel}`,
        description: 'Gelen mesajlara Gemini ile otomatik cevap verir.',
        trigger_type: 'message',
        trigger_filter: { incoming: true },
        code
    };
}

function aiAssistantHandleCommand(text) {
    const lowered = String(text || '').toLowerCase();
    if (/(sifirla|reset|yeni basla)/.test(lowered)) {
        resetAiAssistantFlow();
        aiAssistantRespond('Tamam, sifirladim. Ne yapmak istersin?');
        return true;
    }
    if (/(iptal|vazgec|vazgeç)/.test(lowered)) {
        resetAiAssistantFlow();
        aiAssistantRespond('Tamam, islemi iptal ettim. Yeni bir istek yazabilirsin.');
        return true;
    }
    if (/((gecmis|history).*temizle|temizle gecmis|temizle history)/.test(lowered)) {
        clearAiAssistantHistory();
        aiAssistantRespond('Sohbet gecmisini temizledim. Yeni bir istek yazabilirsin.');
        return true;
    }
    return false;
}

async function aiAssistantFinalizeScript() {
    const loading = document.getElementById('aiLoading');
    const sendBtn = document.getElementById('btnAiSend');
    if (loading) loading.style.display = 'block';
    if (sendBtn) sendBtn.disabled = true;

    try {
        let script = null;
        if (aiAssistantFlow.autoReply) {
            script = aiAssistantBuildAutoReplyScript();
        } else {
            const finalPrompt = buildAiAssistantPrompt(aiAssistantFlow.intent, {
                autoReply: aiAssistantFlow.autoReply,
                persona: aiAssistantFlow.persona || '',
                includeHistory: aiAssistantFlow.includeHistory,
                historyLimit: aiAssistantFlow.historyLimit
            });

            const response = await api('api/ai/generate-script', 'POST', { prompt: finalPrompt });
            if (!response?.success || !response?.script) {
                aiAssistantRespond('Script olusturulamadi. Lutfen tekrar deneyelim.');
                return;
            }
            script = response.script;
        }

        const mergedFilter = mergeAiAssistantTriggerFilter(script.trigger_filter, aiAssistantFlow.chatIds);
        if (aiAssistantFlow.autoReply) {
            mergedFilter.incoming = true;
            delete mergedFilter.outgoing;
        }

        lastGeneratedScript = { ...script, trigger_filter: mergedFilter };

        const payload = {
            name: script.name,
            description: script.description,
            code: script.code,
            trigger_type: script.trigger_type || 'message',
            trigger_filter: mergedFilter,
            is_active: true
        };

        await api('api/scripts', 'POST', payload);
        aiAssistantRespond(`Script olusturuldu ve aktif edildi: ${payload.name || 'Yeni Script'}`);
        loadScriptsData();
        resetAiAssistantFlow();
    } catch (err) {
        aiAssistantRespond('Olusturma hatasi: ' + err.message);
    } finally {
        if (loading) loading.style.display = 'none';
        if (sendBtn) sendBtn.disabled = false;
    }
}

async function sendAiAssistantMessage() {
    const input = document.getElementById('aiPromptInput');
    if (!input) return;
    const text = input.value.trim();
    if (!text) return;
    input.value = '';
    aiAssistantAppendHistory('user', text);

    if (!aiAssistantFlow) resetAiAssistantFlow();

    if (aiAssistantHandleCommand(text)) return;

    if (aiAssistantFlow.step === 'awaiting_chat') {
        const selection = aiAssistantResolveChatSelection(text);
        if (selection.chatIds && selection.chatIds.length) {
            aiAssistantFlow.chatIds = selection.chatIds;
            aiAssistantFlow.pendingChatMatches = [];
            aiAssistantAdvanceFlow();
            return;
        }
        if (selection.matches && selection.matches.length > 1) {
            aiAssistantFlow.pendingChatMatches = selection.matches;
            aiAssistantRespond('Birden fazla sohbet buldum:\n' + aiAssistantFormatChatMatches(selection.matches) + '\nLutfen numara yaz.');
            return;
        }
        aiAssistantRespond('Sohbeti bulamadim. Sohbet adini veya ID bilgisini tekrar yazar misin?');
        return;
    }

    if (aiAssistantFlow.step === 'awaiting_history') {
        const parsed = aiAssistantParseHistoryAnswer(text);
        if (!parsed) {
            aiAssistantRespond('Anlayamadim. Ornek: "40" ya da "hayir" yazabilirsin.');
            return;
        }
        aiAssistantFlow.includeHistory = parsed.includeHistory;
        if (parsed.historyLimit) aiAssistantFlow.historyLimit = parsed.historyLimit;
        aiAssistantAdvanceFlow();
        return;
    }

    if (aiAssistantFlow.step === 'awaiting_persona') {
        const persona = aiAssistantParsePersona(text);
        aiAssistantFlow.persona = persona;
        aiAssistantAdvanceFlow();
        return;
    }

    if (aiAssistantFlow.step === 'awaiting_confirm') {
        const answer = aiAssistantParseYesNo(text);
        if (answer === null) {
            aiAssistantRespond('Lutfen "evet" veya "hayir" yaz.');
            return;
        }
        if (!answer) {
            resetAiAssistantFlow();
            aiAssistantRespond('Tamam, iptal ettim. Yeni bir istek yazabilirsin.');
            return;
        }
        await aiAssistantFinalizeScript();
        return;
    }

    const autoReply = aiAssistantDetectAutoReplyIntent(text);
    resetAiAssistantFlow();
    aiAssistantFlow.intent = text;
    aiAssistantFlow.autoReply = autoReply;
    if (!autoReply) {
        aiAssistantFlow.includeHistory = false;
        aiAssistantFlow.persona = '';
    }
    if (autoReply) {
        const personaHint = aiAssistantParsePersonaHint(text);
        if (personaHint) aiAssistantFlow.persona = personaHint;

        const delayHint = aiAssistantParseDelayHint(text);
        if (delayHint) {
            const clamped = aiAssistantClampDelayRange(delayHint.delayMinMs, delayHint.delayMaxMs);
            aiAssistantFlow.delayMinMs = clamped.minMs;
            aiAssistantFlow.delayMaxMs = clamped.maxMs;
        }
    }

    const historyParsed = autoReply ? aiAssistantParseHistoryAnswer(text) : null;
    if (historyParsed) {
        aiAssistantFlow.includeHistory = historyParsed.includeHistory;
        if (historyParsed.historyLimit) aiAssistantFlow.historyLimit = historyParsed.historyLimit;
    }

    const selection = aiAssistantResolveChatSelection(text);
    if (selection.chatIds && selection.chatIds.length) {
        aiAssistantFlow.chatIds = selection.chatIds;
    } else if (selection.matches && selection.matches.length > 1) {
        aiAssistantFlow.pendingChatMatches = selection.matches;
        aiAssistantFlow.step = 'awaiting_chat';
        aiAssistantRespond('Birden fazla sohbet buldum:\n' + aiAssistantFormatChatMatches(selection.matches) + '\nLutfen numara yaz.');
        return;
    }

    aiAssistantAdvanceFlow();
}
function aiAssistantLoadHistory() {
    try {
        const raw = localStorage.getItem(AI_ASSISTANT_HISTORY_KEY);
        const parsed = raw ? JSON.parse(raw) : [];
        aiAssistantState.history = Array.isArray(parsed) ? parsed : [];
    } catch (e) {
        aiAssistantState.history = [];
    }
}

function aiAssistantSaveHistory(list) {
    try {
        localStorage.setItem(AI_ASSISTANT_HISTORY_KEY, JSON.stringify(list));
    } catch (e) {
        // Ignore storage errors
    }
}

function aiAssistantRenderHistory() {
    const container = document.getElementById('aiAssistantHistory');
    if (!container) return;

    const history = Array.isArray(aiAssistantState.history) ? aiAssistantState.history : [];
    if (!history.length) {
        container.innerHTML = '<div class="ai-chat-empty">Henuz mesaj yok. AI ile script olusturmaya basla.</div>';
        return;
    }

    const rows = history.map((entry) => {
        const role = entry?.role === 'assistant' ? 'assistant' : 'user';
        const text = String(entry?.text || '').trim();
        const safe = (typeof escapeHtml === 'function') ? escapeHtml(text) : text;
        const withBreaks = safe.replace(/\n/g, '<br>');
        const ts = entry?.ts ? new Date(entry.ts) : null;
        const timeText = ts
            ? (typeof formatDateTime === 'function' ? formatDateTime(ts.getTime()) : ts.toLocaleString())
            : '';
        return '' +
            '<div class="ai-chat-row ' + role + '">' +
                '<div class="ai-chat-bubble">' +
                    '<div class="ai-chat-text">' + withBreaks + '</div>' +
                    (timeText ? '<div class="ai-chat-meta">' + timeText + '</div>' : '') +
                '</div>' +
            '</div>';
    }).join('');

    container.innerHTML = rows;
    container.scrollTop = container.scrollHeight;
}

function aiAssistantAppendHistory(role, text) {
    const safeRole = role === 'assistant' ? 'assistant' : 'user';
    const trimmed = String(text || '').trim();
    if (!trimmed) return;
    const next = Array.isArray(aiAssistantState.history) ? [...aiAssistantState.history] : [];
    next.push({ role: safeRole, text: trimmed, ts: Date.now() });
    const limited = next.slice(-AI_ASSISTANT_HISTORY_LIMIT);
    aiAssistantState.history = limited;
    aiAssistantSaveHistory(limited);
    aiAssistantRenderHistory();
}

function clearAiAssistantHistory() {
    aiAssistantState.history = [];
    aiAssistantSaveHistory([]);
    aiAssistantRenderHistory();
}

function toggleAiAssistantAutoReply(force) {
    const toggleEl = document.getElementById('aiAssistantAutoReplyToggle');
    if (!toggleEl) return;
    const next = (typeof force === 'boolean')
        ? force
        : !toggleEl.classList.contains('active');
    toggleEl.classList.toggle('active', next);
    const personaRow = document.getElementById('aiAssistantPersonaRow');
    if (personaRow) {
        personaRow.style.display = next ? 'flex' : 'none';
    }
    const historyRow = document.getElementById('aiAssistantHistoryRow');
    if (historyRow) {
        historyRow.style.display = next ? 'flex' : 'none';
    }
}

function aiAssistantGetSelectedChatIds() {
    if (aiAssistantFlow && Array.isArray(aiAssistantFlow.chatIds) && aiAssistantFlow.chatIds.length) {
        return [...aiAssistantFlow.chatIds];
    }
    return Array.from(aiAssistantState.selectedChatIds || []);
}

function aiAssistantRenderChatPicker() {
    const listEl = document.getElementById('aiAssistantChatPickerList');
    const countEl = document.getElementById('aiAssistantChatSelectedCount');
    if (!listEl) return;

    const selected = aiAssistantState.selectedChatIds || new Set();
    const totalSelected = selected.size;
    if (countEl) {
        countEl.textContent = totalSelected + ' sohbet secildi';
    }

    const query = (aiAssistantState.chatSearch || '').trim().toLowerCase();
    const chatsList = Array.isArray(aiAssistantState.chats) ? aiAssistantState.chats : [];

    if (!chatsList.length) {
        listEl.innerHTML = '<div style="padding: 12px; color: var(--text-secondary);">Sohbet listesi yukleniyor...</div>';
        return;
    }

    const filtered = query
        ? chatsList.filter((chat) => {
            const name = String(chat.name || '').toLowerCase();
            const id = String(chat.chat_id || '').toLowerCase();
            return name.includes(query) || id.includes(query);
        })
        : chatsList;

    if (!filtered.length) {
        listEl.innerHTML = '<div style="padding: 12px; color: var(--text-secondary);">Eslesen sohbet yok</div>';
        return;
    }

    listEl.innerHTML = filtered.map((chat) => {
        const chatId = chat.chat_id || '';
        const isChecked = selected.has(chatId);
        const isGroup = typeof chatId === 'string' && chatId.includes('@g.us');
        const isArchived = chat?.is_archived === 1 || chat?.isArchived === 1 || chat?.isArchived === true || chat?.is_archived === true;
        const name = chat.name || chatId || 'Sohbet';
        const avatar = '<div class="chat-scope-avatar' + (isGroup ? ' group' : '') + '">' +
            (typeof renderAvatarContent === 'function' ? renderAvatarContent(chat) : '<i class="bi bi-person-fill"></i>') +
            '</div>';
        const metaText = String(chatId || '') + (isArchived ? ' • Arsiv' : '');
        return '<label class="chat-scope-item">' +
            '<input class="chat-scope-checkbox" type="checkbox" data-chat-id="' + escapeHtml(chatId) + '"' + (isChecked ? ' checked' : '') + '>' +
            avatar +
            '<div class="chat-scope-info">' +
                '<div class="chat-scope-name">' + escapeHtml(name) + '</div>' +
                '<div class="chat-scope-meta">' + escapeHtml(metaText) + '</div>' +
            '</div>' +
        '</label>';
    }).join('');
}

async function aiAssistantLoadChats() {
    try {
        const hasLocalChats = (typeof chats !== 'undefined') && Array.isArray(chats) && chats.length;
        const activePromise = hasLocalChats ? Promise.resolve(chats) : api('api/chats');
        const archivedPromise = (typeof archivedChatsLoaded !== 'undefined' && archivedChatsLoaded && Array.isArray(archivedChats))
            ? Promise.resolve(archivedChats)
            : api('api/chats?archived=1').catch(() => []);
        const [activeRaw, archivedRaw] = await Promise.all([activePromise, archivedPromise]);
        const activeList = Array.isArray(activeRaw) ? activeRaw : [];
        const archivedList = Array.isArray(archivedRaw) ? archivedRaw : [];

        const merged = [];
        const seen = new Set();
        const pushUnique = (item) => {
            if (!item || !item.chat_id) return;
            const id = String(item.chat_id);
            if (seen.has(id)) return;
            seen.add(id);
            merged.push(item);
        };
        activeList.forEach(pushUnique);
        archivedList.forEach(pushUnique);
        aiAssistantState.chats = merged;
    } catch (e) {
        aiAssistantState.chats = [];
    }

    if (aiAssistantState.selectedChatIds.size === 0 && typeof currentChat !== 'undefined' && currentChat) {
        aiAssistantState.selectedChatIds.add(String(currentChat));
    }
    aiAssistantRenderChatPicker();
}

function buildAiAssistantPrompt(basePrompt, options = {}) {
    const segments = [];
    if (basePrompt) segments.push(basePrompt.trim());

    if (options.autoReply) {
        const historyLimit = Number.isFinite(options.historyLimit) ? options.historyLimit : 40;
        const includeHistory = options.includeHistory !== false;
        segments.push('');
        segments.push('Ek kurallar:');
        segments.push('- Gelen mesajlara Gemini ile cevap uret (aiGenerate fonksiyonunu kullan).');
        segments.push('- Sadece gelen mesajlarda calis; kendi mesajlarina cevap verme.');
        if (includeHistory) {
            segments.push(`- Cevap yazmadan once getMessages(msg.chatId, ${historyLimit}) ile son ${historyLimit} mesaji cek.`);
            segments.push('- Mesajlari kronolojik siraya koy (eskiden yeniye).');
            segments.push('- Her mesaji "isim | tarih saat | mesaj" formatinda prompta ekle.');
            segments.push('- isim icin msg.isFromMe ise "Sen", degilse from_name/from_number kullan.');
            segments.push('- tarih saat icin new Date(m.timestamp).toLocaleString() kullan.');
        } else {
            segments.push('- Sohbet gecmisini kullanma; sadece gelen mesaji prompta ekle.');
        }
        segments.push('- Cevaplari dogal, kisa ve anlasilir tut.');
        if (options.persona) {
            segments.push('- Asistan tavri: ' + options.persona.trim());
        }
    }

    return segments.filter(Boolean).join('\n');
}

function mergeAiAssistantTriggerFilter(filter, chatIds) {
    const base = (filter && typeof filter === 'object' && !Array.isArray(filter))
        ? { ...filter }
        : {};
    const uniqueIds = Array.isArray(chatIds)
        ? Array.from(new Set(chatIds.map((id) => String(id || '').trim()).filter(Boolean)))
        : [];
    if (uniqueIds.length) {
        base.chatIds = uniqueIds;
    }
    return base;
}

function openGeminiAssistant() {
    const existing = document.getElementById('aiAssistantOverlay');
    if (existing) existing.remove();

    const modal = document.createElement('div');
    modal.id = 'aiAssistantOverlay';
    modal.className = 'modal-overlay show';
    modal.style.zIndex = '2500';
    modal.onclick = (e) => { if (e.target === modal) modal.remove(); };

    modal.innerHTML = `
        <div class="modal" style="max-width: 640px;">
            <div class="modal-header">
                <h3><i class="bi bi-magic"></i> AI Asistan</h3>
                <i class="bi bi-x-lg close-btn" onclick="this.closest('.modal-overlay').remove()"></i>
            </div>
            <div class="modal-body">
                <p style="color: var(--text-secondary); margin-bottom: 12px;">
                    Scripti robotla sohbet ederek kur. Hedef sohbeti, gecmis miktarini ve tavri birlikte belirleriz.
                </p>
                <div class="ai-chat-history" id="aiAssistantHistory"></div>
                <div class="form-group" style="margin-top: 12px;">
                    <textarea class="form-input" id="aiPromptInput" rows="2" placeholder="Mesajini yaz... (Enter gonderir, Shift+Enter satir ekler)"></textarea>
                </div>
                <div id="aiLoading" style="display: none; text-align: center; margin: 16px 0;">
                    <div class="spinner"></div>
                    <p style="margin-top: 8px; color: var(--text-secondary);">AI hazirlaniyor...</p>
                </div>
            </div>
            <div class="modal-footer" style="justify-content: space-between;">
                <button class="btn btn-secondary" onclick="closeAiAssistant()"><i class="bi bi-x"></i> Kapat</button>
                <button class="btn btn-primary" id="btnAiSend" onclick="sendAiAssistantMessage()">
                    <i class="bi bi-send"></i> Gonder
                </button>
            </div>
        </div>
    `;

    document.body.appendChild(modal);
    const input = document.getElementById('aiPromptInput');
    if (input) {
        input.focus();
        input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                sendAiAssistantMessage();
            }
        });
    }
    aiAssistantLoadHistory();
    aiAssistantRenderHistory();
    resetAiAssistantFlow();
    aiAssistantLoadChats();
    loadAiAssistantConfig();

    if (!aiAssistantState.history.length) {
        aiAssistantRespond('Merhaba! Hangi sohbette AI otomatik cevap yazsin?');
    }
}

// Backward compatibility (older UI code)
function openAiAssistant() {
    return openGeminiAssistant();
}

let lastGeneratedScript = null;

async function generateAiScript() {
    return sendAiAssistantMessage();
}

function rejectAiScript() {
    lastGeneratedScript = null;
    const resultDiv = document.getElementById('aiResult');
    const btnAccept = document.getElementById('btnAiAccept');
    const btnReject = document.getElementById('btnAiReject');
    const btnTest = document.getElementById('btnAiTest');
    const btnGenerate = document.getElementById('btnAiGenerate');
    const testResult = document.getElementById('aiTestResult');

    if (resultDiv) resultDiv.style.display = 'none';
    if (btnAccept) btnAccept.style.display = 'none';
    if (btnReject) btnReject.style.display = 'none';
    if (btnTest) btnTest.style.display = 'none';
    if (testResult) testResult.style.display = 'none';
    if (btnGenerate) btnGenerate.innerHTML = '<i class="bi bi-stars"></i> Olustur';
}

async function testAiScript() {
    if (!lastGeneratedScript || !lastGeneratedScript.code) return;
    const testResult = document.getElementById('aiTestResult');
    if (!testResult) return;

    testResult.style.display = 'block';
    testResult.style.color = 'var(--text-secondary)';
    testResult.textContent = 'Test calisiyor...';

    const testData = {
        messageId: 'test-message-id',
        chatId: 'test@c.us',
        from: '1111111111@c.us',
        to: 'me@c.us',
        fromName: 'Test',
        fromNumber: '1111111111',
        body: 'Test message',
        type: 'chat',
        timestamp: Date.now(),
        isGroup: false,
        isFromMe: false,
        mediaMimetype: null,
        mediaPath: null,
        mediaUrl: null
    };

    try {
        const result = await api('api/scripts/test', 'POST', { code: lastGeneratedScript.code, testData });
        if (result && result.success) {
            testResult.style.color = 'var(--accent)';
            testResult.textContent = 'Test basarili (' + result.duration + 'ms)';
        } else {
            testResult.style.color = '#f15c6d';
            testResult.textContent = 'Test hatasi: ' + (result?.error || 'Bilinmeyen hata');
        }
    } catch (err) {
        testResult.style.color = '#f15c6d';
        testResult.textContent = 'Test hatasi: ' + err.message;
    }
}

async function acceptAiScript() {
    if (!lastGeneratedScript) return;

    try {
        const triggerType = lastGeneratedScript.trigger_type || 'message';
        const selectedChatIds = aiAssistantGetSelectedChatIds();
        if (triggerType === 'message' && selectedChatIds.length === 0) {
            showToast('Mesaj scripti icin en az 1 hedef sohbet secin', 'error');
            return;
        }
        const mergedFilter = mergeAiAssistantTriggerFilter(lastGeneratedScript.trigger_filter, selectedChatIds);
        const payload = {
            name: lastGeneratedScript.name,
            description: lastGeneratedScript.description,
            code: lastGeneratedScript.code,
            trigger_type: triggerType,
            trigger_filter: mergedFilter
        };

        await api('api/scripts', 'POST', payload);
        closeAiAssistant();
        showToast('Script basariyla olusturuldu', 'success');

        // Refresh scripts list if we are on scripts tab
        loadScriptsData();
    } catch (err) {
        showToast('Kaydetme hatasi: ' + err.message, 'error');
    }
}

function closeAiAssistant() {
    const overlay = document.getElementById('aiAssistantOverlay');
    if (overlay) overlay.remove();
}

function toggleAiAssistantModelInput(value) {
    const customInput = document.getElementById('aiAssistantModelCustomInput');
    if (!customInput) return;
    customInput.style.display = (value === 'custom') ? 'block' : 'none';
}

async function loadAiAssistantConfig() {
    try {
        const result = await api('api/ai/config');
        chatAnalysisState.hasKey = Boolean(result?.hasKey);
        chatAnalysisState.savedModel = String(result?.model || '');
        const maxTokensParsed = Number.parseInt(String(result?.maxTokens || ''), 10);
        chatAnalysisState.savedMaxTokens = Number.isFinite(maxTokensParsed) ? maxTokensParsed : null;

        const select = document.getElementById('aiAssistantModelSelect');
        const customInput = document.getElementById('aiAssistantModelCustomInput');
        if (select) {
            const known = ['gemini-2.5-flash', 'gemini-2.5-pro'];
            const deprecated = ['gemini-1.5-flash', 'gemini-1.5-pro', 'gemini-2.0-flash'];
            const fallback = 'gemini-2.5-flash';
            const effectiveModel = deprecated.includes(chatAnalysisState.savedModel)
                ? fallback
                : chatAnalysisState.savedModel;
            if (effectiveModel && known.includes(effectiveModel)) {
                select.value = effectiveModel;
                toggleAiAssistantModelInput(select.value);
            } else if (effectiveModel) {
                select.value = 'custom';
                toggleAiAssistantModelInput('custom');
                if (customInput) customInput.value = effectiveModel;
            }
        }
        const maxTokensInput = document.getElementById('aiAssistantMaxTokens');
        if (maxTokensInput) {
            const fallback = 2048;
            const value = Number.isFinite(chatAnalysisState.savedMaxTokens) ? chatAnalysisState.savedMaxTokens : fallback;
            maxTokensInput.value = String(value);
        }
    } catch (err) {
        // Keep defaults if config is unavailable.
    }
}

let chatAnalysisState = {
    hasKey: false,
    savedModel: '',
    savedMaxTokens: null
};

function openChatAnalysis() {
    const activeChatId = (typeof currentChat !== 'undefined' ? currentChat : null);
    if (!activeChatId) {
        showToast('Once bir sohbet secin', 'info');
        return;
    }

    const existing = document.getElementById('chatAnalysisOverlay');
    if (existing) existing.remove();

    const rawChatName = document.getElementById('chatName')?.textContent || activeChatId || 'Sohbet';
    const chatName = (typeof escapeHtml === 'function') ? escapeHtml(rawChatName) : rawChatName;

    const modal = document.createElement('div');
    modal.id = 'chatAnalysisOverlay';
    modal.className = 'modal-overlay show';
    modal.style.zIndex = '2500';
    modal.onclick = (e) => { if (e.target === modal) modal.remove(); };

    modal.innerHTML = `
        <div class="modal" style="max-width: 720px;">
            <div class="modal-header">
                <h3><i class="bi bi-graph-up-arrow"></i> Sohbet Analizi</h3>
                <i class="bi bi-x-lg close-btn" onclick="this.closest('.modal-overlay').remove()"></i>
            </div>
            <div class="modal-body">
                <p style="color: var(--text-secondary); margin-bottom: 12px;">
                    <strong>${chatName}</strong> sohbetinden son mesajlari Gemini ile analiz et.
                </p>
                <div class="settings-section" style="margin-bottom: 16px;">
                    <div class="settings-section-title">Gemini Ayarlari</div>
                    <div class="settings-item">
                        <i class="icon bi bi-key"></i>
                        <div class="info">
                            <div class="title">API Anahtari</div>
                            <div class="subtitle">Gemini API anahtarini kaydet</div>
                        </div>
                        <div style="display: flex; flex-direction: column; gap: 8px; width: 50%;">
                            <input type="password" class="form-input" id="chatAnalysisApiKeyInput" placeholder="AI...">
                            <div style="display: flex; gap: 8px; align-items: center;">
                                <button class="btn btn-secondary btn-sm" type="button" onclick="saveChatAnalysisConfig()">Kaydet</button>
                                <span id="chatAnalysisKeyStatus" style="font-size: 11px; color: var(--text-secondary);">Kontrol ediliyor...</span>
                            </div>
                        </div>
                    </div>
                    <div class="settings-item">
                        <i class="icon bi bi-cpu"></i>
                        <div class="info">
                            <div class="title">Model</div>
                            <div class="subtitle">Analizde kullanilacak Gemini modeli</div>
                        </div>
                        <div style="display: flex; flex-direction: column; gap: 8px; width: 50%;">
                            <select id="chatAnalysisModelSelect" class="select-input" onchange="toggleChatAnalysisModelInput(this.value)">
                                <option value="gemini-2.5-flash">gemini-2.5-flash</option>
                                <option value="gemini-2.5-pro">gemini-2.5-pro</option>
                                <option value="custom">Ozel</option>
                            </select>
                            <input type="text" class="form-input" id="chatAnalysisModelCustomInput" placeholder="gemini-2.5-flash-latest" style="display:none;">
                        </div>
                    </div>
                    <div class="settings-item">
                        <i class="icon bi bi-sliders"></i>
                        <div class="info">
                            <div class="title">Maksimum Token</div>
                            <div class="subtitle">Daha yuksek deger daha uzun cevap verir</div>
                        </div>
                        <input type="number" class="form-input" id="chatAnalysisMaxTokens" min="256" max="8192" step="128" value="4096" style="width: 120px;">
                    </div>
                </div>
                <div class="settings-section" style="margin-bottom: 16px;">
                    <div class="settings-section-title">Analiz Kapsami</div>
                    <div class="settings-item">
                        <i class="icon bi bi-chat-left-text"></i>
                        <div class="info">
                            <div class="title">Mesaj Sayisi</div>
                            <div class="subtitle">Analize girecek son mesaj adedi</div>
                        </div>
                        <input type="number" class="form-input" id="chatAnalysisMessageCount" min="10" max="1000" value="120" style="width: 120px;">
                    </div>
                    <div class="settings-item">
                        <i class="icon bi bi-lightbulb"></i>
                        <div class="info">
                            <div class="title">Analiz Istegi</div>
                            <div class="subtitle">AI'dan ne istediginizi yazin</div>
                        </div>
                        <textarea class="form-input" id="chatAnalysisPromptInput" rows="3" placeholder="Ornek: Konusmanin ozetini ve duygusal tonunu cikart."></textarea>
                    </div>
                </div>
                <div id="chatAnalysisLoading" style="display: none; text-align: center; margin: 20px 0;">
                    <div class="spinner"></div>
                    <p style="margin-top: 8px; color: var(--text-secondary);">Analiz yapiliyor...</p>
                </div>
                <div id="chatAnalysisResult" style="display: none; margin-top: 12px;">
                    <div class="analysis-result" id="chatAnalysisResultText"></div>
                </div>
            </div>
            <div class="modal-footer" style="justify-content: space-between;">
                <button class="btn btn-secondary" onclick="closeChatAnalysis()"><i class="bi bi-x"></i> Kapat</button>
                <button class="btn btn-primary" onclick="runChatAnalysis()"><i class="bi bi-play-circle"></i> Analiz Et</button>
            </div>
        </div>
    `;

    document.body.appendChild(modal);
    loadChatAnalysisConfig();
}

function closeChatAnalysis() {
    const overlay = document.getElementById('chatAnalysisOverlay');
    if (overlay) overlay.remove();
}

function toggleChatAnalysisModelInput(value) {
    const customInput = document.getElementById('chatAnalysisModelCustomInput');
    if (!customInput) return;
    customInput.style.display = (value === 'custom') ? 'block' : 'none';
}

function getChatAnalysisModelValue() {
    const select = document.getElementById('chatAnalysisModelSelect');
    const customInput = document.getElementById('chatAnalysisModelCustomInput');
    if (!select) return '';
    if (select.value === 'custom') {
        return String(customInput?.value || '').trim();
    }
    return select.value;
}

async function loadChatAnalysisConfig() {
    const statusEl = document.getElementById('chatAnalysisKeyStatus');
    if (statusEl) statusEl.textContent = 'Kontrol ediliyor...';

    try {
        const result = await api('api/ai/config');
        chatAnalysisState.hasKey = Boolean(result?.hasKey);
        chatAnalysisState.savedModel = String(result?.model || '');
        const maxTokensParsed = Number.parseInt(String(result?.maxTokens || ''), 10);
        chatAnalysisState.savedMaxTokens = Number.isFinite(maxTokensParsed) ? maxTokensParsed : null;

        if (statusEl) {
            statusEl.textContent = chatAnalysisState.hasKey ? 'Anahtar kayitli' : 'Anahtar kayitli degil';
        }

        const select = document.getElementById('chatAnalysisModelSelect');
        const customInput = document.getElementById('chatAnalysisModelCustomInput');
        if (select) {
            const known = ['gemini-2.5-flash', 'gemini-2.5-pro'];
            const deprecated = ['gemini-1.5-flash', 'gemini-1.5-pro', 'gemini-2.0-flash'];
            const fallback = 'gemini-2.5-flash';
            const effectiveModel = deprecated.includes(chatAnalysisState.savedModel)
                ? fallback
                : chatAnalysisState.savedModel;
            if (effectiveModel && known.includes(effectiveModel)) {
                select.value = effectiveModel;
                toggleChatAnalysisModelInput(select.value);
            } else if (effectiveModel) {
                select.value = 'custom';
                toggleChatAnalysisModelInput('custom');
                if (customInput) customInput.value = effectiveModel;
            }
        }
        const maxTokensInput = document.getElementById('chatAnalysisMaxTokens');
        if (maxTokensInput) {
            const fallback = 4096;
            const value = Number.isFinite(chatAnalysisState.savedMaxTokens) ? chatAnalysisState.savedMaxTokens : fallback;
            maxTokensInput.value = String(value);
        }
    } catch (err) {
        if (statusEl) statusEl.textContent = 'AI ayarlari okunamadi';
    }
}

async function saveChatAnalysisConfig() {
    const apiKeyInput = document.getElementById('chatAnalysisApiKeyInput');
    const apiKey = String(apiKeyInput?.value || '').trim();
    const model = getChatAnalysisModelValue();
    const maxTokensInput = document.getElementById('chatAnalysisMaxTokens');
    const maxTokensRaw = maxTokensInput ? Number.parseInt(String(maxTokensInput.value || ''), 10) : NaN;
    const maxTokens = Number.isFinite(maxTokensRaw)
        ? Math.max(256, Math.min(8192, maxTokensRaw))
        : null;

    const payload = {};
    if (apiKey) payload.apiKey = apiKey;
    if (model) payload.model = model;
    if (maxTokens) payload.maxTokens = maxTokens;

    if (!payload.apiKey && !payload.model && !payload.maxTokens) {
        showToast('Kaydedilecek veri yok', 'info');
        return;
    }

    try {
        const result = await api('api/ai/config', 'POST', payload);
        chatAnalysisState.hasKey = Boolean(result?.hasKey);
        chatAnalysisState.savedModel = String(result?.model || '');
        const maxTokensParsed = Number.parseInt(String(result?.maxTokens || ''), 10);
        chatAnalysisState.savedMaxTokens = Number.isFinite(maxTokensParsed)
            ? maxTokensParsed
            : chatAnalysisState.savedMaxTokens;
        if (apiKeyInput) apiKeyInput.value = '';
        const statusEl = document.getElementById('chatAnalysisKeyStatus');
        if (statusEl) statusEl.textContent = chatAnalysisState.hasKey ? 'Anahtar kayitli' : 'Anahtar kayitli degil';
        showToast('AI ayarlari kaydedildi', 'success');
    } catch (err) {
        showToast('AI ayarlari kaydedilemedi: ' + err.message, 'error');
    }
}

async function persistChatAnalysisSettings(model, maxTokens) {
    const trimmed = String(model || '').trim();
    const tokens = Number.isFinite(maxTokens) ? Math.max(256, Math.min(8192, maxTokens)) : null;
    const needsModel = trimmed && chatAnalysisState.savedModel !== trimmed;
    const needsTokens = tokens && chatAnalysisState.savedMaxTokens !== tokens;
    if (!needsModel && !needsTokens) return true;

    const payload = {};
    if (needsModel) payload.model = trimmed;
    if (needsTokens) payload.maxTokens = tokens;

    try {
        const result = await api('api/ai/config', 'POST', payload);
        if (needsModel) {
            chatAnalysisState.savedModel = String(result?.model || trimmed);
        }
        if (needsTokens) {
            const maxTokensParsed = Number.parseInt(String(result?.maxTokens || ''), 10);
            chatAnalysisState.savedMaxTokens = Number.isFinite(maxTokensParsed)
                ? maxTokensParsed
                : tokens;
        }
        return true;
    } catch (err) {
        showToast('AI ayarlari kaydedilemedi: ' + err.message, 'error');
        return false;
    }
}

async function runChatAnalysis() {
    const activeChatId = (typeof currentChat !== 'undefined' ? currentChat : null);
    if (!activeChatId) {
        showToast('Once bir sohbet secin', 'info');
        return;
    }

    const loading = document.getElementById('chatAnalysisLoading');
    const resultWrap = document.getElementById('chatAnalysisResult');
    const resultText = document.getElementById('chatAnalysisResultText');
    const countInput = document.getElementById('chatAnalysisMessageCount');
    const promptInput = document.getElementById('chatAnalysisPromptInput');

    const requestedCount = Number.parseInt(String(countInput?.value || '0'), 10);
    const messageCount = Number.isFinite(requestedCount)
        ? Math.max(10, Math.min(1000, requestedCount))
        : 120;
    const model = getChatAnalysisModelValue();
    if (!model) {
        showToast('Model secin', 'info');
        return;
    }

    const maxTokensInput = document.getElementById('chatAnalysisMaxTokens');
    const maxTokensRaw = maxTokensInput ? Number.parseInt(String(maxTokensInput.value || ''), 10) : NaN;
    const maxTokens = Number.isFinite(maxTokensRaw) ? maxTokensRaw : null;
    await persistChatAnalysisSettings(model, maxTokens);

    if (countInput) countInput.value = String(messageCount);

    if (loading) loading.style.display = 'block';
    if (resultWrap) resultWrap.style.display = 'none';
    if (resultText) resultText.textContent = '';

    try {
        const chatId = activeChatId;
        const chatName = document.getElementById('chatName')?.textContent || chatId;
        const response = await api('api/chats/' + encodeURIComponent(chatId) + '/messages?limit=' + messageCount + '&offset=0');
        const rawMessages = Array.isArray(response?.messages) ? response.messages : [];

        if (!rawMessages.length) {
            showToast('Analiz icin mesaj bulunamadi', 'info');
            return;
        }

        const sorted = [...rawMessages].sort((a, b) => {
            const aTs = (typeof normalizeTimestamp === 'function') ? (normalizeTimestamp(a.timestamp) || 0) : (a.timestamp || 0);
            const bTs = (typeof normalizeTimestamp === 'function') ? (normalizeTimestamp(b.timestamp) || 0) : (b.timestamp || 0);
            return aTs - bTs;
        });

        const lines = sorted.map((msg) => {
            const isMine = msg.is_from_me === 1 || msg.is_from_me === true;
            const rawName = isMine ? 'Sen' : (typeof getDisplayNameFromMessage === 'function' ? getDisplayNameFromMessage(msg, chatId) : (msg.from_name || msg.fromNumber || ''));
            const displayName = typeof formatSenderName === 'function' ? formatSenderName(rawName || 'Bilinmeyen') : (rawName || 'Bilinmeyen');
            const ts = (typeof normalizeTimestamp === 'function') ? normalizeTimestamp(msg.timestamp) : msg.timestamp;
            const timeText = ts && typeof formatDateTime === 'function' ? formatDateTime(ts) : String(msg.timestamp || '');
            const body = (msg.body || msg.message || '').toString();
            const fallback = (typeof getMessagePreviewText === 'function') ? getMessagePreviewText(msg) : '[Mesaj]';
            const content = (body && body.trim()) ? body.trim() : fallback;
            const cleaned = content.replace(/\\s+/g, ' ').trim();
            const trimmed = cleaned.length > 1600 ? (cleaned.slice(0, 1600) + '...') : cleaned;
            return `${displayName} | ${timeText} | ${trimmed}`;
        });

        const payload = {
            chatId,
            chatName,
            model,
            prompt: String(promptInput?.value || '').trim(),
            messages: lines
        };

        const analysis = await api('api/ai/analyze-chat', 'POST', payload);
        if (resultText) {
            resultText.textContent = analysis?.analysis || 'Analiz sonucu alinmadi.';
        }
        if (resultWrap) resultWrap.style.display = 'block';
    } catch (err) {
        showToast('Analiz hatasi: ' + err.message, 'error');
    } finally {
        if (loading) loading.style.display = 'none';
    }
}

Object.assign(window, {
    openGeminiAssistant,
    openAiAssistant,
    generateAiScript,
    sendAiAssistantMessage,
    acceptAiScript,
    rejectAiScript,
    testAiScript,
    closeAiAssistant,
    clearAiAssistantHistory,
    toggleAiAssistantAutoReply,
    toggleAiAssistantModelInput,
    openChatAnalysis,
    closeChatAnalysis,
    runChatAnalysis,
    saveChatAnalysisConfig,
    toggleChatAnalysisModelInput
});
