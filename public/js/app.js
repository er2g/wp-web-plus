/**
 * WhatsApp Premium Plus - Frontend App
 * Modern WhatsApp-like interface with premium features
 */

let socket;
let currentChat = null;
let chats = [];
let allMessages = [];
let monacoEditor = null;
let editingScriptId = null;
let settings = {
    downloadMedia: true,
    syncOnConnect: true,
    uploadToDrive: false,
    notifications: true,
    sounds: true
};

// Initialize
document.addEventListener('DOMContentLoaded', () => {
    loadTheme();
    initSocket();
    initMonaco();
    loadInitialData();

    // Close dropdowns when clicking outside
    document.addEventListener('click', (e) => {
        if (!e.target.closest('.dropdown')) {
            document.querySelectorAll('.dropdown-menu.show').forEach(m => m.classList.remove('show'));
        }
    });
});

// Theme Management
function loadTheme() {
    const theme = localStorage.getItem('theme') || 'light';
    document.documentElement.setAttribute('data-theme', theme);
    updateThemeUI(theme);
}

function toggleTheme() {
    const current = document.documentElement.getAttribute('data-theme') || 'light';
    const newTheme = current === 'dark' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', newTheme);
    localStorage.setItem('theme', newTheme);
    updateThemeUI(newTheme);
    closeAllPanels();
}

function updateThemeUI(theme) {
    const themeText = document.getElementById('themeText');
    const toggleDarkMode = document.getElementById('toggleDarkMode');
    if (themeText) {
        themeText.textContent = theme === 'dark' ? 'Acik Mod' : 'Karanlik Mod';
    }
    if (toggleDarkMode) {
        toggleDarkMode.classList.toggle('active', theme === 'dark');
    }
}

// Socket.IO
function initSocket() {
    const basePath = window.location.pathname.endsWith('/') ? window.location.pathname : window.location.pathname + '/';
    socket = io({ path: basePath + 'socket.io/' });

    socket.on('connect', () => console.log('Socket connected'));
    socket.on('disconnect', () => console.log('Socket disconnected'));
    socket.on('status', updateConnectionStatus);
    socket.on('qr', showQR);
    socket.on('ready', (info) => {
        hideQR();
        updateConnectionStatus({ status: 'ready', info });
        showToast('WhatsApp baglandi: ' + info.pushname, 'success');
        loadChats();
        loadAllMessages();
    });
    socket.on('disconnected', () => {
        updateConnectionStatus({ status: 'disconnected' });
        showToast('WhatsApp baglantisi kesildi', 'warning');
    });
    socket.on('message', handleNewMessage);
    socket.on('sync_progress', updateSyncProgress);
    socket.on('sync_complete', (data) => {
        showToast('Senkronizasyon tamamlandi: ' + data.chats + ' sohbet, ' + data.messages + ' mesaj', 'success');
        loadChats();
        loadAllMessages();
    });
}

// Monaco Editor
function initMonaco() {
    if (typeof require === 'undefined') return;
    require.config({ paths: { vs: 'https://cdnjs.cloudflare.com/ajax/libs/monaco-editor/0.45.0/min/vs' } });
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

// Panel Management
function openSettings() {
    closeAllPanels();
    document.getElementById('settingsPanel').classList.add('open');
    document.getElementById('overlay').classList.add('show');
}

function closeSettings() {
    document.getElementById('settingsPanel').classList.remove('open');
    document.getElementById('overlay').classList.remove('show');
}

function openFeatures() {
    closeAllPanels();
    document.getElementById('featuresPanel').classList.add('open');
    document.getElementById('overlay').classList.add('show');
}

function closeFeatures() {
    document.getElementById('featuresPanel').classList.remove('open');
    document.getElementById('overlay').classList.remove('show');
}

function closeAllPanels() {
    document.getElementById('settingsPanel').classList.remove('open');
    document.getElementById('featuresPanel').classList.remove('open');
    document.getElementById('overlay').classList.remove('show');
    document.querySelectorAll('.dropdown-menu.show').forEach(m => m.classList.remove('show'));
}

function toggleDropdown(id) {
    event.stopPropagation();
    const menu = document.getElementById(id);
    const isOpen = menu.classList.contains('show');
    document.querySelectorAll('.dropdown-menu.show').forEach(m => m.classList.remove('show'));
    if (!isOpen) menu.classList.add('show');
}

// Tab Management
function switchSidebarTab(tab) {
    // Update tab buttons
    document.querySelectorAll('.tab-nav button').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.tab === tab);
    });

    // Show/hide content
    document.getElementById('chatList').style.display = tab === 'chats' ? 'block' : 'none';
    document.getElementById('messagesList').style.display = tab === 'messages' ? 'block' : 'none';
    document.getElementById('logsList').style.display = tab === 'logs' ? 'block' : 'none';

    // Load data
    if (tab === 'chats') loadChats();
    else if (tab === 'messages') renderMessagesList();
    else if (tab === 'logs') loadLogs();
}

function showTab(tabName) {
    closeAllPanels();
    showModal(tabName);
}

