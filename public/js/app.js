/**
 * WhatsApp Web Panel - Frontend App v4
 * WhatsApp benzeri sohbet arayuzu + Drive entegrasyonu
 */

let socket;
let currentChat = null;
let chats = [];
let monacoEditor = null;
let editingScriptId = null;

// Initialize
document.addEventListener('DOMContentLoaded', () => {
    initSocket();
    initTabs();
    initForms();
    initMonaco();
    initChatScroll();
    loadInitialData();
    checkDriveStatus();
});

// Socket.IO
function initSocket() {
    const basePath = window.location.pathname.endsWith('/') ? window.location.pathname : window.location.pathname + '/';
    socket = io({ path: basePath + 'socket.io/' });

    socket.on('connect', () => console.log('Socket connected'));
    socket.on('disconnect', () => console.log('Socket disconnected'));
    socket.on('status', updateStatus);
    socket.on('qr', showQR);
    socket.on('ready', (info) => {
        hideQR();
        updateStatus({ status: 'ready', info });
        showToast('WhatsApp baglandi: ' + info.pushname, 'success');
        loadChats();
        loadAllMessages();
    });
    socket.on('disconnected', () => {
        updateStatus({ status: 'disconnected' });
        showToast('WhatsApp baglantisi kesildi', 'warning');
    });
    socket.on('message', handleNewMessage);
    socket.on('sync_progress', updateSyncProgress);
    socket.on('sync_complete', (data) => {
        showToast('Senkronizasyon tamamlandi: ' + data.chats + ' sohbet, ' + data.messages + ' mesaj', 'success');
        loadChats();
        loadAllMessages();
        loadDashboard();
    });
}

// Chat scroll handler
function initChatScroll() {
    const container = document.getElementById('chatMessages');
    const scrollBtn = document.getElementById('scrollBottomBtn');
    if (!container || !scrollBtn) return;

    container.addEventListener('scroll', () => {
        const isNearBottom = container.scrollHeight - container.scrollTop - container.clientHeight < 100;
        scrollBtn.style.display = isNearBottom ? 'none' : 'flex';
    });
}

function scrollToBottom() {
    const container = document.getElementById('chatMessages');
    if (container) {
        container.scrollTop = container.scrollHeight;
    }
}

// Monaco Editor
function initMonaco() {
    if (typeof require === 'undefined') return;
    require.config({ paths: { vs: 'https://cdnjs.cloudflare.com/ajax/libs/monaco-editor/0.45.0/min/vs' } });
    require(['vs/editor/editor.main'], function () {
        const editorEl = document.getElementById('scriptEditor');
        if (!editorEl) return;
        monacoEditor = monaco.editor.create(editorEl, {
            value: '// Ornek: Gelen mesaja otomatik yanit\nif (msg.body.toLowerCase().includes("merhaba")) {\n    await reply("Merhaba! Size nasil yardimci olabilirim?");\n    console.log("Merhaba mesajina yanit verildi");\n}',
            language: 'javascript',
            theme: 'vs-dark',
            minimap: { enabled: false },
            automaticLayout: true,
            fontSize: 14
        });
    });
}

// Tabs
function initTabs() {
    document.querySelectorAll('[data-tab]').forEach(tab => {
        tab.addEventListener('click', (e) => {
            e.preventDefault();
            showTab(tab.dataset.tab);
        });
    });
}

function showTab(tabName) {
    document.querySelectorAll('[data-tab]').forEach(t => t.classList.remove('active'));
    const activeTab = document.querySelector('[data-tab="' + tabName + '"]');
    if (activeTab) activeTab.classList.add('active');

    document.querySelectorAll('.tab-content').forEach(c => c.classList.add('d-none'));
    const tabContent = document.getElementById('tab-' + tabName);
    if (tabContent) tabContent.classList.remove('d-none');

    switch(tabName) {
        case 'dashboard': loadDashboard(); break;
        case 'chats': loadChats(); break;
        case 'messages': loadAllMessages(); break;
        case 'scripts': loadScripts(); break;
        case 'auto-reply': loadAutoReplies(); break;
        case 'scheduled': loadScheduled(); break;
        case 'webhooks': loadWebhooks(); break;
        case 'logs': loadLogs(); break;
    }
}

