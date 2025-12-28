/**
 * WhatsApp Premium Plus - Frontend App
 * Modern WhatsApp-like interface with premium features
 */

let socket;
let currentChat = null;
let chats = [];
let monacoEditor = null;
let editingScriptId = null;
let accounts = [];
let roles = [];
let users = [];
let activeAccountId = localStorage.getItem('activeAccountId');
let webhooksCache = [];
let availableTags = [];
let currentChatTags = [];
let currentChatNotes = [];
let settings = {
    downloadMedia: true,
    syncOnConnect: true,
    uploadToDrive: false,
    notifications: true,
    sounds: true
};
let uiPreferences = {
    accentColor: localStorage.getItem('uiAccent') || '',
    wallpaper: localStorage.getItem('uiWallpaper') || 'default'
};
let selectedAttachment = null;
const MESSAGE_PAGE_SIZE = 50;
const CHAT_MESSAGE_PAGE_SIZE = 50;
const CHAT_SEARCH_PAGE_SIZE = 50;
const VIRTUAL_MESSAGE_ITEM_HEIGHT = 78;
const VIRTUAL_MESSAGE_OVERSCAN = 6;

let messagesPagination = {
    items: [],
    offset: 0,
    hasMore: true,
    loading: false
};
let chatMessagesPagination = {
    chatId: null,
    items: [],
    offset: 0,
    hasMore: true,
    loading: false
};
let chatSearchDebounce = null;