// Connection Status
function updateConnectionStatus(status) {
    const container = document.getElementById('connectionStatus');
    const icon = document.getElementById('connectionIcon');
    const text = document.getElementById('connectionText');
    const spinner = document.getElementById('connectionSpinner');

    if (!container) return;

    container.classList.remove('disconnected', 'connecting', 'connected');

    switch (status.status) {
        case 'disconnected':
            container.classList.add('disconnected');
            icon.className = 'bi bi-wifi-off';
            icon.style.display = 'inline';
            spinner.style.display = 'none';
            text.textContent = 'Bagli Degil';
            break;
        case 'qr':
            container.classList.add('connecting');
            icon.style.display = 'none';
            spinner.style.display = 'inline-block';
            text.textContent = 'QR Kod Bekleniyor';
            break;
        case 'authenticated':
            container.classList.add('connecting');
            icon.style.display = 'none';
            spinner.style.display = 'inline-block';
            text.textContent = 'Baglaniyor...';
            break;
        case 'ready':
            container.classList.remove('disconnected');
            container.style.backgroundColor = 'var(--accent)';
            icon.className = 'bi bi-wifi';
            icon.style.display = 'inline';
            spinner.style.display = 'none';
            text.textContent = status.info ? 'Bagli - ' + status.info.pushname : 'Bagli';
            break;
    }
}

// QR Code
function showQR(qr) {
    const chatArea = document.getElementById('chatArea');
    const emptyChatView = document.getElementById('emptyChatView');
    const qrSection = document.getElementById('qrSection');
    const qrImg = document.getElementById('qrCode');

    chatArea.classList.remove('empty');
    emptyChatView.style.display = 'none';
    qrSection.style.display = 'flex';
    qrImg.src = qr;
}

function hideQR() {
    const chatArea = document.getElementById('chatArea');
    const emptyChatView = document.getElementById('emptyChatView');
    const qrSection = document.getElementById('qrSection');

    qrSection.style.display = 'none';
    if (!currentChat) {
        chatArea.classList.add('empty');
        emptyChatView.style.display = 'flex';
    }
}

// Load Functions
async function loadInitialData() {
    try {
        const status = await api('api/status');
        updateConnectionStatus(status.whatsapp);
        loadSettings();
        loadChats();
        loadAllMessages();
        if (status.whatsapp && status.whatsapp.syncProgress && status.whatsapp.syncProgress.syncing) {
            updateSyncProgress(status.whatsapp.syncProgress);
        }
    } catch (err) {
        console.error('Initial load error:', err);
        showToast('Veri yuklenemedi: ' + err.message, 'error');
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
        allMessages = await api('api/messages?limit=200');
        renderMessagesList();
    } catch (err) {
        console.error('Messages load error:', err);
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

async function loadLogs() {
    try {
        const logs = await api('api/logs?limit=100');
        renderLogsList(logs);
    } catch (err) {
        console.error('Logs load error:', err);
    }
}

async function loadSettings() {
    try {
        const data = await api('api/settings');
        settings = { ...settings, ...data };
        updateSettingsUI();
    } catch (err) {
        console.error('Settings load error:', err);
    }
}

function updateSettingsUI() {
    const toggles = {
        'toggleDownloadMedia': settings.downloadMedia,
        'toggleSyncOnConnect': settings.syncOnConnect,
        'toggleUploadToDrive': settings.uploadToDrive,
        'toggleNotifications': settings.notifications,
        'toggleSounds': settings.sounds
    };

    Object.entries(toggles).forEach(([id, value]) => {
        const el = document.getElementById(id);
        if (el) el.classList.toggle('active', value);
    });
}

async function toggleSetting(key) {
    settings[key] = !settings[key];
    updateSettingsUI();
    try {
        await api('api/settings', 'POST', settings);
    } catch (err) {
        showToast('Ayar kaydedilemedi: ' + err.message, 'error');
    }
}

// Render Functions
function renderChatList(chatList) {
    const container = document.getElementById('chatList');
    if (!container) return;

    if (chatList.length === 0) {
        container.innerHTML = '<div class="chat-item"><div class="chat-info"><div class="chat-name" style="color: var(--text-secondary)">Henuz sohbet yok</div></div></div>';
        return;
    }

    container.innerHTML = chatList.map(c => {
        const isGroup = c.chat_id && c.chat_id.includes('@g.us');
        const avatarClass = isGroup ? 'avatar group' : 'avatar';
        const avatarIcon = isGroup ? 'bi-people-fill' : 'bi-person-fill';
        const isActive = currentChat === c.chat_id;
        const hasUnread = c.unread_count > 0;

        return '<div class="chat-item' + (isActive ? ' active' : '') + (hasUnread ? ' unread' : '') + '" onclick="selectChat(\'' + c.chat_id + '\', \'' + escapeHtml(c.name) + '\')">' +
            '<div class="' + avatarClass + '"><i class="bi ' + avatarIcon + '"></i></div>' +
            '<div class="chat-info">' +
                '<div class="top-row">' +
                    '<div class="chat-name">' + escapeHtml(c.name) + '</div>' +
                    '<span class="chat-time">' + formatTime(c.last_message_time) + '</span>' +
                '</div>' +
                '<div class="chat-preview">' +
                    '<span class="preview-text">' + escapeHtml((c.last_message || '').substring(0, 40)) + '</span>' +
                    (hasUnread ? '<span class="unread-badge">' + c.unread_count + '</span>' : '') +
                '</div>' +
            '</div>' +
        '</div>';
    }).join('');
}

function renderMessagesList() {
    const container = document.getElementById('messagesList');
    if (!container) return;

    if (allMessages.length === 0) {
        container.innerHTML = '<div class="chat-item"><div class="chat-info"><div class="chat-name" style="color: var(--text-secondary)">Henuz mesaj yok</div></div></div>';
        return;
    }

    container.innerHTML = allMessages.slice(0, 50).map(m => {
        const isMine = m.is_from_me === 1 || m.is_from_me === true;
        const direction = isMine ? '<i class="bi bi-arrow-up-right" style="color: var(--accent)"></i>' : '<i class="bi bi-arrow-down-left" style="color: #34b7f1"></i>';

        return '<div class="chat-item" onclick="openChatForMessage(\'' + (m.chat_id || '') + '\')">' +
            '<div class="avatar"><i class="bi bi-chat-text-fill"></i></div>' +
            '<div class="chat-info">' +
                '<div class="top-row">' +
                    '<div class="chat-name">' + direction + ' ' + escapeHtml(formatSenderName(m.from_name)) + '</div>' +
                    '<span class="chat-time">' + formatTime(m.timestamp) + '</span>' +
                '</div>' +
                '<div class="chat-preview">' +
                    '<span class="preview-text">' + escapeHtml((m.body || '[Medya]').substring(0, 50)) + '</span>' +
                '</div>' +
            '</div>' +
        '</div>';
    }).join('');
}

function renderLogsList(logs) {
    const container = document.getElementById('logsList');
    if (!container) return;

    if (logs.length === 0) {
        container.innerHTML = '<div class="chat-item"><div class="chat-info"><div class="chat-name" style="color: var(--text-secondary)">Henuz log yok</div></div></div>';
        return;
    }

    container.innerHTML = logs.map(l => {
        const levelColors = { error: '#f15c6d', warn: '#ffc107', info: '#34b7f1' };
        const color = levelColors[l.level] || '#667781';

        return '<div class="chat-item">' +
            '<div class="avatar" style="background-color: ' + color + '20"><i class="bi bi-journal-text" style="color: ' + color + '"></i></div>' +
            '<div class="chat-info">' +
                '<div class="top-row">' +
                    '<div class="chat-name" style="color: ' + color + '">' + l.category + ' - ' + l.level.toUpperCase() + '</div>' +
                    '<span class="chat-time">' + formatTime(l.created_at) + '</span>' +
                '</div>' +
                '<div class="chat-preview">' +
                    '<span class="preview-text">' + escapeHtml(l.message.substring(0, 60)) + '</span>' +
                '</div>' +
            '</div>' +
        '</div>';
    }).join('');
}

function renderChatMessages(messages) {
    const container = document.getElementById('messagesContainer');
    if (!container) return;

    // Sort messages chronologically
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
                    mediaHtml = '<div class="document-bubble" onclick="window.open(\'' + safeMediaUrl + '\')">' +
                        '<div class="doc-icon pdf"><i class="bi bi-file-earmark-pdf"></i></div>' +
                        '<div class="doc-info"><div class="doc-name">' + escapeHtml(fileName) + '</div>' +
                        '<div class="doc-size">Indir</div></div></div>';
                }
            }
        }

        let textHtml = '';
        if (m.body && (m.type === 'chat' || (mediaUrl && m.body && m.type !== 'document'))) {
            textHtml = '<div class="message-text">' + escapeHtml(m.body) + '</div>';
        }

        const senderHtml = (!isMine && m.from_name) ?
            '<div class="sender-name">' + escapeHtml(formatSenderName(m.from_name)) + '</div>' : '';

        const checkIcon = isMine ? '<i class="bi bi-check2-all check-icon read"></i>' : '';

        return '<div class="message-row ' + (isMine ? 'sent' : 'received') + '">' +
            '<div class="message-bubble ' + (isMine ? 'sent' : 'received') + '">' +
            senderHtml +
            mediaHtml +
            textHtml +
            '<div class="message-footer"><span class="message-time">' + formatTime(m.timestamp) + '</span>' + checkIcon + '</div>' +
            '</div></div>';
    }).join('');

    // Scroll to bottom
    setTimeout(() => {
        container.scrollTop = container.scrollHeight;
    }, 100);
}

