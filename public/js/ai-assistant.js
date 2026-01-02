/**
 * WhatsApp Web Panel - AI Assistant Frontend Logic
 */

/* global api, showToast, loadScriptsData, escapeHtml, formatDateTime, renderAvatarContent, chats, archivedChats, archivedChatsLoaded, currentChat */

const AI_ASSISTANT_HISTORY_KEY = 'aiAssistantHistoryV1';
const AI_ASSISTANT_HISTORY_LIMIT = 40;

let aiAssistantState = {
    chats: [],
    chatSearch: '',
    selectedChatIds: new Set(),
    history: []
};

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
}

function isAiAssistantAutoReplyEnabled() {
    const toggleEl = document.getElementById('aiAssistantAutoReplyToggle');
    return Boolean(toggleEl && toggleEl.classList.contains('active'));
}

function aiAssistantGetSelectedChatIds() {
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
        segments.push('');
        segments.push('Ek kurallar:');
        segments.push('- Gelen mesajlara Gemini ile cevap uret (aiGenerate fonksiyonunu kullan).');
        segments.push('- Sadece gelen mesajlarda calis; kendi mesajlarina cevap verme.');
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
        <div class="modal" style="max-width: 600px;">
            <div class="modal-header">
                <h3><i class="bi bi-magic"></i> AI Asistan</h3>
                <i class="bi bi-x-lg close-btn" onclick="this.closest('.modal-overlay').remove()"></i>
            </div>
            <div class="modal-body">
                <p style="color: var(--text-secondary); margin-bottom: 12px;">
                    Ne tur bir script istediginizi yazin. AI, Script Runner icin kod uretir ve siz onaylarsaniz kaydeder.
                </p>
                <div class="ai-chat-history" id="aiAssistantHistory"></div>
                <div class="ai-chat-footer">
                    <button class="btn btn-secondary btn-sm" type="button" onclick="clearAiAssistantHistory()">Gecmisi temizle</button>
                </div>
                <div class="form-group">
                    <label class="form-label">Mesajin</label>
                    <textarea class="form-input" id="aiPromptInput" rows="3" placeholder="Ornek: Gelen mesaj 'merhaba' iceriyorsa, gonderene 'Hosgeldiniz' cevabi ver."></textarea>
                </div>
                <div class="settings-section" style="margin-bottom: 16px;">
                    <div class="settings-section-title">AI Asistan Modu</div>
                    <div class="settings-item">
                        <i class="icon bi bi-robot"></i>
                        <div class="info">
                            <div class="title">AI ile otomatik cevap</div>
                            <div class="subtitle">Gelen mesajlara Gemini ile yanit uretir</div>
                        </div>
                        <div class="toggle" id="aiAssistantAutoReplyToggle" onclick="toggleAiAssistantAutoReply()"></div>
                    </div>
                    <div class="settings-item" id="aiAssistantPersonaRow" style="display: none;">
                        <i class="icon bi bi-brush"></i>
                        <div class="info">
                            <div class="title">Tavir / Rol</div>
                            <div class="subtitle">Asistanin konusma tarzi</div>
                        </div>
                        <textarea class="form-input" id="aiAssistantPersonaInput" rows="2" placeholder="Ornek: Samimi, kisa ve nazik cevaplar ver."></textarea>
                    </div>
                </div>
                <div class="settings-section" style="margin-bottom: 16px;">
                    <div class="settings-section-title">Hedef Sohbetler</div>
                    <div class="form-group" style="margin-bottom: 0;">
                        <label class="form-label">Mesaj scriptleri icin zorunlu</label>
                        <input type="text" class="form-input" id="aiAssistantChatSearch" placeholder="Sohbet ara (isim / id)">
                        <div class="chat-scope-picker" id="aiAssistantChatPickerList"></div>
                        <div class="chat-scope-footer">
                            <div id="aiAssistantChatSelectedCount" style="color: var(--text-secondary); font-size: 13px;">0 sohbet secildi</div>
                            <div style="display:flex; gap:8px;">
                                <button class="btn btn-secondary btn-sm" type="button" id="aiAssistantChatSelectAllBtn">Hepsini sec</button>
                                <button class="btn btn-secondary btn-sm" type="button" id="aiAssistantChatClearBtn">Temizle</button>
                            </div>
                        </div>
                    </div>
                </div>
                <div class="settings-section" style="margin-bottom: 16px;">
                    <div class="settings-section-title">Gemini Ayarlari</div>
                    <div class="settings-item">
                        <i class="icon bi bi-cpu"></i>
                        <div class="info">
                            <div class="title">Model</div>
                            <div class="subtitle">Script olusturmada kullanilacak Gemini modeli</div>
                        </div>
                        <div style="display: flex; flex-direction: column; gap: 8px; width: 50%;">
                            <select id="aiAssistantModelSelect" class="select-input" onchange="toggleAiAssistantModelInput(this.value)">
                                <option value="gemini-2.5-flash">gemini-2.5-flash</option>
                                <option value="gemini-2.5-pro">gemini-2.5-pro</option>
                                <option value="custom">Ozel</option>
                            </select>
                            <input type="text" class="form-input" id="aiAssistantModelCustomInput" placeholder="gemini-2.5-flash-latest" style="display:none;">
                        </div>
                    </div>
                    <div class="settings-item">
                        <i class="icon bi bi-sliders"></i>
                        <div class="info">
                            <div class="title">Maksimum Token</div>
                            <div class="subtitle">Daha yuksek deger daha uzun kod uretilmesine izin verir</div>
                        </div>
                        <input type="number" class="form-input" id="aiAssistantMaxTokens" min="256" max="8192" step="128" value="2048" style="width: 120px;">
                    </div>
                </div>
                <div id="aiLoading" style="display: none; text-align: center; margin: 20px 0;">
                    <div class="spinner"></div>
                    <p style="margin-top: 8px; color: var(--text-secondary);">Script olusturuluyor...</p>
                </div>
                <div id="aiResult" style="display: none; margin-top: 20px;">
                    <div style="background: var(--bg-secondary); padding: 12px; border-radius: 8px; border: 1px solid var(--border-color);">
                        <div style="display:flex; align-items: center; justify-content: space-between; gap: 12px;">
                            <h4 id="aiResultName" style="margin-bottom: 4px;">Script Adi</h4>
                            <span id="aiResultTrigger" style="font-size: 12px; color: var(--text-secondary);"></span>
                        </div>
                        <p id="aiResultDesc" style="color: var(--text-secondary); font-size: 13px; margin-bottom: 12px;">Aciklama</p>
                        <div id="aiResultFilterWrap" style="display:none; margin-bottom: 12px;">
                            <div style="font-size: 12px; color: var(--text-secondary); margin-bottom: 6px;">Filtre</div>
                            <pre id="aiResultFilter" style="background: var(--bg-primary); padding: 8px; border-radius: 4px; overflow-x: auto; font-family: monospace; font-size: 12px;"></pre>
                        </div>
                        <div style="font-size: 12px; color: var(--text-secondary); margin-bottom: 6px;">Kod</div>
                        <pre id="aiResultCode" style="background: var(--bg-primary); padding: 8px; border-radius: 4px; overflow-x: auto; font-family: monospace; font-size: 12px;"></pre>
                        <div id="aiTestResult" style="display:none; margin-top: 10px; font-size: 12px;"></div>
                    </div>
                    <details style="margin-top: 14px;">
                        <summary style="cursor: pointer; color: var(--text-secondary); font-size: 12px;">Script icinde kullanabilecegin fonksiyonlar</summary>
                        <div style="margin-top: 8px; font-size: 12px; color: var(--text-secondary); line-height: 1.5;">
                            <div><code>await sendMessage(chatId, text)</code> - Sohbete mesaj gonder</div>
                            <div><code>await reply(text)</code> - Tetikleyen mesaja cevap yaz</div>
                            <div><code>getChats()</code> - Chat listesi</div>
                            <div><code>getMessages(chatId, limit)</code> - Chat mesajlari</div>
                            <div><code>searchMessages(query)</code> - Mesaj arama</div>
                            <div><code>fetch(url, options)</code> - Guvenli HTTP istegi (dis kaynak)</div>
                            <div><code>await aiGenerate(prompt, options)</code> - Gemini ile yanit uret</div>
                            <div><code>storage.get/set/delete/clear</code> - Basit key-value</div>
                            <div><code>msg</code> / <code>message</code> - Tetikleyici mesaj verisi</div>
                        </div>
                    </details>
                </div>
            </div>
            <div class="modal-footer" style="justify-content: space-between;">
                <button class="btn btn-secondary" onclick="closeAiAssistant()"><i class="bi bi-x"></i> Kapat</button>
                <div style="display:flex; gap: 12px;">
                    <button class="btn btn-secondary" id="btnAiTest" onclick="testAiScript()" style="display: none;">
                        <i class="bi bi-play"></i> Test
                    </button>
                    <button class="btn btn-danger" id="btnAiReject" onclick="rejectAiScript()" style="display: none;">
                        <i class="bi bi-x-lg"></i> Reddet
                    </button>
                    <button class="btn btn-primary" id="btnAiAccept" onclick="acceptAiScript()" style="display: none;">
                        <i class="bi bi-check-lg"></i> Kabul Et
                    </button>
                    <button class="btn btn-primary" id="btnAiGenerate" onclick="generateAiScript()">
                        <i class="bi bi-stars"></i> Olustur
                    </button>
                </div>
            </div>
        </div>
    `;

    document.body.appendChild(modal);
    document.getElementById('aiPromptInput').focus();
    aiAssistantLoadHistory();
    aiAssistantRenderHistory();
    toggleAiAssistantAutoReply(false);
    aiAssistantLoadChats();
    loadAiAssistantConfig();

    const chatSearchEl = document.getElementById('aiAssistantChatSearch');
    if (chatSearchEl) {
        chatSearchEl.addEventListener('input', (e) => {
            aiAssistantState.chatSearch = e.target.value || '';
            aiAssistantRenderChatPicker();
        });
    }

    const chatPickerEl = document.getElementById('aiAssistantChatPickerList');
    if (chatPickerEl) {
        chatPickerEl.addEventListener('change', (e) => {
            const input = e.target;
            if (!input || input.tagName !== 'INPUT') return;
            const chatId = input.getAttribute('data-chat-id') || '';
            if (!chatId) return;
            if (input.checked) {
                aiAssistantState.selectedChatIds.add(chatId);
            } else {
                aiAssistantState.selectedChatIds.delete(chatId);
            }
            aiAssistantRenderChatPicker();
        });
    }

    const selectAllBtn = document.getElementById('aiAssistantChatSelectAllBtn');
    if (selectAllBtn) {
        selectAllBtn.addEventListener('click', () => {
            const chatsList = Array.isArray(aiAssistantState.chats) ? aiAssistantState.chats : [];
            chatsList.forEach((c) => { if (c?.chat_id) aiAssistantState.selectedChatIds.add(c.chat_id); });
            aiAssistantRenderChatPicker();
        });
    }

    const clearBtn = document.getElementById('aiAssistantChatClearBtn');
    if (clearBtn) {
        clearBtn.addEventListener('click', () => {
            aiAssistantState.selectedChatIds.clear();
            aiAssistantRenderChatPicker();
        });
    }
}

// Backward compatibility (older UI code)
function openAiAssistant() {
    return openGeminiAssistant();
}

let lastGeneratedScript = null;

async function generateAiScript() {
    const prompt = document.getElementById('aiPromptInput').value.trim();
    if (!prompt) return;

    const selectedChatIds = aiAssistantGetSelectedChatIds();
    if (!selectedChatIds.length) {
        showToast('Mesaj scripti icin en az 1 hedef sohbet secin', 'info');
        return;
    }

    const model = getAiAssistantModelValue();
    if (!model) {
        showToast('Model secin', 'info');
        return;
    }
    const maxTokensInput = document.getElementById('aiAssistantMaxTokens');
    const maxTokensRaw = maxTokensInput ? Number.parseInt(String(maxTokensInput.value || ''), 10) : NaN;
    const maxTokens = Number.isFinite(maxTokensRaw)
        ? Math.max(256, Math.min(8192, maxTokensRaw))
        : null;
    const saved = await persistChatAnalysisSettings(model, maxTokens);
    if (!saved) return;

    const personaInput = document.getElementById('aiAssistantPersonaInput');
    const persona = String(personaInput?.value || '').trim();
    const autoReply = isAiAssistantAutoReplyEnabled();
    const finalPrompt = buildAiAssistantPrompt(prompt, { autoReply, persona });
    const historyNote = autoReply && persona
        ? (prompt + '\n\nTavir: ' + persona)
        : prompt;
    aiAssistantAppendHistory('user', historyNote);

    const loading = document.getElementById('aiLoading');
    const resultDiv = document.getElementById('aiResult');
    const btnGenerate = document.getElementById('btnAiGenerate');
    const btnAccept = document.getElementById('btnAiAccept');
    const btnReject = document.getElementById('btnAiReject');
    const btnTest = document.getElementById('btnAiTest');
    const testResult = document.getElementById('aiTestResult');

    loading.style.display = 'block';
    resultDiv.style.display = 'none';
    btnGenerate.disabled = true;
    btnAccept.style.display = 'none';
    btnReject.style.display = 'none';
    btnTest.style.display = 'none';
    if (testResult) testResult.style.display = 'none';
    lastGeneratedScript = null;

    try {
        const response = await api('api/ai/generate-script', 'POST', { prompt: finalPrompt });
        if (response.success && response.script) {
            const mergedFilter = mergeAiAssistantTriggerFilter(response.script.trigger_filter, selectedChatIds);
            lastGeneratedScript = { ...response.script, trigger_filter: mergedFilter };

            const triggerType = lastGeneratedScript.trigger_type || 'message';
            const triggerText = 'Tetik: ' + triggerType;

            document.getElementById('aiResultName').textContent = lastGeneratedScript.name || 'Script';
            document.getElementById('aiResultDesc').textContent = lastGeneratedScript.description || '';
            document.getElementById('aiResultCode').textContent = lastGeneratedScript.code || '';
            document.getElementById('aiResultTrigger').textContent = triggerText;

            const filterWrap = document.getElementById('aiResultFilterWrap');
            const filterEl = document.getElementById('aiResultFilter');
            if (filterWrap && filterEl && lastGeneratedScript.trigger_filter) {
                filterWrap.style.display = 'block';
                try {
                    filterEl.textContent = JSON.stringify(lastGeneratedScript.trigger_filter, null, 2);
                } catch (e) {
                    filterEl.textContent = String(lastGeneratedScript.trigger_filter);
                }
            } else if (filterWrap) {
                filterWrap.style.display = 'none';
            }

            resultDiv.style.display = 'block';
            btnAccept.style.display = 'inline-flex';
            btnReject.style.display = 'inline-flex';
            btnTest.style.display = 'inline-flex';
            btnGenerate.innerHTML = '<i class="bi bi-stars"></i> Tekrar Olustur';

            const summaryParts = [];
            summaryParts.push('Script: ' + (lastGeneratedScript.name || 'Yeni Script'));
            if (lastGeneratedScript.description) summaryParts.push(lastGeneratedScript.description);
            summaryParts.push(triggerText);
            aiAssistantAppendHistory('assistant', summaryParts.join('\n'));
        }
    } catch (err) {
        showToast('AI hatasi: ' + err.message, 'error');
    } finally {
        loading.style.display = 'none';
        btnGenerate.disabled = false;
    }
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

function getAiAssistantModelValue() {
    const select = document.getElementById('aiAssistantModelSelect');
    const customInput = document.getElementById('aiAssistantModelCustomInput');
    if (!select) return '';
    if (select.value === 'custom') {
        return String(customInput?.value || '').trim();
    }
    return select.value;
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