// Forms
function initForms() {
    const sendForm = document.getElementById('sendMessageForm');
    if (sendForm) {
        sendForm.addEventListener('submit', async (e) => {
            e.preventDefault();
            const chatId = document.getElementById('selectedChatId').value;
            const messageInput = document.getElementById('messageInput');
            const message = messageInput.value.trim();
            if (!chatId || !message) return;

            // Hemen input'u temizle ve mesaji goster
            messageInput.value = '';

            // Gecici mesaj balonu ekle
            appendTempMessage(message);

            try {
                await api('api/send', 'POST', { chatId, message });
                // Gercek mesaji yukle
                setTimeout(() => loadChatMessages(currentChat), 500);
            } catch (err) {
                showToast('Gonderme hatasi: ' + err.message, 'danger');
                // Hata durumunda tekrar yukle
                loadChatMessages(currentChat);
            }
        });
    }

    const autoReplyForm = document.getElementById('autoReplyForm');
    if (autoReplyForm) {
        autoReplyForm.addEventListener('submit', async (e) => {
            e.preventDefault();
            const data = {
                trigger_word: document.getElementById('triggerWord').value,
                response: document.getElementById('autoResponse').value,
                match_type: document.getElementById('matchType').value
            };
            try {
                await api('api/auto-replies', 'POST', data);
                autoReplyForm.reset();
                loadAutoReplies();
                showToast('Otomatik yanit eklendi', 'success');
            } catch (err) {
                showToast('Hata: ' + err.message, 'danger');
            }
        });
    }

    const scheduledForm = document.getElementById('scheduledForm');
    if (scheduledForm) {
        scheduledForm.addEventListener('submit', async (e) => {
            e.preventDefault();
            const data = {
                chat_id: document.getElementById('schedChatId').value,
                chat_name: document.getElementById('schedChatName').value,
                message: document.getElementById('schedMessage').value,
                scheduled_at: document.getElementById('schedTime').value
            };
            try {
                await api('api/scheduled', 'POST', data);
                scheduledForm.reset();
                loadScheduled();
                showToast('Mesaj zamanlandi', 'success');
            } catch (err) {
                showToast('Hata: ' + err.message, 'danger');
            }
        });
    }

    const webhookForm = document.getElementById('webhookForm');
    if (webhookForm) {
        webhookForm.addEventListener('submit', async (e) => {
            e.preventDefault();
            const data = {
                name: document.getElementById('webhookName').value,
                url: document.getElementById('webhookUrl').value,
                events: document.getElementById('webhookEvents').value
            };
            try {
                await api('api/webhooks', 'POST', data);
                webhookForm.reset();
                loadWebhooks();
                showToast('Webhook eklendi', 'success');
            } catch (err) {
                showToast('Hata: ' + err.message, 'danger');
            }
        });
    }

    const msgSearch = document.getElementById('messageSearch');
    if (msgSearch) {
        msgSearch.addEventListener('input', debounce(searchMessages, 300));
    }

    const chatSearch = document.getElementById('chatSearch');
    if (chatSearch) {
        chatSearch.addEventListener('input', debounce(filterChats, 300));
    }
}

// API Helper
async function api(url, method, body) {
    method = method || 'GET';
    const options = {
        method: method,
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include'
    };
    if (body) options.body = JSON.stringify(body);
    const response = await fetch(url, options);
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'API Error');
    return data;
}

// Load functions
async function loadInitialData() {
    try {
        const status = await api('api/status');
        updateStatus(status.whatsapp);
        updateStats(status.stats);
        loadSettings();
        if (status.whatsapp && status.whatsapp.syncProgress && status.whatsapp.syncProgress.syncing) {
            updateSyncProgress(status.whatsapp.syncProgress);
        }
    } catch (err) {
        console.error('Initial load error:', err);
        showToast('Veri yuklenemedi: ' + err.message, 'danger');
    }
}

async function loadDashboard() {
    try {
        const [status, messages] = await Promise.all([
            api('api/status'),
            api('api/messages?limit=10')
        ]);
        updateStats(status.stats);
        renderRecentMessages(messages);
    } catch (err) {
        console.error('Dashboard load error:', err);
    }
}

async function loadChats() {
    try {
        chats = await api('api/chats');
        renderChatList(chats);
    } catch (err) {
        console.error('Chats load error:', err);
    }
}

async function loadAllMessages() {
    try {
        const messages = await api('api/messages?limit=200');
        renderMessagesTable(messages);
    } catch (err) {
        console.error('Messages load error:', err);
    }
}

async function loadAutoReplies() {
    try {
        const replies = await api('api/auto-replies');
        renderAutoReplies(replies);
    } catch (err) {
        console.error('Auto replies load error:', err);
    }
}

async function loadScheduled() {
    try {
        const scheduled = await api('api/scheduled');
        renderScheduled(scheduled);
    } catch (err) {
        console.error('Scheduled load error:', err);
    }
}

async function loadWebhooks() {
    try {
        const webhooks = await api('api/webhooks');
        renderWebhooks(webhooks);
    } catch (err) {
        console.error('Webhooks load error:', err);
    }
}

async function loadScripts() {
    try {
        const scripts = await api('api/scripts');
        renderScripts(scripts);
    } catch (err) {
        console.error('Scripts load error:', err);
    }
}

async function loadLogs(category) {
    try {
        const url = category ? 'api/logs?category=' + category + '&limit=200' : 'api/logs?limit=200';
        const logs = await api(url);
        renderLogs(logs);
    } catch (err) {
        console.error('Logs load error:', err);
    }
}