// Chat Selection
function selectChat(chatId, name) {
    currentChat = chatId;

    const chatArea = document.getElementById('chatArea');
    const emptyChatView = document.getElementById('emptyChatView');
    const qrSection = document.getElementById('qrSection');
    const activeChatView = document.getElementById('activeChatView');
    const chatName = document.getElementById('chatName');
    const chatStatus = document.getElementById('chatStatus');

    chatArea.classList.remove('empty');
    emptyChatView.style.display = 'none';
    qrSection.style.display = 'none';
    activeChatView.style.display = 'flex';
    activeChatView.style.flexDirection = 'column';
    activeChatView.style.height = '100%';

    chatName.textContent = name;
    chatStatus.textContent = 'son gorulme yakin zamanda';

    loadChatMessages(chatId);
    renderChatList(chats);

    // Mobile: show chat area
    if (window.innerWidth <= 768) {
        chatArea.classList.add('active');
    }
}

function closeChat() {
    currentChat = null;
    const chatArea = document.getElementById('chatArea');
    const activeChatView = document.getElementById('activeChatView');

    activeChatView.style.display = 'none';
    chatArea.classList.remove('active');
    chatArea.classList.add('empty');
    document.getElementById('emptyChatView').style.display = 'flex';
}

function openChatForMessage(chatId) {
    if (!chatId) return;
    const chat = chats.find(c => c.chat_id === chatId);
    if (chat) {
        selectChat(chatId, chat.name);
    }
}

// Chat Search
function filterChats() {
    const query = document.getElementById('searchInput').value.toLowerCase();
    const filtered = chats.filter(c => c.name.toLowerCase().includes(query));
    renderChatList(filtered);
}

// Send Message
async function sendMessage() {
    const input = document.getElementById('messageInput');
    const message = input.value.trim();

    if (!currentChat || !message) return;

    input.value = '';
    autoResizeInput(input);

    // Add temporary message
    appendTempMessage(message);

    try {
        await api('api/send', 'POST', { chatId: currentChat, message });
        setTimeout(() => loadChatMessages(currentChat), 500);
    } catch (err) {
        showToast('Gonderme hatasi: ' + err.message, 'error');
        loadChatMessages(currentChat);
    }
}

