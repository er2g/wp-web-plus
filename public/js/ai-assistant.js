/**
 * WhatsApp Web Panel - AI Assistant Frontend Logic
 */

function openAiAssistant() {
    closeModal(); // Close existing modals

    const modal = document.createElement('div');
    modal.className = 'modal-overlay show';
    modal.onclick = (e) => { if (e.target === modal) modal.remove(); };

    modal.innerHTML = `
        <div class="modal" style="max-width: 600px;">
            <div class="modal-header">
                <h3><i class="bi bi-magic"></i> AI Asistan</h3>
                <i class="bi bi-x-lg close-btn" onclick="this.closest('.modal-overlay').remove()"></i>
            </div>
            <div class="modal-body">
                <p style="color: var(--text-secondary); margin-bottom: 12px;">
                    Ne tur bir script istediginizi yazin, yapay zeka sizin icin olustursun.
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
                        <h4 id="aiResultName" style="margin-bottom: 4px;">Script Adi</h4>
                        <p id="aiResultDesc" style="color: var(--text-secondary); font-size: 13px; margin-bottom: 12px;">Aciklama</p>
                        <pre id="aiResultCode" style="background: var(--bg-primary); padding: 8px; border-radius: 4px; overflow-x: auto; font-family: monospace; font-size: 12px;"></pre>
                    </div>
                </div>
            </div>
            <div class="modal-footer">
                <button class="btn btn-primary" id="btnAiGenerate" onclick="generateAiScript()">
                    <i class="bi bi-stars"></i> Olustur
                </button>
                <button class="btn btn-success" id="btnAiSave" onclick="saveAiScript()" style="display: none;">
                    <i class="bi bi-check-lg"></i> Kaydet
                </button>
            </div>
        </div>
    `;

    document.body.appendChild(modal);
    document.getElementById('aiPromptInput').focus();
}

let lastGeneratedScript = null;

async function generateAiScript() {
    const prompt = document.getElementById('aiPromptInput').value.trim();
    if (!prompt) return;

    const loading = document.getElementById('aiLoading');
    const resultDiv = document.getElementById('aiResult');
    const btnGenerate = document.getElementById('btnAiGenerate');
    const btnSave = document.getElementById('btnAiSave');

    loading.style.display = 'block';
    resultDiv.style.display = 'none';
    btnGenerate.disabled = true;
    btnSave.style.display = 'none';

    try {
        const response = await api('api/ai/generate-script', 'POST', { prompt });
        if (response.success && response.script) {
            lastGeneratedScript = response.script;

            document.getElementById('aiResultName').textContent = response.script.name;
            document.getElementById('aiResultDesc').textContent = response.script.description;
            document.getElementById('aiResultCode').textContent = response.script.code;

            resultDiv.style.display = 'block';
            btnSave.style.display = 'inline-flex';
        }
    } catch (err) {
        showToast('AI hatasi: ' + err.message, 'error');
    } finally {
        loading.style.display = 'none';
        btnGenerate.disabled = false;
    }
}

async function saveAiScript() {
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
        document.querySelector('.modal-overlay').remove();
        showToast('Script basariyla olusturuldu', 'success');

        // Refresh scripts list if we are on scripts tab
        loadScriptsData();
    } catch (err) {
        showToast('Kaydetme hatasi: ' + err.message, 'error');
    }
}