async function loadChatMessages(chatId) {
    try {
        const messages = await api('api/chats/' + encodeURIComponent(chatId) + '/messages?limit=100');
        renderChatMessages(messages);
    } catch (err) {
        console.error('Chat messages load error:', err);
    }
}

// Render functions
function updateStatus(status) {
    const badge = document.getElementById('statusBadge');
    const text = document.getElementById('statusText');
    if (!badge || !text) return;

    const statusMap = {
        'disconnected': { class: 'bg-danger', text: 'Bagli Degil' },
        'qr': { class: 'bg-warning', text: 'QR Bekliyor' },
        'authenticated': { class: 'bg-info', text: 'Dogrulandi' },
        'ready': { class: 'bg-success', text: 'Bagli' }
    };
    const s = statusMap[status.status] || statusMap['disconnected'];
    badge.className = 'badge ' + s.class;
    text.textContent = s.text;

    if (status.info) {
        text.textContent = s.text + ' (' + status.info.pushname + ')';
    }
}

function updateStats(stats) {
    if (!stats) return;
    const el = (id) => document.getElementById(id);
    if (el('statTotal')) el('statTotal').textContent = stats.total || 0;
    if (el('statSent')) el('statSent').textContent = stats.sent || 0;
    if (el('statReceived')) el('statReceived').textContent = stats.received || 0;
    if (el('statToday')) el('statToday').textContent = stats.today || 0;
}

function showQR(qr) {
    const section = document.getElementById('qrSection');
    const img = document.getElementById('qrCode');
    if (section && img) {
        section.classList.remove('d-none');
        img.src = qr;
    }
}

function hideQR() {
    const section = document.getElementById('qrSection');
    if (section) section.classList.add('d-none');
}

function renderChatList(chatList) {
    const container = document.getElementById('chatList');
    if (!container) return;
    container.innerHTML = chatList.map(c =>
        '<a href="#" class="list-group-item list-group-item-action' + (currentChat === c.chat_id ? ' active' : '') + '" onclick="selectChat(\'' + c.chat_id + '\', \'' + escapeHtml(c.name) + '\')">' +
        '<div class="d-flex justify-content-between"><strong>' + escapeHtml(c.name) + '</strong>' +
        (c.unread_count > 0 ? '<span class="badge bg-primary">' + c.unread_count + '</span>' : '') +
        '</div><small class="text-muted">' + escapeHtml((c.last_message || '').substring(0, 30)) + '</small></a>'
    ).join('');
}

function filterChats() {
    const query = document.getElementById('chatSearch').value.toLowerCase();
    const filtered = chats.filter(c => c.name.toLowerCase().includes(query));
    renderChatList(filtered);
}

function selectChat(chatId, name) {
    currentChat = chatId;
    document.getElementById('selectedChatId').value = chatId;
    document.getElementById('chatHeader').textContent = name;
    loadChatMessages(chatId);
    renderChatList(chats);
}

// WhatsApp benzeri mesaj gorunumu
function renderChatMessages(messages) {
    const container = document.getElementById('chatMessages');
    if (!container) return;

    // Mesajlari kronolojik sirala (eskiden yeniye)
    const sorted = [...messages].sort((a, b) => a.timestamp - b.timestamp);

    container.innerHTML = sorted.map(m => {
        const isMine = m.is_from_me === 1 || m.is_from_me === true;
        let mediaHtml = '';
        const mediaUrl = m.media_url || m.mediaUrl;

        if (mediaUrl) {
            const safeMediaUrl = sanitizeUrl(mediaUrl);
            if (safeMediaUrl) {
                const type = m.type || 'chat';
                if (type === 'image' || type === 'sticker') {
                    mediaHtml = '<div class="message-media"><img src="' + safeMediaUrl + '" onclick="openMediaLightbox(this.src)" loading="lazy" alt=""></div>';
                } else if (type === 'video') {
                    mediaHtml = '<div class="message-media"><video src="' + safeMediaUrl + '" controls></video></div>';
                } else if (type === 'audio' || type === 'ptt') {
                    mediaHtml = '<div class="message-media"><audio src="' + safeMediaUrl + '" controls></audio></div>';
                } else if (type === 'document') {
                    const fileName = m.body || 'Belge';
                    const ext = fileName.split('.').pop().toLowerCase();
                    const iconClass = ext === 'pdf' ? 'bi-file-earmark-pdf' : 'bi-file-earmark';
                    const iconColor = ext === 'pdf' ? '#e74c3c' : '#667781';
                    mediaHtml = '<div class="message-document">' +
                        '<div class="doc-icon" style="background:' + iconColor + '"><i class="bi ' + iconClass + '"></i></div>' +
                        '<div class="doc-info"><div class="doc-name">' + escapeHtml(fileName) + '</div>' +
                        '<a href="' + safeMediaUrl + '" target="_blank" class="doc-link">Indir</a></div></div>';
                }
            }
        }

        // Mesaj metni (sadece chat tipinde veya medya ile birlikte caption varsa)
        let textHtml = '';
        if (m.body && (m.type === 'chat' || (mediaUrl && m.body && m.type !== 'document'))) {
            textHtml = '<div class="message-text">' + escapeHtml(m.body) + '</div>';
        }

        // Gonderici ismi (sadece alinan mesajlarda ve grup sohbetlerinde)
        const senderHtml = (!isMine && m.from_name) ?
            '<div class="message-sender">' + escapeHtml(formatSenderName(m.from_name)) + '</div>' : '';

        // Zaman ve okundu tikari
        const checkIcon = isMine ? '<i class="bi bi-check2-all"></i>' : '';

        return '<div class="message-row ' + (isMine ? 'sent' : 'received') + '">' +
            '<div class="message-bubble ' + (isMine ? 'sent' : 'received') + '">' +
            senderHtml +
            mediaHtml +
            textHtml +
            '<div class="message-time">' + formatTime(m.timestamp) + ' ' + checkIcon + '</div>' +
            '</div></div>';
    }).join('');

    // Scroll to bottom
    setTimeout(() => {
        container.scrollTop = container.scrollHeight;
    }, 100);
}