function handleInputKeydown(event) {
    if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault();
        sendMessage();
    }
}

function autoResizeInput(el) {
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 100) + 'px';
}

function appendTempMessage(text) {
    const container = document.getElementById('messagesContainer');
    if (!container) return;

    const messageHtml = '<div class="message-row sent">' +
        '<div class="message-bubble sent">' +
        '<div class="message-text">' + escapeHtml(text) + '</div>' +
        '<div class="message-footer"><span class="message-time">' + formatTime(Date.now()) + '</span><i class="bi bi-check2 check-icon"></i></div>' +
        '</div></div>';

    container.insertAdjacentHTML('beforeend', messageHtml);
    container.scrollTop = container.scrollHeight;
}

// Handle new incoming message
function handleNewMessage(msg) {
    console.log('New message received:', msg);

    if (settings.notifications) {
        showToast('Yeni mesaj: ' + formatSenderName(msg.fromName), 'info');
    }

    if (currentChat && currentChat === msg.chatId) {
        appendNewMessage(msg);
    }

    loadChats();
}

function appendNewMessage(msg) {
    const container = document.getElementById('messagesContainer');
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
            }
        }
    }

    let textHtml = '';
    if (msg.body && (msg.type === 'chat' || msg.type === undefined)) {
        textHtml = '<div class="message-text">' + escapeHtml(msg.body) + '</div>';
    }

    const senderHtml = (!isMine && msg.fromName) ?
        '<div class="sender-name">' + escapeHtml(formatSenderName(msg.fromName)) + '</div>' : '';

    const checkIcon = isMine ? '<i class="bi bi-check2-all check-icon read"></i>' : '';
    const time = msg.timestamp ? formatTime(msg.timestamp) : formatTime(Date.now());

    const messageHtml = '<div class="message-row ' + (isMine ? 'sent' : 'received') + '">' +
        '<div class="message-bubble ' + (isMine ? 'sent' : 'received') + '">' +
        senderHtml + mediaHtml + textHtml +
        '<div class="message-footer"><span class="message-time">' + time + '</span>' + checkIcon + '</div>' +
        '</div></div>';

    container.insertAdjacentHTML('beforeend', messageHtml);
    container.scrollTop = container.scrollHeight;
}

// Actions
async function reconnect() {
    try {
        await api('api/connect', 'POST');
        showToast('Baglanti baslatiliyor...', 'info');
    } catch (err) {
        showToast('Baglanti hatasi: ' + err.message, 'error');
    }
    closeSettings();
}

async function disconnect() {
    try {
        await api('api/disconnect', 'POST');
        showToast('Baglanti kesildi', 'warning');
    } catch (err) {
        showToast('Hata: ' + err.message, 'error');
    }
    closeSettings();
}

async function startSync() {
    try {
        showToast('Senkronizasyon baslatiliyor...', 'info');
        const result = await api('api/sync', 'POST');
        if (result.success) {
            showToast('Senkronizasyon tamamlandi: ' + result.chats + ' sohbet, ' + result.messages + ' mesaj', 'success');
            loadChats();
            loadAllMessages();
        } else {
            showToast('Senkronizasyon hatasi: ' + result.error, 'error');
        }
    } catch (err) {
        showToast('Hata: ' + err.message, 'error');
    }
}

function updateSyncProgress(progress) {
    // Can show a progress indicator if needed
    console.log('Sync progress:', progress);
}

// Chat actions
function searchInChat() {
    showToast('Sohbette arama henuz desteklenmiyor', 'info');
}

function refreshChat() {
    if (currentChat) {
        loadChatMessages(currentChat);
        showToast('Sohbet yenilendi', 'success');
    }
    document.querySelectorAll('.dropdown-menu.show').forEach(m => m.classList.remove('show'));
}

function exportChat() {
    showToast('Sohbet disa aktarma henuz desteklenmiyor', 'info');
    document.querySelectorAll('.dropdown-menu.show').forEach(m => m.classList.remove('show'));
}

function clearChat() {
    showToast('Sohbet temizleme henuz desteklenmiyor', 'info');
    document.querySelectorAll('.dropdown-menu.show').forEach(m => m.classList.remove('show'));
}

// Emoji and Attach (placeholder)
function toggleEmojiPicker() {
    showToast('Emoji secici yakinda gelecek', 'info');
}

function toggleAttachMenu() {
    showToast('Dosya ekleme yakinda gelecek', 'info');
}

// Media Lightbox
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

// Modal for Features
function showModal(feature) {
    const container = document.getElementById('modalContainer');
    let content = '';
    let title = '';

    switch (feature) {
        case 'dashboard':
            title = 'Dashboard';
            content = getDashboardContent();
            break;
        case 'scripts':
            title = 'Script Yoneticisi';
            content = getScriptsContent();
            loadScriptsData();
            break;
        case 'auto-reply':
            title = 'Otomatik Yanitlar';
            content = getAutoReplyContent();
            loadAutoRepliesData();
            break;
        case 'scheduled':
            title = 'Zamanli Mesajlar';
            content = getScheduledContent();
            loadScheduledData();
            break;
        case 'webhooks':
            title = 'Webhooks';
            content = getWebhooksContent();
            loadWebhooksData();
            break;
        case 'drive':
            title = 'Google Drive';
            content = getDriveContent();
            checkDriveStatus();
            break;
        default:
            return;
    }

    container.innerHTML = '<div class="modal-overlay show" onclick="if(event.target===this)closeModal()">' +
        '<div class="modal" style="max-width: 700px;">' +
        '<div class="modal-header"><h3>' + title + '</h3><i class="bi bi-x-lg close-btn" onclick="closeModal()"></i></div>' +
        '<div class="modal-body">' + content + '</div>' +
        '</div></div>';
}

