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

Object.assign(window, {
    openGeminiAssistant,
    openAiAssistant,
    generateAiScript,
    acceptAiScript,
    rejectAiScript,
    testAiScript,
    closeAiAssistant
});
