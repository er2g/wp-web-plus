/**
 * WhatsApp Web Panel - AI Assistant Frontend Logic
 */

/* global api, showToast, loadScriptsData */

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
                <div class="form-group">
                    <textarea class="form-input" id="aiPromptInput" rows="4" placeholder="Ornek: Gelen mesaj 'merhaba' iceriyorsa, gonderene 'Hosgeldiniz' cevabi ver."></textarea>
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
}

// Backward compatibility (older UI code)
function openAiAssistant() {
    return openGeminiAssistant();
}

let lastGeneratedScript = null;

async function generateAiScript() {
    const prompt = document.getElementById('aiPromptInput').value.trim();
    if (!prompt) return;

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
        const response = await api('api/ai/generate-script', 'POST', { prompt });
        if (response.success && response.script) {
            lastGeneratedScript = response.script;

            const triggerType = response.script.trigger_type || 'message';
            const triggerText = 'Tetik: ' + triggerType;

            document.getElementById('aiResultName').textContent = response.script.name || 'Script';
            document.getElementById('aiResultDesc').textContent = response.script.description || '';
            document.getElementById('aiResultCode').textContent = response.script.code || '';
            document.getElementById('aiResultTrigger').textContent = triggerText;

            const filterWrap = document.getElementById('aiResultFilterWrap');
            const filterEl = document.getElementById('aiResultFilter');
            if (filterWrap && filterEl && response.script.trigger_filter) {
                filterWrap.style.display = 'block';
                try {
                    filterEl.textContent = JSON.stringify(response.script.trigger_filter, null, 2);
                } catch (e) {
                    filterEl.textContent = String(response.script.trigger_filter);
                }
            } else if (filterWrap) {
                filterWrap.style.display = 'none';
            }

            resultDiv.style.display = 'block';
            btnAccept.style.display = 'inline-flex';
            btnReject.style.display = 'inline-flex';
            btnTest.style.display = 'inline-flex';
            btnGenerate.innerHTML = '<i class="bi bi-stars"></i> Tekrar Olustur';
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
        const payload = {
            name: lastGeneratedScript.name,
            description: lastGeneratedScript.description,
            code: lastGeneratedScript.code,
            trigger_type: lastGeneratedScript.trigger_type || 'message',
            trigger_filter: lastGeneratedScript.trigger_filter
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

let chatAnalysisState = {
    hasKey: false,
    savedModel: ''
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
                                <option value="gemini-1.5-flash">gemini-1.5-flash</option>
                                <option value="gemini-1.5-pro">gemini-1.5-pro</option>
                                <option value="gemini-2.0-flash">gemini-2.0-flash</option>
                                <option value="custom">Ozel</option>
                            </select>
                            <input type="text" class="form-input" id="chatAnalysisModelCustomInput" placeholder="gemini-1.5-flash-latest" style="display:none;">
                        </div>
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

        if (statusEl) {
            statusEl.textContent = chatAnalysisState.hasKey ? 'Anahtar kayitli' : 'Anahtar kayitli degil';
        }

        const select = document.getElementById('chatAnalysisModelSelect');
        const customInput = document.getElementById('chatAnalysisModelCustomInput');
        if (select) {
            const known = ['gemini-1.5-flash', 'gemini-1.5-pro', 'gemini-2.0-flash'];
            if (chatAnalysisState.savedModel && known.includes(chatAnalysisState.savedModel)) {
                select.value = chatAnalysisState.savedModel;
                toggleChatAnalysisModelInput(select.value);
            } else if (chatAnalysisState.savedModel) {
                select.value = 'custom';
                toggleChatAnalysisModelInput('custom');
                if (customInput) customInput.value = chatAnalysisState.savedModel;
            }
        }
    } catch (err) {
        if (statusEl) statusEl.textContent = 'AI ayarlari okunamadi';
    }
}

async function saveChatAnalysisConfig() {
    const apiKeyInput = document.getElementById('chatAnalysisApiKeyInput');
    const apiKey = String(apiKeyInput?.value || '').trim();
    const model = getChatAnalysisModelValue();

    const payload = {};
    if (apiKey) payload.apiKey = apiKey;
    if (model) payload.model = model;

    if (!payload.apiKey && !payload.model) {
        showToast('Kaydedilecek veri yok', 'info');
        return;
    }

    try {
        const result = await api('api/ai/config', 'POST', payload);
        chatAnalysisState.hasKey = Boolean(result?.hasKey);
        chatAnalysisState.savedModel = String(result?.model || '');
        if (apiKeyInput) apiKeyInput.value = '';
        const statusEl = document.getElementById('chatAnalysisKeyStatus');
        if (statusEl) statusEl.textContent = chatAnalysisState.hasKey ? 'Anahtar kayitli' : 'Anahtar kayitli degil';
        showToast('AI ayarlari kaydedildi', 'success');
    } catch (err) {
        showToast('AI ayarlari kaydedilemedi: ' + err.message, 'error');
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
    openChatAnalysis,
    closeChatAnalysis,
    runChatAnalysis,
    saveChatAnalysisConfig,
    toggleChatAnalysisModelInput
});