function closeModal() {
    document.getElementById('modalContainer').innerHTML = '';
}

// Dashboard Content
function getDashboardContent() {
    return '<div class="stats-grid" id="statsGrid">' +
        '<div class="stat-card"><div class="icon green"><i class="bi bi-chat-fill"></i></div><div class="info"><div class="value" id="statTotal">-</div><div class="label">Toplam Mesaj</div></div></div>' +
        '<div class="stat-card"><div class="icon blue"><i class="bi bi-arrow-up-right"></i></div><div class="info"><div class="value" id="statSent">-</div><div class="label">Gonderilen</div></div></div>' +
        '<div class="stat-card"><div class="icon orange"><i class="bi bi-arrow-down-left"></i></div><div class="info"><div class="value" id="statReceived">-</div><div class="label">Alinan</div></div></div>' +
        '<div class="stat-card"><div class="icon red"><i class="bi bi-calendar-day"></i></div><div class="info"><div class="value" id="statToday">-</div><div class="label">Bugun</div></div></div>' +
        '</div>';
}

// Scripts Content
function getScriptsContent() {
    return '<div style="margin-bottom: 16px;"><button class="btn btn-primary" onclick="showScriptEditor()"><i class="bi bi-plus"></i> Yeni Script</button></div>' +
        '<div id="scriptsListModal"></div>';
}

async function loadScriptsData() {
    try {
        const scripts = await api('api/scripts');
        const container = document.getElementById('scriptsListModal');
        if (!container) return;

        if (scripts.length === 0) {
            container.innerHTML = '<p style="color: var(--text-secondary)">Henuz script yok</p>';
            return;
        }

        container.innerHTML = scripts.map(s =>
            '<div class="settings-item" style="border: 1px solid var(--border-color); border-radius: 8px; margin-bottom: 8px; padding: 12px;">' +
            '<div class="info" style="flex: 1;">' +
                '<div class="title">' + escapeHtml(s.name) + '</div>' +
                '<div class="subtitle">' + escapeHtml(s.description || 'Aciklama yok') + ' - ' + s.trigger_type + '</div>' +
            '</div>' +
            '<span style="padding: 4px 8px; border-radius: 4px; font-size: 12px; background: ' + (s.is_active ? 'var(--accent)' : 'var(--text-light)') + '; color: white; margin-right: 8px;">' + (s.is_active ? 'Aktif' : 'Pasif') + '</span>' +
            '<button class="icon-btn" onclick="editScript(' + s.id + ')" title="Duzenle"><i class="bi bi-pencil"></i></button>' +
            '<button class="icon-btn" onclick="toggleScript(' + s.id + ')" title="Toggle"><i class="bi bi-toggle-on"></i></button>' +
            '<button class="icon-btn" onclick="deleteScript(' + s.id + ')" title="Sil"><i class="bi bi-trash" style="color: #f15c6d;"></i></button>' +
            '</div>'
        ).join('');
    } catch (err) {
        console.error('Scripts load error:', err);
    }
}

// Auto-reply Content
function getAutoReplyContent() {
    return '<form id="autoReplyFormModal" onsubmit="submitAutoReply(event)" style="margin-bottom: 20px; padding: 16px; background: var(--bg-secondary); border-radius: 8px;">' +
        '<div class="form-group"><label class="form-label">Tetikleyici Kelime</label><input type="text" class="form-input" id="triggerWordModal" required></div>' +
        '<div class="form-group"><label class="form-label">Yanit</label><textarea class="form-input" id="autoResponseModal" rows="3" required></textarea></div>' +
        '<div class="form-group"><label class="form-label">Eslesme Tipi</label><select class="form-input" id="matchTypeModal"><option value="contains">Icerir</option><option value="exact">Tam Eslesme</option><option value="startswith">Ile Baslar</option></select></div>' +
        '<button type="submit" class="btn btn-primary">Ekle</button>' +
        '</form>' +
        '<div id="autoRepliesListModal"></div>';
}

async function submitAutoReply(event) {
    event.preventDefault();
    const data = {
        trigger_word: document.getElementById('triggerWordModal').value,
        response: document.getElementById('autoResponseModal').value,
        match_type: document.getElementById('matchTypeModal').value
    };
    try {
        await api('api/auto-replies', 'POST', data);
        document.getElementById('autoReplyFormModal').reset();
        loadAutoRepliesData();
        showToast('Otomatik yanit eklendi', 'success');
    } catch (err) {
        showToast('Hata: ' + err.message, 'error');
    }
}

async function loadAutoRepliesData() {
    try {
        const replies = await api('api/auto-replies');
        const container = document.getElementById('autoRepliesListModal');
        if (!container) return;

        if (replies.length === 0) {
            container.innerHTML = '<p style="color: var(--text-secondary)">Henuz otomatik yanit yok</p>';
            return;
        }

        container.innerHTML = replies.map(r =>
            '<div class="settings-item" style="border: 1px solid var(--border-color); border-radius: 8px; margin-bottom: 8px; padding: 12px;">' +
            '<div class="info" style="flex: 1;">' +
                '<div class="title">"' + escapeHtml(r.trigger_word) + '" -> "' + escapeHtml(r.response.substring(0, 50)) + '"</div>' +
                '<div class="subtitle">' + r.match_type + '</div>' +
            '</div>' +
            '<span style="padding: 4px 8px; border-radius: 4px; font-size: 12px; background: ' + (r.is_active ? 'var(--accent)' : 'var(--text-light)') + '; color: white; margin-right: 8px;">' + (r.is_active ? 'Aktif' : 'Pasif') + '</span>' +
            '<button class="icon-btn" onclick="toggleAutoReply(' + r.id + ')" title="Toggle"><i class="bi bi-toggle-on"></i></button>' +
            '<button class="icon-btn" onclick="deleteAutoReply(' + r.id + ')" title="Sil"><i class="bi bi-trash" style="color: #f15c6d;"></i></button>' +
            '</div>'
        ).join('');
    } catch (err) {
        console.error('Auto replies load error:', err);
    }
}