// Gonderici ismini duzenle (numara yerine isim goster)
function formatSenderName(name) {
    if (!name) return '';
    // Eger sadece numara ise kisa formata cevir
    if (/^\d{10,15}$/.test(name)) {
        return '+' + name.substring(0, 2) + ' xxx ' + name.slice(-4);
    }
    return name;
}

// Media lightbox
function openMediaLightbox(src) {
    const safeSrc = sanitizeUrl(src);
    if (!safeSrc) return;
    const lightbox = document.createElement('div');
    lightbox.className = 'media-lightbox';
    const img = document.createElement('img');
    img.src = safeSrc;
    img.alt = '';
    lightbox.appendChild(img);
    lightbox.onclick = () => lightbox.remove();
    document.body.appendChild(lightbox);
}

function renderRecentMessages(messages) {
    const container = document.getElementById('recentMessages');
    if (!container) return;
    container.innerHTML = messages.slice(0, 10).map(m =>
        '<div class="list-group-item"><div class="d-flex justify-content-between">' +
        '<strong>' + escapeHtml(formatSenderName(m.from_name)) + '</strong><small>' + formatTime(m.timestamp) + '</small></div>' +
        '<p class="mb-0 text-muted">' + escapeHtml((m.body || '[Medya]').substring(0, 50)) + '</p></div>'
    ).join('');
}

function renderMessagesTable(messages) {
    const tbody = document.getElementById('messagesTable');
    if (!tbody) return;
    tbody.innerHTML = messages.map(m => {
        const mediaUrl = m.media_url || m.mediaUrl;
        let mediaCol = '';
        if (mediaUrl) {
            const safeMediaUrl = sanitizeUrl(mediaUrl);
            if (safeMediaUrl) {
                if (m.type === 'image' || m.type === 'sticker') {
                    mediaCol = '<a href="' + safeMediaUrl + '" target="_blank"><img src="' + safeMediaUrl + '" style="max-height:40px" loading="lazy"></a>';
                } else {
                    mediaCol = '<a href="' + safeMediaUrl + '" target="_blank" class="btn btn-sm btn-outline-info"><i class="bi bi-download"></i></a>';
                }
            }
        }
        const isMine = m.is_from_me === 1 || m.is_from_me === true;
        const direction = isMine ? '<i class="bi bi-arrow-up-right text-success"></i>' : '<i class="bi bi-arrow-down-left text-primary"></i>';
        return '<tr><td>' + formatDateTime(m.timestamp) + '</td><td>' + direction + ' ' + escapeHtml(formatSenderName(m.from_name)) + '</td>' +
            '<td>' + escapeHtml((m.body || '').substring(0, 100)) + '</td>' +
            '<td><span class="badge bg-' + (m.type === 'chat' ? 'secondary' : 'info') + '">' + escapeHtml(m.type) + '</span> ' + mediaCol + '</td></tr>';
    }).join('');
}

function renderAutoReplies(replies) {
    const container = document.getElementById('autoRepliesList');
    if (!container) return;
    container.innerHTML = replies.map(r =>
        '<tr><td>' + escapeHtml(r.trigger_word) + '</td><td>' + escapeHtml(r.response) + '</td><td>' + r.match_type + '</td>' +
        '<td><span class="badge ' + (r.is_active ? 'bg-success' : 'bg-secondary') + '">' + (r.is_active ? 'Aktif' : 'Pasif') + '</span></td>' +
        '<td><button class="btn btn-sm btn-outline-primary me-1" onclick="toggleAutoReply(' + r.id + ')"><i class="bi bi-toggle-on"></i></button>' +
        '<button class="btn btn-sm btn-outline-danger" onclick="deleteAutoReply(' + r.id + ')"><i class="bi bi-trash"></i></button></td></tr>'
    ).join('');
}