// Initialize
document.addEventListener('DOMContentLoaded', () => {
    loadTheme();
    loadCustomizations();
    initMonaco();
    setupAttachmentPicker();
    setupMessagesListScroll();
    setupChatMessagesScroll();
    initializeApp();

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

async function initializeApp() {
    try {
        await loadAccounts();
        initSocket();
        loadInitialData();
    } catch (error) {
        console.error('App init error:', error);
        showToast('Hesaplar yuklenemedi: ' + error.message, 'error');
    }
}

// Customization Management
function loadCustomizations() {
    if (!uiPreferences.accentColor) {
        const accent = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim();
        uiPreferences.accentColor = accent || '#00a884';
    }
    if (uiPreferences.accentColor) {
        applyAccentColor(uiPreferences.accentColor);
    }
    applyWallpaper(uiPreferences.wallpaper);
    updateCustomizationUI();
}

function updateCustomizationUI() {
    const accentInput = document.getElementById('accentColorPicker');
    if (accentInput && uiPreferences.accentColor) {
        accentInput.value = uiPreferences.accentColor;
    }
    const wallpaperSelect = document.getElementById('wallpaperSelect');
    if (wallpaperSelect) {
        wallpaperSelect.value = uiPreferences.wallpaper;
    }
}

function updateAccentColor(color) {
    uiPreferences.accentColor = color;
    localStorage.setItem('uiAccent', color);
    applyAccentColor(color);
}

function updateWallpaperChoice(value) {
    uiPreferences.wallpaper = value;
    localStorage.setItem('uiWallpaper', value);
    applyWallpaper(value);
}

function applyAccentColor(color) {
    if (!color) return;
    const root = document.documentElement;
    root.style.setProperty('--accent', color);
    root.style.setProperty('--accent-hover', adjustColor(color, -20));
    root.style.setProperty('--accent-light', adjustColor(color, 50));
}

function applyWallpaper(value) {
    const root = document.documentElement;
    const wallpaperKey = value || 'default';
    root.style.setProperty('--chat-wallpaper', `var(--wallpaper-${wallpaperKey})`);
}

function adjustColor(hex, amount) {
    const value = hex.replace('#', '');
    if (value.length !== 6) return hex;
    const num = parseInt(value, 16);
    const r = Math.min(255, Math.max(0, (num >> 16) + amount));
    const g = Math.min(255, Math.max(0, ((num >> 8) & 0x00ff) + amount));
    const b = Math.min(255, Math.max(0, (num & 0x0000ff) + amount));
    return `#${(r << 16 | g << 8 | b).toString(16).padStart(6, '0')}`;
}

// Accounts Management
async function loadAccounts() {
    const data = await api('api/accounts');
    accounts = data.accounts || [];
    const currentAccountId = data.currentAccountId;

    if (!activeAccountId || !accounts.find(account => account.id === activeAccountId)) {
        activeAccountId = currentAccountId || accounts[0]?.id || null;
        if (activeAccountId) {
            localStorage.setItem('activeAccountId', activeAccountId);
        }
    }

    if (activeAccountId && activeAccountId !== currentAccountId) {
        await api('api/accounts/select', 'POST', { accountId: activeAccountId });
    }

    renderAccountMenu();
    updateAccountHeader();
}

function renderAccountMenu() {
    const menu = document.getElementById('accountMenuList');
    if (!menu) return;
    menu.innerHTML = '';

    accounts.forEach(account => {
        const item = document.createElement('div');
        item.className = 'dropdown-item account-item' + (account.id === activeAccountId ? ' active' : '');
        item.onclick = () => selectAccount(account.id);
        item.innerHTML = `
            <span class="account-label">${escapeHtml(account.name)}</span>
            <span class="account-status ${escapeHtml(account.status || 'disconnected')}">${escapeHtml(account.status || 'disconnected')}</span>
        `;
        menu.appendChild(item);
    });
}

function updateAccountHeader() {
    const current = accounts.find(account => account.id === activeAccountId);
    const accountName = document.getElementById('accountName');
    if (accountName) {
        accountName.textContent = current ? current.name : 'Hesap Secin';
    }
}

async function selectAccount(accountId) {
    if (!accountId || accountId === activeAccountId) return;
    try {
        await api('api/accounts/select', 'POST', { accountId });
        activeAccountId = accountId;
        localStorage.setItem('activeAccountId', accountId);
        updateAccountHeader();
        renderAccountMenu();
        resetAppState();
        resetSocket();
        loadInitialData();
        showToast('Hesap degistirildi', 'success');
    } catch (error) {
        showToast('Hesap degistirilemedi: ' + error.message, 'error');
    }
}

async function createAccount() {
    const name = prompt('Yeni hesap adi girin:');
    if (!name) return;
    try {
        const result = await api('api/accounts', 'POST', { name: name.trim() });
        accounts.push(result.account);
        renderAccountMenu();
        showToast('Hesap olusturuldu', 'success');
    } catch (error) {
        showToast('Hesap olusturulamadi: ' + error.message, 'error');
    }
}

function resetAppState() {
    currentChat = null;
    chats = [];
    messagesPagination = {
        items: [],
        offset: 0,
        hasMore: true,
        loading: false
    };
    chatMessagesPagination = {
        chatId: null,
        items: [],
        offset: 0,
        hasMore: true,
        loading: false
    };
    document.getElementById('chatList').innerHTML = '';
    document.getElementById('messagesList').innerHTML = '';
    document.getElementById('logsList').innerHTML = '';
    closeChat();
}

function resetSocket() {
    if (socket) {
        socket.disconnect();
        socket = null;
    }
    initSocket();
}

// Socket.IO
function initSocket() {
    const basePath = window.location.pathname.endsWith('/') ? window.location.pathname : window.location.pathname + '/';
    socket = io({ path: basePath + 'socket.io/', auth: { accountId: activeAccountId } });

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
function getCsrfToken() {
    const match = document.cookie.match(/(?:^|; )XSRF-TOKEN=([^;]+)/);
    return match ? decodeURIComponent(match[1]) : null;
}

async function api(url, method, body) {
    method = method || 'GET';
    const headers = { 'Content-Type': 'application/json' };
    if (activeAccountId) {
        headers['X-Account-Id'] = activeAccountId;
    }
    if (!['GET', 'HEAD'].includes(method.toUpperCase())) {
        const csrfToken = getCsrfToken();
        if (csrfToken) {
            headers['X-CSRF-Token'] = csrfToken;
        }
    }
    const options = {
        method: method,
        headers: headers,
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
    if (tab === 'chats') {
        loadChats();
    } else if (tab === 'messages') {
        if (!messagesPagination.items.length) {
            loadMessagesPage({ reset: true });
        } else {
            renderMessagesList();
        }
    } else if (tab === 'logs') {
        loadLogs();
    }
}

function showTab(tabName) {
    closeAllPanels();
    showModal(tabName);
}

function openReports() {
    window.location.href = '/reports.html';
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

    if (activeAccountId) {
        const account = accounts.find(a => a.id === activeAccountId);
        if (account) {
            account.status = status.status;
            renderAccountMenu();
        }
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
        loadTags();
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
    await loadMessagesPage({ reset: true });
}

async function loadChatMessages(chatId, options = {}) {
    const shouldReset = options.reset !== false || chatMessagesPagination.chatId !== chatId;
    if (shouldReset) {
        chatMessagesPagination = {
            chatId,
            items: [],
            offset: 0,
            hasMore: true,
            loading: false
        };
    }

    if (chatMessagesPagination.loading || !chatMessagesPagination.hasMore) return;
    chatMessagesPagination.loading = true;
    setListStatus('chatMessagesStatus', shouldReset ? 'Mesajlar yukleniyor...' : 'Daha fazla mesaj yukleniyor...', true);

    try {
        const response = await api('api/chats/' + encodeURIComponent(chatId) +
            '/messages?limit=' + CHAT_MESSAGE_PAGE_SIZE +
            '&offset=' + chatMessagesPagination.offset);
        const payload = Array.isArray(response) ? { messages: response } : response;
        const page = Array.isArray(payload.messages) ? payload.messages : [];
        chatMessagesPagination.items = chatMessagesPagination.items.concat(page);
        chatMessagesPagination.offset += page.length;
        chatMessagesPagination.hasMore = page.length === CHAT_MESSAGE_PAGE_SIZE;
        if (shouldReset) {
            currentChatTags = Array.isArray(payload.tags) ? payload.tags : [];
            currentChatNotes = Array.isArray(payload.notes) ? payload.notes : [];
            renderChatMeta();
        }
        renderChatMessages(chatMessagesPagination.items, {
            preserveScroll: !shouldReset,
            scrollToBottom: shouldReset
        });
    } catch (err) {
        console.error('Chat messages load error:', err);
    } finally {
        chatMessagesPagination.loading = false;
        setListStatus('chatMessagesStatus', '', false);
    }
}

async function loadTags() {
    try {
        const tags = await api('api/tags');
        availableTags = Array.isArray(tags) ? tags : [];
        renderTagFilterOptions();
        renderTagDatalist();
    } catch (err) {
        console.error('Tags load error:', err);
    }
}

function renderTagFilterOptions() {
    const select = document.getElementById('tagFilter');
    if (!select) return;
    const current = select.value;
    select.innerHTML = '<option value="">Tum Etiketler</option>' +
        availableTags.map(tag => '<option value="' + tag.id + '">' + escapeHtml(tag.name) + '</option>').join('');
    if (current) {
        select.value = current;
    }
}

function renderTagDatalist() {
    const datalist = document.getElementById('tagNameOptions');
    if (!datalist) return;
    datalist.innerHTML = availableTags.map(tag => '<option value="' + escapeHtml(tag.name) + '"></option>').join('');
}

function renderChatMeta() {
    renderChatTags();
    renderChatNotes();
}

function renderChatTags() {
    const container = document.getElementById('chatTagsList');
    if (!container) return;
    if (!currentChatTags.length) {
        container.innerHTML = '<span class="text-muted">Etiket yok</span>';
        return;
    }
    container.innerHTML = currentChatTags.map(tag => {
        const bg = tag.color || 'var(--accent)';
        return '<span class="tag-chip" style="background-color: ' + escapeHtml(bg) + ';">' +
            '<span>' + escapeHtml(tag.name) + '</span>' +
            '<button type="button" onclick="removeTagFromChat(' + tag.id + ')"><i class="bi bi-x"></i></button>' +
            '</span>';
    }).join('');
}

function renderChatNotes() {
    const container = document.getElementById('chatNotesList');
    if (!container) return;
    if (!currentChatNotes.length) {
        container.innerHTML = '<span class="text-muted">Not yok</span>';
        return;
    }
    container.innerHTML = currentChatNotes.map(note => {
        return '<div class="note-item">' +
            '<div class="note-text">' + escapeHtml(note.content || '') + '</div>' +
            '<div class="note-meta">' +
                '<span>' + escapeHtml(formatTime(note.created_at || Date.now())) + '</span>' +
                '<span>' +
                    '<button class="icon-btn" onclick="editNote(' + note.id + ')"><i class="bi bi-pencil"></i></button>' +
                    '<button class="icon-btn" onclick="deleteNote(' + note.id + ')"><i class="bi bi-trash"></i></button>' +
                '</span>' +
            '</div>' +
        '</div>';
    }).join('');
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

function setListStatus(id, message, showSpinner) {
    const el = document.getElementById(id);
    if (!el) return;
    if (!message) {
        el.classList.remove('active');
        el.innerHTML = '';
        return;
    }
    const spinnerHtml = showSpinner ? '<span class="spinner"></span>' : '';
    el.innerHTML = spinnerHtml + '<span>' + escapeHtml(message) + '</span>';
    el.classList.add('active');
}

async function loadMessagesPage(options = {}) {
    const shouldReset = options.reset === true;
    if (shouldReset) {
        messagesPagination = {
            items: [],
            offset: 0,
            hasMore: true,
            loading: false
        };
        const container = document.getElementById('messagesList');
        if (container) container.scrollTop = 0;
    }

    if (messagesPagination.loading || !messagesPagination.hasMore) return;
    messagesPagination.loading = true;
    setListStatus('messagesListStatus', shouldReset ? 'Mesajlar yukleniyor...' : 'Daha fazla mesaj yukleniyor...', true);

    try {
        const response = await api('api/messages?limit=' + MESSAGE_PAGE_SIZE + '&offset=' + messagesPagination.offset);
        const payload = Array.isArray(response) ? { messages: response } : response;
        const page = Array.isArray(payload.messages) ? payload.messages : [];
        messagesPagination.items = messagesPagination.items.concat(page);
        messagesPagination.offset += page.length;
        messagesPagination.hasMore = page.length === MESSAGE_PAGE_SIZE;
        renderMessagesList();
    } catch (err) {
        console.error('Messages load error:', err);
    } finally {
        messagesPagination.loading = false;
        setListStatus('messagesListStatus', '', false);
    }
}

function setupMessagesListScroll() {
    const container = document.getElementById('messagesList');
    if (!container || container.dataset.scrollBound) return;
    container.dataset.scrollBound = 'true';
    container.addEventListener('scroll', () => {
        renderMessagesList();
        if (container.scrollTop + container.clientHeight >= container.scrollHeight - 120) {
            loadMessagesPage();
        }
    });
    window.addEventListener('resize', () => {
        if (container.style.display !== 'none') {
            renderMessagesList();
        }
    });
}

function setupChatMessagesScroll() {
    const container = document.getElementById('messagesContainer');
    if (!container || container.dataset.scrollBound) return;
    container.dataset.scrollBound = 'true';
    container.addEventListener('scroll', () => {
        if (!currentChat) return;
        if (container.scrollTop <= 120) {
            loadChatMessages(currentChat, { reset: false });
        }
    });
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

    if (messagesPagination.items.length === 0) {
        container.classList.remove('virtualized-list');
        container.innerHTML = '<div class="chat-item"><div class="chat-info"><div class="chat-name" style="color: var(--text-secondary)">Henuz mesaj yok</div></div></div>';
        return;
    }

    if (!container.classList.contains('virtualized-list')) {
        container.classList.add('virtualized-list');
        container.innerHTML = '<div class="virtual-spacer"></div><div class="virtual-items"></div>';
    }

    const spacer = container.querySelector('.virtual-spacer');
    const itemsWrapper = container.querySelector('.virtual-items');
    const total = messagesPagination.items.length;
    const scrollTop = container.scrollTop;
    const viewportHeight = container.clientHeight;
    const startIndex = Math.max(Math.floor(scrollTop / VIRTUAL_MESSAGE_ITEM_HEIGHT) - VIRTUAL_MESSAGE_OVERSCAN, 0);
    const endIndex = Math.min(Math.ceil((scrollTop + viewportHeight) / VIRTUAL_MESSAGE_ITEM_HEIGHT) + VIRTUAL_MESSAGE_OVERSCAN, total);

    spacer.style.height = (total * VIRTUAL_MESSAGE_ITEM_HEIGHT) + 'px';
    itemsWrapper.style.transform = 'translateY(' + (startIndex * VIRTUAL_MESSAGE_ITEM_HEIGHT) + 'px)';
    itemsWrapper.innerHTML = messagesPagination.items.slice(startIndex, endIndex).map(renderMessageListItem).join('');
}

function renderMessageListItem(message) {
    const isMine = message.is_from_me === 1 || message.is_from_me === true;
    const direction = isMine ? '<i class="bi bi-arrow-up-right" style="color: var(--accent)"></i>' : '<i class="bi bi-arrow-down-left" style="color: #34b7f1"></i>';
    const displayName = getDisplayNameFromMessage(message);

    return '<div class="chat-item" onclick="openChatForMessage(\'' + (message.chat_id || '') + '\')">' +
        '<div class="avatar"><i class="bi bi-chat-text-fill"></i></div>' +
        '<div class="chat-info">' +
            '<div class="top-row">' +
                '<div class="chat-name">' + direction + ' ' + escapeHtml(formatSenderName(displayName)) + '</div>' +
                '<span class="chat-time">' + formatTime(message.timestamp) + '</span>' +
            '</div>' +
            '<div class="chat-preview">' +
                '<span class="preview-text">' + escapeHtml((message.body || '[Medya]').substring(0, 50)) + '</span>' +
            '</div>' +
        '</div>' +
    '</div>';
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

function renderChatMessages(messages, options = {}) {
    const container = document.getElementById('messagesContainer');
    if (!container) return;

    const previousScrollHeight = container.scrollHeight;
    const previousScrollTop = container.scrollTop;

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
        } else if (!mediaHtml) {
            textHtml = '<div class="message-text muted">[Bos mesaj]</div>';
        }

        const displayName = getDisplayNameFromMessage(m);
        const senderHtml = (!isMine && displayName) ?
            '<div class="sender-name">' + escapeHtml(formatSenderName(displayName)) + '</div>' : '';

        const checkIcon = isMine ? '<i class="bi bi-check2-all check-icon read"></i>' : '';

        return '<div class="message-row ' + (isMine ? 'sent' : 'received') + '">' +
            '<div class="message-bubble ' + (isMine ? 'sent' : 'received') + '">' +
            senderHtml +
            mediaHtml +
            textHtml +
            '<div class="message-footer"><span class="message-time">' + formatTime(m.timestamp) + '</span>' + checkIcon + '</div>' +
            '</div></div>';
    }).join('');

    if (options.preserveScroll) {
        const newScrollHeight = container.scrollHeight;
        container.scrollTop = newScrollHeight - previousScrollHeight + previousScrollTop;
        return;
    }

    if (options.scrollToBottom !== false) {
        setTimeout(() => {
            container.scrollTop = container.scrollHeight;
        }, 100);
    }
}

// Chat Selection
function selectChat(chatId, name) {
    currentChat = chatId;
    currentChatTags = [];
    currentChatNotes = [];
    renderChatMeta();

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
    const query = document.getElementById('searchInput').value.trim();
    const tagFilter = document.getElementById('tagFilter')?.value || '';
    const noteQuery = document.getElementById('noteSearchInput')?.value.trim() || '';
    if (chatSearchDebounce) {
        clearTimeout(chatSearchDebounce);
    }
    chatSearchDebounce = setTimeout(() => {
        performChatSearch(query, tagFilter, noteQuery);
    }, 300);
}

async function performChatSearch(query, tagFilter, noteQuery) {
    if (!query && !tagFilter && !noteQuery) {
        renderChatList(chats);
        return;
    }

    try {
        const params = new URLSearchParams();
        if (query) params.set('q', query);
        if (tagFilter) params.set('tag', tagFilter);
        if (noteQuery) params.set('note', noteQuery);
        params.set('limit', CHAT_SEARCH_PAGE_SIZE);
        const results = await api('api/chats/search?' + params.toString());
        renderChatList(results);
    } catch (err) {
        console.error('Chat search error:', err);
    }
}

// Send Message
async function sendMessage() {
    const input = document.getElementById('messageInput');
    const message = input.value.trim();

    if (!currentChat || (!message && !selectedAttachment)) return;

    input.value = '';
    autoResizeInput(input);

    // Add temporary message
    appendTempMessage(message, selectedAttachment ? selectedAttachment.name : null);

    try {
        if (selectedAttachment) {
            await sendMessageWithAttachment(message, selectedAttachment);
            clearAttachment();
        } else {
            await api('api/send', 'POST', { chatId: currentChat, message });
        }
        // Socket event will refresh
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

function appendTempMessage(text, attachmentName) {
    const container = document.getElementById('messagesContainer');
    if (!container) return;

    const attachmentHtml = attachmentName
        ? '<div class="message-text">[Dosya] ' + escapeHtml(attachmentName) + '</div>'
        : '';
    const bodyHtml = text ? '<div class="message-text">' + escapeHtml(text) + '</div>' : '';

    const messageHtml = '<div class="message-row sent">' +
        '<div class="message-bubble sent">' +
        attachmentHtml +
        bodyHtml +
        '<div class="message-footer"><span class="message-time">' + formatTime(Date.now()) + '</span><i class="bi bi-check2 check-icon"></i></div>' +
        '</div></div>';

    container.insertAdjacentHTML('beforeend', messageHtml);
    container.scrollTop = container.scrollHeight;
}

async function addTagToChat() {
    if (!currentChat) return;
    const nameInput = document.getElementById('tagNameInput');
    const colorInput = document.getElementById('tagColorInput');
    if (!nameInput) return;
    const name = nameInput.value.trim();
    if (!name) return;

    try {
        let tag = availableTags.find(item => item.name.toLowerCase() === name.toLowerCase());
        if (!tag) {
            const response = await api('api/tags', 'POST', { name, color: colorInput?.value || null });
            const tagId = response.id || response.tag?.id;
            await loadTags();
            tag = availableTags.find(item => item.id === tagId) || { id: tagId, name, color: colorInput?.value || null };
        }
        await api('api/chats/' + encodeURIComponent(currentChat) + '/tags', 'POST', { tag_id: tag.id });
        nameInput.value = '';
        await refreshChatTags();
    } catch (err) {
        showToast('Etiket eklenemedi: ' + err.message, 'error');
    }
}

async function removeTagFromChat(tagId) {
    if (!currentChat) return;
    try {
        await api('api/chats/' + encodeURIComponent(currentChat) + '/tags/' + tagId, 'DELETE');
        await refreshChatTags();
    } catch (err) {
        showToast('Etiket kaldirilamadi: ' + err.message, 'error');
    }
}

async function refreshChatTags() {
    if (!currentChat) return;
    try {
        const tags = await api('api/chats/' + encodeURIComponent(currentChat) + '/tags');
        currentChatTags = Array.isArray(tags) ? tags : [];
        renderChatTags();
        renderTagFilterOptions();
    } catch (err) {
        console.error('Chat tags load error:', err);
    }
}

async function addNoteToChat() {
    if (!currentChat) return;
    const input = document.getElementById('noteInput');
    if (!input) return;
    const content = input.value.trim();
    if (!content) return;

    try {
        await api('api/chats/' + encodeURIComponent(currentChat) + '/notes', 'POST', { content });
        input.value = '';
        await refreshChatNotes();
    } catch (err) {
        showToast('Not eklenemedi: ' + err.message, 'error');
    }
}

async function editNote(noteId) {
    if (!currentChat) return;
    const note = currentChatNotes.find(item => item.id === noteId);
    if (!note) return;
    const updated = prompt('Notu duzenleyin:', note.content || '');
    if (updated === null) return;
    const content = updated.trim();
    if (!content) return;

    try {
        await api('api/chats/' + encodeURIComponent(currentChat) + '/notes/' + noteId, 'PUT', { content });
        await refreshChatNotes();
    } catch (err) {
        showToast('Not guncellenemedi: ' + err.message, 'error');
    }
}

async function deleteNote(noteId) {
    if (!currentChat) return;
    try {
        await api('api/chats/' + encodeURIComponent(currentChat) + '/notes/' + noteId, 'DELETE');
        await refreshChatNotes();
    } catch (err) {
        showToast('Not silinemedi: ' + err.message, 'error');
    }
}

async function refreshChatNotes() {
    if (!currentChat) return;
    try {
        const notes = await api('api/chats/' + encodeURIComponent(currentChat) + '/notes');
        currentChatNotes = Array.isArray(notes) ? notes : [];
        renderChatNotes();
    } catch (err) {
        console.error('Chat notes load error:', err);
    }
}

// Handle new incoming message
function handleNewMessage(msg) {
    console.log('New message received:', msg, 'currentChat:', currentChat, 'msg.chatId:', msg.chatId);

    if (settings.notifications) {
        const displayName = getDisplayNameFromMessage(msg);
        showToast('Yeni mesaj: ' + formatSenderName(displayName), 'info');
    }

    const incomingChatId = msg.chatId || msg.chat_id;
    if (currentChat && incomingChatId && currentChat === incomingChatId) {
        const normalized = {
            chat_id: incomingChatId,
            is_from_me: msg.isFromMe ?? msg.is_from_me ?? 0,
            timestamp: msg.timestamp || Date.now(),
            body: msg.body || msg.message || '',
            from_name: msg.fromName || msg.from_name,
            from_number: msg.fromNumber || msg.from_number,
            type: msg.type,
            media_url: msg.mediaUrl || msg.media_url,
            media_mimetype: msg.mediaMimeType || msg.media_mimetype
        };
        chatMessagesPagination.items.push(normalized);
        renderChatMessages(chatMessagesPagination.items, { scrollToBottom: true });
    }

    loadChats();
    if (messagesPagination.items.length) {
        messagesPagination.items.unshift({
            chat_id: incomingChatId || '',
            is_from_me: msg.isFromMe ?? msg.is_from_me ?? 0,
            timestamp: msg.timestamp || Date.now(),
            body: msg.body || msg.message || '',
            from_name: msg.fromName || msg.from_name,
            from_number: msg.fromNumber || msg.from_number
        });
        renderMessagesList();
    }
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
    } else if (!mediaHtml) {
        textHtml = '<div class="message-text muted">[Bos mesaj]</div>';
    }

    const displayName = getDisplayNameFromMessage(msg);
    const senderHtml = (!isMine && displayName) ?
        '<div class="sender-name">' + escapeHtml(formatSenderName(displayName)) + '</div>' : '';

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
    const input = document.getElementById('mediaInput');
    if (input) {
        input.click();
    }
}

function setupAttachmentPicker() {
    const input = document.getElementById('mediaInput');
    if (!input) return;
    input.addEventListener('change', handleMediaSelect);
}

function handleMediaSelect(event) {
    const file = event.target.files && event.target.files[0];
    if (!file) return;
    selectedAttachment = file;
    renderAttachmentPreview();
}

function renderAttachmentPreview() {
    const preview = document.getElementById('attachmentPreview');
    if (!preview) return;
    if (!selectedAttachment) {
        preview.style.display = 'none';
        preview.innerHTML = '';
        return;
    }
    preview.style.display = 'flex';
    preview.innerHTML = `
        <div class="attachment-chip">
            <i class="bi bi-paperclip"></i>
            <span>${escapeHtml(selectedAttachment.name)}</span>
            <button class="icon-btn" onclick="clearAttachment()" title="Kaldir">
                <i class="bi bi-x"></i>
            </button>
        </div>
    `;
}

function clearAttachment() {
    selectedAttachment = null;
    const input = document.getElementById('mediaInput');
    if (input) {
        input.value = '';
    }
    renderAttachmentPreview();
}

async function sendMessageWithAttachment(message, file) {
    const formData = new FormData();
    formData.append('chatId', currentChat);
    formData.append('message', message || '');
    formData.append('media', file);

    const headers = {};
    if (activeAccountId) {
        headers['X-Account-Id'] = activeAccountId;
    }
    const csrfToken = getCsrfToken();
    if (csrfToken) {
        headers['X-CSRF-Token'] = csrfToken;
    }

    const response = await fetch('api/send', {
        method: 'POST',
        headers,
        credentials: 'include',
        body: formData
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'API Error');
    return data;
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
        case 'users':
            title = 'Kullanicilar & Roller';
            content = getUsersContent();
            loadUsersData();
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

        webhooksCache = webhooks;

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
            '<button class="icon-btn" onclick="showWebhookDetails(' + w.id + ')" title="Teslim Gecmisi"><i class="bi bi-clock-history"></i></button>' +
            '<button class="icon-btn" onclick="deleteWebhook(' + w.id + ')" title="Sil"><i class="bi bi-trash" style="color: #f15c6d;"></i></button>' +
            '</div>'
        ).join('');
    } catch (err) {
        console.error('Webhooks load error:', err);
    }
}

function showWebhookDetails(webhookId) {
    const webhook = webhooksCache.find(item => item.id === webhookId);
    const modal = document.createElement('div');
    modal.className = 'modal-overlay show';
    modal.onclick = (e) => { if (e.target === modal) modal.remove(); };

    modal.innerHTML = '<div class="modal" style="max-width: 900px;">' +
        '<div class="modal-header"><h3>' + escapeHtml(webhook?.name || 'Webhook') + '</h3><i class="bi bi-x-lg close-btn" onclick="this.closest(\'.modal-overlay\').remove()"></i></div>' +
        '<div class="modal-body">' +
            '<div style="margin-bottom: 16px;">' +
                '<div><strong>URL:</strong> ' + escapeHtml(webhook?.url || '-') + '</div>' +
                '<div><strong>Olaylar:</strong> ' + escapeHtml(webhook?.events || '-') + '</div>' +
            '</div>' +
            '<div id="webhookDeliveriesContainer">' +
                '<p style="color: var(--text-secondary)">Teslim gecmisi yukleniyor...</p>' +
            '</div>' +
        '</div>' +
        '</div>';

    document.body.appendChild(modal);
    loadWebhookDeliveries(webhookId);
}

async function loadWebhookDeliveries(webhookId) {
    const container = document.getElementById('webhookDeliveriesContainer');
    if (!container) return;

    try {
        const deliveries = await api('api/webhooks/' + webhookId + '/deliveries?limit=50');
        if (!deliveries.length) {
            container.innerHTML = '<p style="color: var(--text-secondary)">Teslim kaydi bulunamadi.</p>';
            return;
        }

        const rows = deliveries.map(delivery => {
            const statusText = delivery.status ? delivery.status : '-';
            const durationText = delivery.duration ? delivery.duration + ' ms' : '-';
            const errorText = delivery.error ? escapeHtml(delivery.error) : '-';
            return '<tr>' +
                '<td>' + formatDateTime(delivery.created_at) + '</td>' +
                '<td>' + escapeHtml(delivery.event) + '</td>' +
                '<td>' + statusText + '</td>' +
                '<td>' + durationText + '</td>' +
                '<td>' + delivery.attempts + '</td>' +
                '<td>' + errorText + '</td>' +
                '<td><button class="btn btn-secondary btn-sm" onclick="replayWebhookDelivery(' + delivery.id + ',' + webhookId + ')">Yeniden Dene</button></td>' +
            '</tr>';
        }).join('');

        container.innerHTML = '<div style="overflow-x: auto;">' +
            '<table class="deliveries-table">' +
                '<thead>' +
                    '<tr>' +
                        '<th>Tarih</th>' +
                        '<th>Olay</th>' +
                        '<th>Durum</th>' +
                        '<th>Sure</th>' +
                        '<th>Deneme</th>' +
                        '<th>Hata</th>' +
                        '<th>Aksiyon</th>' +
                    '</tr>' +
                '</thead>' +
                '<tbody>' + rows + '</tbody>' +
            '</table>' +
        '</div>';
    } catch (err) {
        container.innerHTML = '<p style="color: var(--text-secondary)">Teslim gecmisi yuklenemedi.</p>';
    }
}

async function replayWebhookDelivery(deliveryId, webhookId) {
    if (!confirm('Bu teslimati yeniden denemek istiyor musunuz?')) return;
    try {
        await api('api/webhooks/deliveries/' + deliveryId + '/replay', 'POST');
        showToast('Teslimat yeniden denendi', 'success');
        loadWebhookDeliveries(webhookId);
    } catch (err) {
        showToast('Tekrar deneme hatasi: ' + err.message, 'error');
    }
}

// Users & Roles Content
function getUsersContent() {
    return '<div class="form-card">' +
        '<h4>Rol Ekle</h4>' +
        '<form id="roleFormModal" onsubmit="submitRole(event)">' +
            '<div class="form-group"><label class="form-label">Rol Adi</label><input type="text" class="form-input" id="roleNameModal" placeholder="admin" required></div>' +
            '<div class="form-group"><label class="form-label">Aciklama</label><input type="text" class="form-input" id="roleDescModal" placeholder="Yetki aciklamasi"></div>' +
            '<button type="submit" class="btn btn-primary">Rol Ekle</button>' +
        '</form>' +
        '<div id="rolesListModal" class="list-grid"></div>' +
    '</div>' +
    '<div class="form-card">' +
        '<h4>Kullanici Ekle</h4>' +
        '<form id="userFormModal" onsubmit="submitUser(event)">' +
            '<div class="form-group"><label class="form-label">Kullanici Adi</label><input type="text" class="form-input" id="userNameModal" placeholder="kullanici" required></div>' +
            '<div class="form-group"><label class="form-label">Gorunen Isim</label><input type="text" class="form-input" id="userDisplayModal" placeholder="Ad Soyad"></div>' +
            '<div class="form-group"><label class="form-label">Sifre</label><input type="password" class="form-input" id="userPasswordModal" required></div>' +
            '<div class="form-group"><label class="form-label">Rol</label><select class="form-input" id="userRoleModal"></select></div>' +
            '<button type="submit" class="btn btn-primary">Kullanici Ekle</button>' +
        '</form>' +
        '<div id="usersListModal" class="list-grid"></div>' +
    '</div>';
}

async function loadUsersData() {
    try {
        roles = await api('api/roles');
        users = await api('api/users');
        renderRolesList();
        renderUsersList();
        populateRoleSelect();
    } catch (err) {
        console.error('Users load error:', err);
        showToast('Yetki bilgileri yuklenemedi: ' + err.message, 'error');
    }
}

function populateRoleSelect() {
    const select = document.getElementById('userRoleModal');
    if (!select) return;
    select.innerHTML = roles.map(role => (
        '<option value="' + role.id + '">' + escapeHtml(role.name) + '</option>'
    )).join('');
}

function renderRolesList() {
    const container = document.getElementById('rolesListModal');
    if (!container) return;
    if (!roles.length) {
        container.innerHTML = '<p style="color: var(--text-secondary)">Rol bulunamadi</p>';
        return;
    }
    container.innerHTML = roles.map(role =>
        '<div class="settings-item">' +
            '<div class="info" style="flex:1;">' +
                '<div class="title">' + escapeHtml(role.name) + '</div>' +
                '<div class="subtitle">' + escapeHtml(role.description || '') + '</div>' +
            '</div>' +
            '<button class="icon-btn" onclick="deleteRole(' + role.id + ')" title="Sil">' +
                '<i class="bi bi-trash" style="color: #f15c6d;"></i>' +
            '</button>' +
        '</div>'
    ).join('');
}

function renderUsersList() {
    const container = document.getElementById('usersListModal');
    if (!container) return;
    if (!users.length) {
        container.innerHTML = '<p style="color: var(--text-secondary)">Kullanici bulunamadi</p>';
        return;
    }
    container.innerHTML = users.map(user => {
        const roleOptions = roles.map(role =>
            '<option value="' + role.id + '"' + (role.name === user.role ? ' selected' : '') + '>' + escapeHtml(role.name) + '</option>'
        ).join('');
        return '<div class="settings-item">' +
            '<div class="info" style="flex:1;">' +
                '<div class="title">' + escapeHtml(user.display_name || user.username) + '</div>' +
                '<div class="subtitle">@' + escapeHtml(user.username) + '</div>' +
            '</div>' +
            '<select class="form-input role-select" onchange="assignUserRole(' + user.id + ', this.value)">' +
                roleOptions +
            '</select>' +
            '<button class="icon-btn" onclick="deleteUser(' + user.id + ')" title="Sil">' +
                '<i class="bi bi-trash" style="color: #f15c6d;"></i>' +
            '</button>' +
        '</div>';
    }).join('');
}

async function submitRole(event) {
    event.preventDefault();
    const name = document.getElementById('roleNameModal').value;
    const description = document.getElementById('roleDescModal').value;
    try {
        await api('api/roles', 'POST', { name, description });
        document.getElementById('roleFormModal').reset();
        await loadUsersData();
        showToast('Rol eklendi', 'success');
    } catch (err) {
        showToast('Hata: ' + err.message, 'error');
    }
}

async function deleteRole(roleId) {
    if (!confirm('Rol silinsin mi?')) return;
    try {
        await api('api/roles/' + roleId, 'DELETE');
        await loadUsersData();
        showToast('Rol silindi', 'success');
    } catch (err) {
        showToast('Hata: ' + err.message, 'error');
    }
}

async function submitUser(event) {
    event.preventDefault();
    const username = document.getElementById('userNameModal').value;
    const display_name = document.getElementById('userDisplayModal').value;
    const password = document.getElementById('userPasswordModal').value;
    const roleId = document.getElementById('userRoleModal').value;
    try {
        await api('api/users', 'POST', { username, display_name, password, roleId });
        document.getElementById('userFormModal').reset();
        await loadUsersData();
        showToast('Kullanici eklendi', 'success');
    } catch (err) {
        showToast('Hata: ' + err.message, 'error');
    }
}

async function assignUserRole(userId, roleId) {
    try {
        await api('api/users/' + userId + '/role', 'PUT', { roleId });
        await loadUsersData();
        showToast('Rol guncellendi', 'success');
    } catch (err) {
        showToast('Hata: ' + err.message, 'error');
    }
}

async function deleteUser(userId) {
    if (!confirm('Kullanici silinsin mi?')) return;
    try {
        await api('api/users/' + userId, 'DELETE');
        await loadUsersData();
        showToast('Kullanici silindi', 'success');
    } catch (err) {
        showToast('Hata: ' + err.message, 'error');
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
    const headers = {};
    const csrfToken = getCsrfToken();
    if (csrfToken) {
        headers['X-CSRF-Token'] = csrfToken;
    }
    await fetch('auth/logout', { method: 'POST', headers });
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
    if (name.includes('@')) {
        return name.split('@')[0];
    }
    if (/^\d{7,16}$/.test(name)) {
        return '+' + name;
    }
    return name;
}

function getDisplayNameFromMessage(message) {
    if (!message) return '';
    return message.from_name || message.fromName || message.from_number || message.fromNumber || message.from || '';
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