// Scheduled Content
function getScheduledContent() {
    return '<form id="scheduledFormModal" onsubmit="submitScheduled(event)" style="margin-bottom: 20px; padding: 16px; background: var(--bg-secondary); border-radius: 8px;">' +
        '<div class="form-group"><label class="form-label">Sohbet ID</label><input type="text" class="form-input" id="schedChatIdModal" placeholder="905xxxxxxxxxx@c.us" required></div>' +
        '<div class="form-group"><label class="form-label">Sohbet Adi</label><input type="text" class="form-input" id="schedChatNameModal" required></div>' +
        '<div class="form-group"><label class="form-label">Mesaj</label><textarea class="form-input" id="schedMessageModal" rows="3" required></textarea></div>' +
        '<div class="form-group"><label class="form-label">Gonderim Zamani</label><input type="datetime-local" class="form-input" id="schedTimeModal" required></div>' +
        '<button type="submit" class="btn btn-primary">Zamanla</button>' +
        '</form>' +
        '<div id="scheduledListModal"></div>';
}

async function submitScheduled(event) {
    event.preventDefault();
    const data = {
        chat_id: document.getElementById('schedChatIdModal').value,
        chat_name: document.getElementById('schedChatNameModal').value,
        message: document.getElementById('schedMessageModal').value,
        scheduled_at: document.getElementById('schedTimeModal').value
    };
    try {
        await api('api/scheduled', 'POST', data);
        document.getElementById('scheduledFormModal').reset();
        loadScheduledData();
        showToast('Mesaj zamanlandi', 'success');
    } catch (err) {
        showToast('Hata: ' + err.message, 'error');
    }
}

async function loadScheduledData() {
    try {
        const scheduled = await api('api/scheduled');
        const container = document.getElementById('scheduledListModal');
        if (!container) return;

        if (scheduled.length === 0) {
            container.innerHTML = '<p style="color: var(--text-secondary)">Henuz zamanli mesaj yok</p>';
            return;
        }

        container.innerHTML = scheduled.map(s =>
            '<div class="settings-item" style="border: 1px solid var(--border-color); border-radius: 8px; margin-bottom: 8px; padding: 12px;">' +
            '<div class="info" style="flex: 1;">' +
                '<div class="title">' + escapeHtml(s.chat_name || s.chat_id) + '</div>' +
                '<div class="subtitle">' + escapeHtml(s.message.substring(0, 50)) + ' - ' + formatDateTime(s.scheduled_at) + '</div>' +
            '</div>' +
            '<span style="padding: 4px 8px; border-radius: 4px; font-size: 12px; background: ' + (s.is_sent ? 'var(--accent)' : '#ffc107') + '; color: ' + (s.is_sent ? 'white' : '#111') + ';">' + (s.is_sent ? 'Gonderildi' : 'Bekliyor') + '</span>' +
            '<button class="icon-btn" onclick="deleteScheduled(' + s.id + ')" title="Sil"><i class="bi bi-trash" style="color: #f15c6d;"></i></button>' +
            '</div>'
        ).join('');
    } catch (err) {
        console.error('Scheduled load error:', err);
    }
}

// Webhooks Content
function getWebhooksContent() {
    return '<form id="webhookFormModal" onsubmit="submitWebhook(event)" style="margin-bottom: 20px; padding: 16px; background: var(--bg-secondary); border-radius: 8px;">' +
        '<div class="form-group"><label class="form-label">Webhook Adi</label><input type="text" class="form-input" id="webhookNameModal" required></div>' +
        '<div class="form-group"><label class="form-label">URL</label><input type="url" class="form-input" id="webhookUrlModal" placeholder="https://..." required></div>' +
        '<div class="form-group"><label class="form-label">Olaylar</label><input type="text" class="form-input" id="webhookEventsModal" placeholder="message,ready" required></div>' +
        '<button type="submit" class="btn btn-primary">Ekle</button>' +
        '</form>' +
        '<div id="webhooksListModal"></div>';
}

async function submitWebhook(event) {
    event.preventDefault();
    const data = {
        name: document.getElementById('webhookNameModal').value,
        url: document.getElementById('webhookUrlModal').value,
        events: document.getElementById('webhookEventsModal').value
    };
    try {
        await api('api/webhooks', 'POST', data);
        document.getElementById('webhookFormModal').reset();
        loadWebhooksData();
        showToast('Webhook eklendi', 'success');
    } catch (err) {
        showToast('Hata: ' + err.message, 'error');
    }
}