function renderScheduled(scheduled) {
    const container = document.getElementById('scheduledList');
    if (!container) return;
    container.innerHTML = scheduled.map(s =>
        '<tr><td>' + escapeHtml(s.chat_name || s.chat_id) + '</td><td>' + escapeHtml(s.message) + '</td>' +
        '<td>' + formatDateTime(s.scheduled_at) + '</td><td><span class="badge ' + (s.is_sent ? 'bg-success' : 'bg-warning') + '">' + (s.is_sent ? 'Gonderildi' : 'Bekliyor') + '</span></td>' +
        '<td><button class="btn btn-sm btn-outline-danger" onclick="deleteScheduled(' + s.id + ')"><i class="bi bi-trash"></i></button></td></tr>'
    ).join('');
}

function renderWebhooks(webhooks) {
    const container = document.getElementById('webhooksList');
    if (!container) return;
    container.innerHTML = webhooks.map(w =>
        '<tr><td>' + escapeHtml(w.name) + '</td><td>' + escapeHtml(w.url) + '</td><td>' + w.events + '</td>' +
        '<td><span class="badge ' + (w.is_active ? 'bg-success' : 'bg-secondary') + '">' + (w.is_active ? 'Aktif' : 'Pasif') + '</span></td>' +
        '<td><button class="btn btn-sm btn-outline-danger" onclick="deleteWebhook(' + w.id + ')"><i class="bi bi-trash"></i></button></td></tr>'
    ).join('');
}

function renderScripts(scripts) {
    const container = document.getElementById('scriptsList');
    if (!container) return;
    container.innerHTML = scripts.map(s =>
        '<tr><td>' + escapeHtml(s.name) + '</td><td>' + escapeHtml(s.description || '-') + '</td><td>' + s.trigger_type + '</td>' +
        '<td><span class="badge ' + (s.is_active ? 'bg-success' : 'bg-secondary') + '">' + (s.is_active ? 'Aktif' : 'Pasif') + '</span></td>' +
        '<td>' + s.run_count + '</td>' +
        '<td><button class="btn btn-sm btn-outline-primary me-1" onclick="editScript(' + s.id + ')"><i class="bi bi-pencil"></i></button>' +
        '<button class="btn btn-sm btn-outline-success me-1" onclick="runScript(' + s.id + ')"><i class="bi bi-play"></i></button>' +
        '<button class="btn btn-sm btn-outline-warning me-1" onclick="toggleScript(' + s.id + ')"><i class="bi bi-toggle-on"></i></button>' +
        '<button class="btn btn-sm btn-outline-info me-1" onclick="showScriptLogs(' + s.id + ')"><i class="bi bi-journal-text"></i></button>' +
        '<button class="btn btn-sm btn-outline-danger" onclick="deleteScript(' + s.id + ')"><i class="bi bi-trash"></i></button></td></tr>'
    ).join('');
}

function renderLogs(logs) {
    const container = document.getElementById('logsList');
    if (!container) return;
    container.innerHTML = logs.map(l =>
        '<tr><td>' + formatDateTime(l.created_at) + '</td><td><span class="badge bg-' + (l.level === 'error' ? 'danger' : l.level === 'warn' ? 'warning' : 'info') + '">' + l.level + '</span></td>' +
        '<td>' + l.category + '</td><td>' + escapeHtml(l.message) + '</td></tr>'
    ).join('');
}

function handleNewMessage(msg) {
    console.log('New message received:', msg);
    showToast('Yeni mesaj: ' + formatSenderName(msg.fromName), 'info');

    // Eger bu sohbet aciksa, mesaji aninda ekle
    if (currentChat && currentChat === msg.chatId) {
        appendNewMessage(msg);
    }

    // Chat listesini guncelle
    loadChats();
    loadDashboard();
}