async function loadWebhooksData() {
    try {
        const webhooks = await api('api/webhooks');
        const container = document.getElementById('webhooksListModal');
        if (!container) return;

        if (webhooks.length === 0) {
            container.innerHTML = '<p style="color: var(--text-secondary)">Henuz webhook yok</p>';
            return;
        }

        container.innerHTML = webhooks.map(w =>
            '<div class="settings-item" style="border: 1px solid var(--border-color); border-radius: 8px; margin-bottom: 8px; padding: 12px;">' +
            '<div class="info" style="flex: 1;">' +
                '<div class="title">' + escapeHtml(w.name) + '</div>' +
                '<div class="subtitle">' + escapeHtml(w.url) + ' - ' + w.events + '</div>' +
            '</div>' +
            '<span style="padding: 4px 8px; border-radius: 4px; font-size: 12px; background: ' + (w.is_active ? 'var(--accent)' : 'var(--text-light)') + '; color: white;">' + (w.is_active ? 'Aktif' : 'Pasif') + '</span>' +
            '<button class="icon-btn" onclick="deleteWebhook(' + w.id + ')" title="Sil"><i class="bi bi-trash" style="color: #f15c6d;"></i></button>' +
            '</div>'
        ).join('');
    } catch (err) {
        console.error('Webhooks load error:', err);
    }
}

// Drive Content
function getDriveContent() {
    return '<div id="driveStatusModal" style="margin-bottom: 20px;"></div>' +
        '<button class="btn btn-primary" id="btnMigrateDriveModal" onclick="migrateToDrive()" disabled><i class="bi bi-cloud-upload"></i> Drive\'a Tasi</button>' +
        '<div id="driveProgressModal" style="display: none; margin-top: 16px;"><div style="background: var(--border-color); height: 8px; border-radius: 4px;"><div id="driveProgressBarModal" style="background: var(--accent); height: 100%; border-radius: 4px; width: 0%; transition: width 0.3s;"></div></div><p id="driveProgressTextModal" style="margin-top: 8px; color: var(--text-secondary);"></p></div>';
}

async function checkDriveStatus() {
    try {
        const status = await api('api/drive/status');
        const container = document.getElementById('driveStatusModal');
        const btn = document.getElementById('btnMigrateDriveModal');

        if (!container) return;

        if (status.configured) {
            container.innerHTML = '<div style="display: flex; align-items: center; gap: 8px; color: var(--accent);"><i class="bi bi-check-circle-fill"></i> Google Drive yapilandirildi</div>';
            if (btn) btn.disabled = false;
        } else {
            container.innerHTML = '<div style="color: #f15c6d;"><i class="bi bi-exclamation-circle-fill"></i> Service Account bulunamadi<br><small style="color: var(--text-secondary);">Dosya yolu: ' + escapeHtml(status.keyPath) + '</small></div>';
            if (btn) btn.disabled = true;
        }
    } catch (err) {
        const container = document.getElementById('driveStatusModal');
        if (container) {
            container.innerHTML = '<span style="color: var(--text-secondary)">Drive durumu kontrol edilemedi</span>';
        }
    }
}

async function migrateToDrive() {
    if (!confirm('Tum medya dosyalari Google Drive\'a tasinacak. Devam etmek istiyor musunuz?')) return;

    const btn = document.getElementById('btnMigrateDriveModal');
    const progress = document.getElementById('driveProgressModal');
    const progressBar = document.getElementById('driveProgressBarModal');
    const progressText = document.getElementById('driveProgressTextModal');

    if (btn) btn.disabled = true;
    if (progress) progress.style.display = 'block';
    if (progressText) progressText.textContent = 'Baslatiliyor...';

    try {
        const result = await api('api/drive/migrate', 'POST');
        if (result.success) {
            if (progressBar) progressBar.style.width = '100%';
            if (progressText) progressText.textContent = result.migrated + ' dosya tasindi';
            showToast('Drive\'a tasima tamamlandi: ' + result.migrated + ' dosya', 'success');
        } else {
            if (progressText) progressText.textContent = 'Hata: ' + result.error;
            showToast('Drive hatasi: ' + result.error, 'error');
        }
    } catch (err) {
        if (progressText) progressText.textContent = 'Hata: ' + err.message;
        showToast('Drive hatasi: ' + err.message, 'error');
    }

    if (btn) btn.disabled = false;
}

// Script editor
function showScriptEditor(id) {
    editingScriptId = id || null;

    const modal = document.createElement('div');
    modal.className = 'modal-overlay show';
    modal.onclick = (e) => { if (e.target === modal) modal.remove(); };
    modal.innerHTML = '<div class="modal" style="max-width: 900px; height: 80vh;">' +
        '<div class="modal-header"><h3>' + (id ? 'Script Duzenle' : 'Yeni Script') + '</h3><i class="bi bi-x-lg close-btn" onclick="this.closest(\'.modal-overlay\').remove()"></i></div>' +
        '<div class="modal-body" style="display: flex; flex-direction: column; height: calc(100% - 130px);">' +
        '<div style="display: flex; gap: 12px; margin-bottom: 12px;">' +
        '<input type="text" class="form-input" id="scriptNameEditor" placeholder="Script Adi" style="flex: 1;">' +
        '<select class="form-input" id="scriptTriggerEditor" style="width: 150px;"><option value="message">Mesaj</option><option value="ready">Hazir</option><option value="manual">Manuel</option></select>' +
        '</div>' +
        '<input type="text" class="form-input" id="scriptDescEditor" placeholder="Aciklama" style="margin-bottom: 12px;">' +
        '<div id="scriptEditorContainer" style="flex: 1; border: 1px solid var(--border-color); border-radius: 4px;"></div>' +
        '</div>' +
        '<div class="modal-footer">' +
        '<button class="btn btn-secondary" onclick="testScriptCode()"><i class="bi bi-play"></i> Test</button>' +
        '<button class="btn btn-primary" onclick="saveScriptCode()"><i class="bi bi-check"></i> Kaydet</button>' +
        '</div></div>';

    document.body.appendChild(modal);

    // Init Monaco
    setTimeout(() => {
        if (typeof require !== 'undefined') {
            require(['vs/editor/editor.main'], function() {
                const container = document.getElementById('scriptEditorContainer');
                if (!container) return;
                monacoEditor = monaco.editor.create(container, {
                    value: '// Script kodunuz\n',
                    language: 'javascript',
                    theme: document.documentElement.getAttribute('data-theme') === 'dark' ? 'vs-dark' : 'vs',
                    minimap: { enabled: false },
                    automaticLayout: true,
                    fontSize: 14
                });

                if (id) {
                    loadScriptForEdit(id);
                }
            });
        }
    }, 100);
}

async function loadScriptForEdit(id) {
    try {
        const script = await api('api/scripts/' + id);
        document.getElementById('scriptNameEditor').value = script.name;
        document.getElementById('scriptDescEditor').value = script.description || '';
        document.getElementById('scriptTriggerEditor').value = script.trigger_type;
        if (monacoEditor) monacoEditor.setValue(script.code);
    } catch (err) {
        showToast('Script yuklenemedi: ' + err.message, 'error');
    }
}

async function saveScriptCode() {
    const data = {
        name: document.getElementById('scriptNameEditor').value,
        description: document.getElementById('scriptDescEditor').value,
        code: monacoEditor ? monacoEditor.getValue() : '',
        trigger_type: document.getElementById('scriptTriggerEditor').value
    };

    try {
        if (editingScriptId) {
            await api('api/scripts/' + editingScriptId, 'PUT', data);
        } else {
            await api('api/scripts', 'POST', data);
        }
        document.querySelector('.modal-overlay').remove();
        loadScriptsData();
        showToast('Script kaydedildi', 'success');
    } catch (err) {
        showToast('Hata: ' + err.message, 'error');
    }
}

async function testScriptCode() {
    const code = monacoEditor ? monacoEditor.getValue() : '';
    try {
        const result = await api('api/scripts/test', 'POST', { code });
        if (result.success) {
            showToast('Script basariyla calisti (' + result.duration + 'ms)', 'success');
        } else {
            showToast('Script hatasi: ' + result.error, 'error');
        }
    } catch (err) {
        showToast('Hata: ' + err.message, 'error');
    }
}

// CRUD Operations
async function toggleAutoReply(id) {
    await api('api/auto-replies/' + id + '/toggle', 'POST');
    loadAutoRepliesData();
}

async function deleteAutoReply(id) {
    if (!confirm('Silmek istediginize emin misiniz?')) return;
    try {
        await api('api/auto-replies/' + id, 'DELETE');
        loadAutoRepliesData();
        showToast('Silindi', 'success');
    } catch (err) {
        showToast('Silme hatasi: ' + err.message, 'error');
    }
}

async function deleteScheduled(id) {
    if (!confirm('Silmek istediginize emin misiniz?')) return;
    try {
        await api('api/scheduled/' + id, 'DELETE');
        loadScheduledData();
        showToast('Silindi', 'success');
    } catch (err) {
        showToast('Silme hatasi: ' + err.message, 'error');
    }
}

async function deleteWebhook(id) {
    if (!confirm('Silmek istediginize emin misiniz?')) return;
    try {
        await api('api/webhooks/' + id, 'DELETE');
        loadWebhooksData();
        showToast('Silindi', 'success');
    } catch (err) {
        showToast('Silme hatasi: ' + err.message, 'error');
    }
}

function editScript(id) {
    closeModal();
    showScriptEditor(id);
}

async function toggleScript(id) {
    await api('api/scripts/' + id + '/toggle', 'POST');
    loadScriptsData();
}

async function deleteScript(id) {
    if (!confirm('Scripti silmek istediginize emin misiniz?')) return;
    try {
        await api('api/scripts/' + id, 'DELETE');
        loadScriptsData();
        showToast('Script silindi', 'success');
    } catch (err) {
        showToast('Silme hatasi: ' + err.message, 'error');
    }
}

// Logout
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

function sanitizeUrl(url) {
    if (!url) return '';
    const trimmed = url.trim().toLowerCase();
    if (trimmed.startsWith('javascript:') || trimmed.startsWith('data:') || trimmed.startsWith('vbscript:')) {
        return '';
    }
    if (trimmed.startsWith('//')) {
        return '';
    }
    if (trimmed.startsWith('http://') || trimmed.startsWith('https://') ||
        trimmed.startsWith('/') || trimmed.startsWith('api/') || /^[a-z0-9]/.test(trimmed)) {
        return escapeHtml(url);
    }
    return '';
}

function formatSenderName(name) {
    if (!name) return '';
    if (/^\d{10,15}$/.test(name)) {
        return '+' + name.substring(0, 2) + ' xxx ' + name.slice(-4);
    }
    return name;
}

function formatTime(ts) {
    if (!ts) return '';
    const date = new Date(ts);
    const now = new Date();
    const isToday = date.toDateString() === now.toDateString();

    if (isToday) {
        return date.toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' });
    }
    return date.toLocaleDateString('tr-TR', { day: '2-digit', month: '2-digit' });
}

function formatDateTime(ts) {
    if (!ts) return '';
    return new Date(ts).toLocaleString('tr-TR');
}

function showToast(message, type) {
    type = type || 'info';
    const container = document.getElementById('toastContainer');
    if (!container) return;

    const toast = document.createElement('div');
    toast.className = 'toast ' + type;
    toast.innerHTML = '<span>' + escapeHtml(message) + '</span>';
    container.appendChild(toast);

    setTimeout(() => toast.remove(), 4000);
}