// Yeni mesaji sohbet penceresine ekle
function appendNewMessage(msg) {
    const container = document.getElementById('chatMessages');
    if (!container) return;

    const isMine = msg.isFromMe === true || msg.isFromMe === 1;
    let mediaHtml = '';
    const mediaUrl = msg.mediaUrl;

    if (mediaUrl) {
        const safeMediaUrl = sanitizeUrl(mediaUrl);
        if (safeMediaUrl) {
            const type = msg.type || 'chat';
            if (type === 'image' || type === 'sticker') {
                mediaHtml = '<div class="message-media"><img src="' + safeMediaUrl + '" onclick="openMediaLightbox(this.src)" loading="lazy" alt=""></div>';
            } else if (type === 'video') {
                mediaHtml = '<div class="message-media"><video src="' + safeMediaUrl + '" controls></video></div>';
            } else if (type === 'audio' || type === 'ptt') {
                mediaHtml = '<div class="message-media"><audio src="' + safeMediaUrl + '" controls></audio></div>';
            } else if (type === 'document') {
                const fileName = msg.body || 'Belge';
                mediaHtml = '<div class="message-document"><div class="doc-icon"><i class="bi bi-file-earmark-pdf"></i></div>' +
                    '<div class="doc-info"><div class="doc-name">' + escapeHtml(fileName) + '</div>' +
                    '<a href="' + safeMediaUrl + '" target="_blank" class="doc-link">Indir</a></div></div>';
            }
        }
    }

    let textHtml = '';
    if (msg.body && (msg.type === 'chat' || msg.type === undefined)) {
        textHtml = '<div class="message-text">' + escapeHtml(msg.body) + '</div>';
    }

    const senderHtml = (!isMine && msg.fromName) ?
        '<div class="message-sender">' + escapeHtml(formatSenderName(msg.fromName)) + '</div>' : '';

    const checkIcon = isMine ? '<i class="bi bi-check2-all"></i>' : '';
    const time = msg.timestamp ? formatTime(msg.timestamp) : formatTime(Date.now());

    const messageHtml = '<div class="message-row ' + (isMine ? 'sent' : 'received') + '">' +
        '<div class="message-bubble ' + (isMine ? 'sent' : 'received') + '">' +
        senderHtml + mediaHtml + textHtml +
        '<div class="message-time">' + time + ' ' + checkIcon + '</div>' +
        '</div></div>';

    container.insertAdjacentHTML('beforeend', messageHtml);
    container.scrollTop = container.scrollHeight;
}

// Gecici gonderilen mesaj balonu
function appendTempMessage(text) {
    const container = document.getElementById('chatMessages');
    if (!container) return;

    const messageHtml = '<div class="message-row sent">' +
        '<div class="message-bubble sent">' +
        '<div class="message-text">' + escapeHtml(text) + '</div>' +
        '<div class="message-time">' + formatTime(Date.now()) + ' <i class="bi bi-check2"></i></div>' +
        '</div></div>';

    container.insertAdjacentHTML('beforeend', messageHtml);
    container.scrollTop = container.scrollHeight;
}

async function searchMessages() {
    const query = document.getElementById('messageSearch').value;
    if (!query) {
        loadAllMessages();
        return;
    }
    try {
        const messages = await api('api/messages/search?q=' + encodeURIComponent(query));
        renderMessagesTable(messages);
    } catch (err) {
        console.error('Search error:', err);
    }
}

// Actions
async function reconnect() {
    try {
        await api('api/connect', 'POST');
        showToast('Baglanti baslatiliyor...', 'info');
    } catch (err) {
        showToast('Baglanti hatasi: ' + err.message, 'danger');
    }
}

async function disconnect() {
    try {
        await api('api/disconnect', 'POST');
        showToast('Baglanti kesildi', 'warning');
    } catch (err) {
        showToast('Hata: ' + err.message, 'danger');
    }
}

async function startSync() {
    try {
        document.getElementById('syncProgress').classList.remove('d-none');
        showToast('Senkronizasyon baslatiliyor...', 'info');
        const result = await api('api/sync', 'POST');
        if (result.success) {
            showToast('Senkronizasyon tamamlandi: ' + result.chats + ' sohbet, ' + result.messages + ' mesaj', 'success');
            loadChats();
            loadAllMessages();
            loadDashboard();
        } else {
            showToast('Senkronizasyon hatasi: ' + result.error, 'danger');
        }
    } catch (err) {
        showToast('Hata: ' + err.message, 'danger');
    }
}

async function loadSettings() {
    try {
        const settings = await api('api/settings');
        const dlMedia = document.getElementById('settingDownloadMedia');
        const syncConnect = document.getElementById('settingSyncOnConnect');
        const maxMsg = document.getElementById('settingMaxMessages');
        if (dlMedia) dlMedia.checked = settings.downloadMedia;
        if (syncConnect) syncConnect.checked = settings.syncOnConnect;
        if (maxMsg) maxMsg.value = settings.maxMessagesPerChat || 100;
    } catch (err) {
        console.error('Settings load error:', err);
    }
}

async function updateSettings() {
    try {
        const settings = {
            downloadMedia: document.getElementById('settingDownloadMedia').checked,
            syncOnConnect: document.getElementById('settingSyncOnConnect').checked,
            maxMessagesPerChat: parseInt(document.getElementById('settingMaxMessages').value) || 100
        };
        await api('api/settings', 'POST', settings);
        showToast('Ayarlar kaydedildi', 'success');
    } catch (err) {
        showToast('Ayar hatasi: ' + err.message, 'danger');
    }
}

function updateSyncProgress(progress) {
    const section = document.getElementById('syncProgress');
    const bar = document.getElementById('syncProgressBar');
    const status = document.getElementById('syncStatus');
    if (!section) return;

    if (progress.syncing) {
        section.classList.remove('d-none');
        const percent = progress.total > 0 ? Math.round((progress.current / progress.total) * 100) : 0;
        if (bar) bar.style.width = percent + '%';
        if (status) status.textContent = progress.current + '/' + progress.total + ' - ' + progress.chat;
    } else {
        section.classList.add('d-none');
    }
}

// Google Drive Functions
async function checkDriveStatus() {
    try {
        const status = await api('api/drive/status');
        const container = document.getElementById('driveStatus');
        const btn = document.getElementById('btnMigrateDrive');

        if (status.configured) {
            container.innerHTML = '<i class="bi bi-check-circle-fill drive-status-ok me-2"></i>' +
                '<span class="text-success">Google Drive yapilandirildi</span>';
            btn.disabled = false;
        } else {
            container.innerHTML = '<i class="bi bi-exclamation-circle-fill drive-status-error me-2"></i>' +
                '<span class="text-danger">Service Account bulunamadi</span>' +
                '<br><small class="text-muted">Dosya yolu: ' + escapeHtml(status.keyPath) + '</small>';
            btn.disabled = true;
        }
    } catch (err) {
        const container = document.getElementById('driveStatus');
        container.innerHTML = '<span class="text-muted">Drive durumu kontrol edilemedi</span>';
    }
}

async function migrateToDrive() {
    if (!confirm('Tum medya dosyalari Google Drive\'a tasinacak ve lokal kopyalar silinecek. Devam etmek istiyor musunuz?')) {
        return;
    }

    const btn = document.getElementById('btnMigrateDrive');
    const progress = document.getElementById('driveProgress');
    const progressBar = document.getElementById('driveProgressBar');
    const progressText = document.getElementById('driveProgressText');

    btn.disabled = true;
    progress.classList.remove('d-none');
    progressBar.style.width = '0%';
    progressText.textContent = 'Baslatiliyor...';

    try {
        const result = await api('api/drive/migrate', 'POST');

        if (result.success) {
            progressBar.style.width = '100%';
            progressBar.classList.add('bg-success');
            progressText.textContent = result.migrated + ' dosya tasinidi';
            showToast('Drive\'a tasima tamamlandi: ' + result.migrated + ' dosya', 'success');
        } else {
            progressBar.classList.add('bg-danger');
            progressText.textContent = 'Hata: ' + result.error;
            showToast('Drive hatasi: ' + result.error, 'danger');
        }
    } catch (err) {
        progressBar.classList.add('bg-danger');
        progressText.textContent = 'Hata: ' + err.message;
        showToast('Drive hatasi: ' + err.message, 'danger');
    }

    btn.disabled = false;
}

async function toggleAutoReply(id) {
    await api('api/auto-replies/' + id + '/toggle', 'POST');
    loadAutoReplies();
}

/**
 * Generic delete function to reduce code duplication
 * @param {string} endpoint - API endpoint path
 * @param {number|string} id - Resource ID
 * @param {Function} reloadFn - Function to reload the list after deletion
 * @param {string} confirmMessage - Confirmation dialog message
 * @param {string} successMessage - Success toast message
 */
async function deleteResource(endpoint, id, reloadFn, confirmMessage, successMessage) {
    if (!confirm(confirmMessage || 'Silmek istediginize emin misiniz?')) return;
    try {
        await api(endpoint + '/' + id, 'DELETE');
        reloadFn();
        showToast(successMessage || 'Silindi', 'success');
    } catch (err) {
        showToast('Silme hatasi: ' + err.message, 'danger');
    }
}

function deleteAutoReply(id) {
    deleteResource('api/auto-replies', id, loadAutoReplies);
}

function deleteScheduled(id) {
    deleteResource('api/scheduled', id, loadScheduled);
}

function deleteWebhook(id) {
    deleteResource('api/webhooks', id, loadWebhooks);
}

// Script functions
function showScriptEditor(scriptId) {
    editingScriptId = scriptId || null;
    document.getElementById('scriptEditorModal').classList.add('show');
    document.getElementById('scriptEditorModal').style.display = 'block';
    document.body.classList.add('modal-open');

    if (scriptId) {
        api('api/scripts/' + scriptId).then(script => {
            document.getElementById('scriptName').value = script.name;
            document.getElementById('scriptDescription').value = script.description || '';
            document.getElementById('scriptTriggerType').value = script.trigger_type;
            if (monacoEditor) monacoEditor.setValue(script.code);
        });
    } else {
        document.getElementById('scriptName').value = '';
        document.getElementById('scriptDescription').value = '';
        document.getElementById('scriptTriggerType').value = 'message';
        if (monacoEditor) monacoEditor.setValue('// Yeni script\n');
    }
}

function hideScriptEditor() {
    document.getElementById('scriptEditorModal').classList.remove('show');
    document.getElementById('scriptEditorModal').style.display = 'none';
    document.body.classList.remove('modal-open');
    editingScriptId = null;
}

async function saveScript() {
    const data = {
        name: document.getElementById('scriptName').value,
        description: document.getElementById('scriptDescription').value,
        code: monacoEditor ? monacoEditor.getValue() : '',
        trigger_type: document.getElementById('scriptTriggerType').value
    };

    try {
        if (editingScriptId) {
            await api('api/scripts/' + editingScriptId, 'PUT', data);
        } else {
            await api('api/scripts', 'POST', data);
        }
        hideScriptEditor();
        loadScripts();
        showToast('Script kaydedildi', 'success');
    } catch (err) {
        showToast('Hata: ' + err.message, 'danger');
    }
}

async function testScript() {
    const code = monacoEditor ? monacoEditor.getValue() : '';
    try {
        const result = await api('api/scripts/test', 'POST', { code });
        if (result.success) {
            showToast('Script basariyla calisti (' + result.duration + 'ms)', 'success');
        } else {
            showToast('Script hatasi: ' + result.error, 'danger');
        }
    } catch (err) {
        showToast('Hata: ' + err.message, 'danger');
    }
}

function editScript(id) {
    showScriptEditor(id);
}

async function runScript(id) {
    try {
        const result = await api('api/scripts/' + id + '/run', 'POST');
        if (result.success) {
            showToast('Script calisti', 'success');
        } else {
            showToast('Script hatasi: ' + result.error, 'danger');
        }
    } catch (err) {
        showToast('Hata: ' + err.message, 'danger');
    }
}

async function toggleScript(id) {
    await api('api/scripts/' + id + '/toggle', 'POST');
    loadScripts();
}

function deleteScript(id) {
    deleteResource('api/scripts', id, loadScripts, 'Scripti silmek istediginize emin misiniz?', 'Script silindi');
}

async function showScriptLogs(id) {
    try {
        const logs = await api('api/scripts/' + id + '/logs?limit=50');
        let html = '<div class="modal fade show" style="display:block" tabindex="-1"><div class="modal-dialog modal-lg"><div class="modal-content">';
        html += '<div class="modal-header"><h5>Script Loglari</h5><button type="button" class="btn-close" onclick="this.closest(\'.modal\').remove()"></button></div>';
        html += '<div class="modal-body"><table class="table table-sm"><thead><tr><th>Zaman</th><th>Seviye</th><th>Mesaj</th></tr></thead><tbody>';
        logs.forEach(l => {
            html += '<tr><td>' + formatDateTime(l.created_at) + '</td><td><span class="badge bg-' + (l.level === 'error' ? 'danger' : 'info') + '">' + l.level + '</span></td><td>' + escapeHtml(l.message) + '</td></tr>';
        });
        html += '</tbody></table></div></div></div></div>';
        document.body.insertAdjacentHTML('beforeend', html);
    } catch (err) {
        showToast('Hata: ' + err.message, 'danger');
    }
}

async function logout() {
    await fetch('auth/logout', { method: 'POST' });
    window.location.href = './';
}

// Helpers
function escapeHtml(text) {
    if (!text) return '';
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

// Sanitize URL to prevent XSS via javascript: or data: URLs
function sanitizeUrl(url) {
    if (!url) return '';
    const trimmed = url.trim().toLowerCase();

    // Block dangerous protocols
    if (trimmed.startsWith('javascript:') || trimmed.startsWith('data:') || trimmed.startsWith('vbscript:')) {
        return '';
    }

    // Block protocol-relative URLs that could load external malicious content
    if (trimmed.startsWith('//')) {
        return '';
    }

    // Only allow http, https, or relative paths (starting with / or alphanumeric)
    if (trimmed.startsWith('http://') || trimmed.startsWith('https://') ||
        trimmed.startsWith('/') || trimmed.startsWith('api/') || /^[a-z0-9]/.test(trimmed)) {
        return escapeHtml(url);
    }

    return '';
}

function formatTime(ts) {
    if (!ts) return '';
    return new Date(ts).toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' });
}

function formatDateTime(ts) {
    if (!ts) return '';
    return new Date(ts).toLocaleString('tr-TR');
}

function debounce(func, wait) {
    let timeout;
    return function() {
        const args = arguments;
        clearTimeout(timeout);
        timeout = setTimeout(() => func.apply(this, args), wait);
    };
}

function showToast(message, type) {
    type = type || 'info';
    const container = document.getElementById('toastContainer') || createToastContainer();
    const toast = document.createElement('div');
    toast.className = 'toast show align-items-center text-white bg-' + type;
    toast.innerHTML = '<div class="d-flex"><div class="toast-body">' + escapeHtml(message) + '</div><button type="button" class="btn-close btn-close-white me-2 m-auto" onclick="this.parentElement.parentElement.remove()"></button></div>';
    container.appendChild(toast);
    setTimeout(() => toast.remove(), 5000);
}

function createToastContainer() {
    const container = document.createElement('div');
    container.id = 'toastContainer';
    container.className = 'position-fixed bottom-0 end-0 p-3';
    container.style.zIndex = '1100';
    document.body.appendChild(container);
    return container;
}
