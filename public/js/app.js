/**
 * WhatsApp Premium Plus - Frontend App
 * Modern WhatsApp-like interface with premium features
 */

/* global io, monaco */

let socket;
let currentChat = null;
let chats = [];
let monacoEditor = null;
let editingScriptId = null;
let templates = [];
let editingTemplateId = null;
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
    downloadProfilePictures: false,
    syncOnConnect: true,
    downloadMediaOnSync: true,
    uploadToDrive: false,
    notifications: true,
    sounds: true,
    ghostMode: false
};
let uiPreferences = {
    accentColor: '',
    wallpaper: 'default',
    fontSize: '14.2',
    compactMode: false,
    bubbleStyle: 'rounded',
    chatMetaCollapsed: false,
    appSurfaceOpacity: 100,
    desktopBackgroundType: 'default',
    desktopBackgroundImage: '',
    desktopBackgroundGradient: '',
    desktopBackgroundColor: '#f0f2f5',
    backgroundType: 'default',
    backgroundImage: '',
    backgroundGradient: '',
    backgroundColor: '#efeae2',
    backgroundOpacity: 100
};

const GRADIENT_PRESETS = {
    sunset: 'linear-gradient(135deg, #ff512f 0%, #dd2476 100%)',
    ocean: 'linear-gradient(135deg, #2193b0 0%, #6dd5ed 100%)',
    purple: 'linear-gradient(135deg, #8e2de2 0%, #4a00e0 100%)',
    forest: 'linear-gradient(135deg, #11998e 0%, #38ef7d 100%)',
    fire: 'linear-gradient(135deg, #f12711 0%, #f5af19 100%)',
    midnight: 'linear-gradient(135deg, #232526 0%, #414345 100%)'
};

let selectedAttachment = null;
let attachmentSendMode = 'media'; // 'media' | 'sticker'
let replyTarget = null; // { messageId, fromName, previewText }
const pendingOutgoing = new Map(); // tempId -> { tempId, chatId, body, timestamp, serverMessageId }
let chatAutoScrollSeq = 0;

// Sender profile pictures (for group message UI)
const senderProfilePicCache = new Map(); // contactId -> { url: string|null, fetchedAt: number }
const senderProfilePicPending = new Set(); // contactId currently fetching
const SENDER_PROFILE_PIC_TTL_MS = 6 * 60 * 60 * 1000;
const SENDER_PROFILE_PIC_NULL_TTL_MS = 5 * 60 * 1000;
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
    initEmojiPicker();
    updateStickerButtonUI();
    setupMessagesListScroll();
    setupChatMessagesScroll();
    initializeApp();

    // Close dropdowns when clicking outside
    document.addEventListener('click', (e) => {
        if (!e.target.closest('.dropdown')) {
            document.querySelectorAll('.dropdown-menu.show').forEach(m => m.classList.remove('show'));
        }
        if (!e.target.closest('#emojiPicker') && !e.target.closest('.emoji-btn')) {
            closeEmojiPicker();
        }
    });

    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
            closeEmojiPicker();
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
        // Load preferences from server first
        await fetchUserPreferences();
        await loadAccounts();
        initSocket();
        loadInitialData();
    } catch (error) {
        console.error('App init error:', error);
        showToast('Hesaplar yuklenemedi: ' + error.message, 'error');
    }
}

// Customization Management
async function fetchUserPreferences() {
    try {
        const response = await fetch('auth/check');
        const data = await response.json();
        if (data.preferences) {
            uiPreferences = { ...uiPreferences, ...data.preferences };
        } else {
            // Fallback to localStorage if no server prefs
            loadLocalPreferences();
        }
    } catch (e) {
        console.error('Failed to fetch preferences', e);
        loadLocalPreferences();
    }
    applyCustomizations();
}

function loadLocalPreferences() {
    uiPreferences.accentColor = localStorage.getItem('uiAccent') || uiPreferences.accentColor;
    uiPreferences.wallpaper = localStorage.getItem('uiWallpaper') || uiPreferences.wallpaper;
    uiPreferences.fontSize = localStorage.getItem('uiFontSize') || uiPreferences.fontSize;
    uiPreferences.compactMode = localStorage.getItem('uiCompactMode') === 'true';
    uiPreferences.bubbleStyle = localStorage.getItem('uiBubbleStyle') || uiPreferences.bubbleStyle;
    uiPreferences.chatMetaCollapsed = localStorage.getItem('uiChatMetaCollapsed') === 'true';

    // New fields
    uiPreferences.appSurfaceOpacity = localStorage.getItem('uiAppSurfaceOpacity') || uiPreferences.appSurfaceOpacity;
    uiPreferences.desktopBackgroundType = localStorage.getItem('uiDesktopBackgroundType') || uiPreferences.desktopBackgroundType;
    uiPreferences.desktopBackgroundImage = localStorage.getItem('uiDesktopBackgroundImage') || uiPreferences.desktopBackgroundImage;
    uiPreferences.desktopBackgroundGradient = localStorage.getItem('uiDesktopBackgroundGradient') || uiPreferences.desktopBackgroundGradient;
    uiPreferences.desktopBackgroundColor = localStorage.getItem('uiDesktopBackgroundColor') || uiPreferences.desktopBackgroundColor;

    uiPreferences.backgroundType = localStorage.getItem('uiBackgroundType') || uiPreferences.backgroundType;
    uiPreferences.backgroundImage = localStorage.getItem('uiBackgroundImage') || uiPreferences.backgroundImage;
    uiPreferences.backgroundGradient = localStorage.getItem('uiBackgroundGradient') || uiPreferences.backgroundGradient;
    uiPreferences.backgroundColor = localStorage.getItem('uiBackgroundColor') || uiPreferences.backgroundColor;
    uiPreferences.backgroundOpacity = localStorage.getItem('uiBackgroundOpacity') || uiPreferences.backgroundOpacity;
}

function loadCustomizations() {
    // Deprecated, logic moved to fetchUserPreferences
    if (!uiPreferences.accentColor) {
        const accent = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim();
        uiPreferences.accentColor = accent || '#00a884';
    }
    applyCustomizations();
}

function applyCustomizations() {
    if (uiPreferences.accentColor) applyAccentColor(uiPreferences.accentColor);
    applyDesktopBackgroundSettings();
    applyAppSurfaceOpacity(uiPreferences.appSurfaceOpacity);
    applyWallpaper(uiPreferences.wallpaper); // Kept for legacy
    applyFontSize(uiPreferences.fontSize);
    applyCompactMode(uiPreferences.compactMode);
    applyBubbleStyle(uiPreferences.bubbleStyle);
    applyChatMetaPanelSetting();
    applyBackgroundSettings();
    updateCustomizationUI();
}

async function saveUserPreferences() {
    // Save to local storage for offline/fallback
    localStorage.setItem('uiAccent', uiPreferences.accentColor);
    localStorage.setItem('uiWallpaper', uiPreferences.wallpaper);
    localStorage.setItem('uiFontSize', uiPreferences.fontSize);
    localStorage.setItem('uiCompactMode', uiPreferences.compactMode);
    localStorage.setItem('uiBubbleStyle', uiPreferences.bubbleStyle);
    localStorage.setItem('uiChatMetaCollapsed', uiPreferences.chatMetaCollapsed);

    localStorage.setItem('uiAppSurfaceOpacity', uiPreferences.appSurfaceOpacity);
    localStorage.setItem('uiDesktopBackgroundType', uiPreferences.desktopBackgroundType);
    localStorage.setItem('uiDesktopBackgroundImage', uiPreferences.desktopBackgroundImage);
    localStorage.setItem('uiDesktopBackgroundGradient', uiPreferences.desktopBackgroundGradient);
    localStorage.setItem('uiDesktopBackgroundColor', uiPreferences.desktopBackgroundColor);

    localStorage.setItem('uiBackgroundType', uiPreferences.backgroundType);
    localStorage.setItem('uiBackgroundImage', uiPreferences.backgroundImage);
    localStorage.setItem('uiBackgroundGradient', uiPreferences.backgroundGradient);
    localStorage.setItem('uiBackgroundColor', uiPreferences.backgroundColor);
    localStorage.setItem('uiBackgroundOpacity', uiPreferences.backgroundOpacity);

    // Sync with server
    try {
        await api('api/users/me/preferences', 'PUT', uiPreferences);
    } catch (e) {
        console.warn('Failed to sync preferences to server', e);
    }
}

function updateCustomizationUI() {
    const accentInput = document.getElementById('accentColorPicker');
    if (accentInput && uiPreferences.accentColor) {
        accentInput.value = uiPreferences.accentColor;
    }
    const wallpaperSelect = document.getElementById('wallpaperSelect'); // Legacy
    if (wallpaperSelect) {
        wallpaperSelect.value = uiPreferences.wallpaper;
    }
    const fontSizeRange = document.getElementById('fontSizeRange');
    if (fontSizeRange) {
        fontSizeRange.value = uiPreferences.fontSize;
    }
    const toggleCompactMode = document.getElementById('toggleCompactMode');
    if (toggleCompactMode) {
        toggleCompactMode.classList.toggle('active', uiPreferences.compactMode);
    }
    const bubbleStyleSelect = document.getElementById('bubbleStyleSelect');
    if (bubbleStyleSelect) {
        bubbleStyleSelect.value = uiPreferences.bubbleStyle;
    }

    const appOpacityRange = document.getElementById('appOpacityRange');
    if (appOpacityRange) appOpacityRange.value = uiPreferences.appSurfaceOpacity;
    const appOpacityValue = document.getElementById('appOpacityValue');
    if (appOpacityValue) appOpacityValue.textContent = String(uiPreferences.appSurfaceOpacity) + '%';

    // Desktop Background UI
    const desktopBgTypeSelect = document.getElementById('desktopBgTypeSelect');
    if (desktopBgTypeSelect) desktopBgTypeSelect.value = uiPreferences.desktopBackgroundType;

    const desktopBgImageInput = document.getElementById('desktopBgImageInput');
    if (desktopBgImageInput) desktopBgImageInput.value = uiPreferences.desktopBackgroundImage;

    const desktopBgColorInput = document.getElementById('desktopBgColorInput');
    if (desktopBgColorInput) desktopBgColorInput.value = uiPreferences.desktopBackgroundColor;

    const desktopBgGradientSelect = document.getElementById('desktopBgGradientSelect');
    let desktopGradientSelectValue = 'auto';
    const rawDesktopGradient = String(uiPreferences.desktopBackgroundGradient || '').trim();
    if (rawDesktopGradient.startsWith('preset:')) {
        const presetKey = rawDesktopGradient.slice('preset:'.length);
        desktopGradientSelectValue = GRADIENT_PRESETS[presetKey] ? presetKey : 'auto';
    } else if (rawDesktopGradient && isSafeCssGradient(rawDesktopGradient)) {
        desktopGradientSelectValue = 'custom';
    }
    if (desktopBgGradientSelect) desktopBgGradientSelect.value = desktopGradientSelectValue;

    const desktopBgGradientInput = document.getElementById('desktopBgGradientInput');
    if (desktopBgGradientInput) {
        desktopBgGradientInput.value = desktopGradientSelectValue === 'custom' ? rawDesktopGradient : '';
    }

    const desktopBgGradientPreview = document.getElementById('desktopBgGradientPreview');
    if (desktopBgGradientPreview) {
        if (uiPreferences.desktopBackgroundType === 'gradient') {
            desktopBgGradientPreview.style.background = getResolvedDesktopGradientValue();
        } else {
            desktopBgGradientPreview.style.background = '';
        }
    }

    const desktopBgImageControl = document.getElementById('desktopBgImageControl');
    if (desktopBgImageControl) desktopBgImageControl.style.display = uiPreferences.desktopBackgroundType === 'image' ? 'block' : 'none';
    const desktopBgGradientControl = document.getElementById('desktopBgGradientControl');
    if (desktopBgGradientControl) desktopBgGradientControl.style.display = uiPreferences.desktopBackgroundType === 'gradient' ? 'block' : 'none';
    const desktopBgGradientCustomControl = document.getElementById('desktopBgGradientCustomControl');
    if (desktopBgGradientCustomControl) {
        desktopBgGradientCustomControl.style.display = (uiPreferences.desktopBackgroundType === 'gradient' && desktopGradientSelectValue === 'custom') ? 'block' : 'none';
    }
    const desktopBgColorControl = document.getElementById('desktopBgColorControl');
    if (desktopBgColorControl) desktopBgColorControl.style.display = uiPreferences.desktopBackgroundType === 'solid' ? 'block' : 'none';

    // New Background UI
    const bgTypeSelect = document.getElementById('bgTypeSelect');
    if (bgTypeSelect) bgTypeSelect.value = uiPreferences.backgroundType;

    const bgImageInput = document.getElementById('bgImageInput');
    if (bgImageInput) bgImageInput.value = uiPreferences.backgroundImage;

    const bgColorInput = document.getElementById('bgColorInput');
    if (bgColorInput) bgColorInput.value = uiPreferences.backgroundColor;

    const bgOpacityRange = document.getElementById('bgOpacityRange');
    if (bgOpacityRange) bgOpacityRange.value = uiPreferences.backgroundOpacity;

    const bgGradientSelect = document.getElementById('bgGradientSelect');
    let gradientSelectValue = 'auto';
    const rawGradient = String(uiPreferences.backgroundGradient || '').trim();
    if (rawGradient.startsWith('preset:')) {
        const presetKey = rawGradient.slice('preset:'.length);
        gradientSelectValue = GRADIENT_PRESETS[presetKey] ? presetKey : 'auto';
    } else if (rawGradient && isSafeCssGradient(rawGradient)) {
        gradientSelectValue = 'custom';
    }
    if (bgGradientSelect) bgGradientSelect.value = gradientSelectValue;

    const bgGradientInput = document.getElementById('bgGradientInput');
    if (bgGradientInput) {
        bgGradientInput.value = gradientSelectValue === 'custom' ? rawGradient : '';
    }

    const bgGradientPreview = document.getElementById('bgGradientPreview');
    if (bgGradientPreview) {
        if (uiPreferences.backgroundType === 'gradient') {
            bgGradientPreview.style.background = getResolvedGradientValue();
        } else {
            bgGradientPreview.style.background = '';
        }
    }

    // Show/Hide controls based on type
    document.getElementById('bgImageControl').style.display = uiPreferences.backgroundType === 'image' ? 'block' : 'none';
    document.getElementById('bgGradientControl').style.display = uiPreferences.backgroundType === 'gradient' ? 'block' : 'none';
    document.getElementById('bgGradientCustomControl').style.display = (uiPreferences.backgroundType === 'gradient' && gradientSelectValue === 'custom') ? 'block' : 'none';
    document.getElementById('bgColorControl').style.display = (uiPreferences.backgroundType === 'solid' || (uiPreferences.backgroundType === 'gradient' && gradientSelectValue === 'auto')) ? 'block' : 'none';
}

function updateAccentColor(color) {
    uiPreferences.accentColor = color;
    applyAccentColor(color);
    saveUserPreferences();
}

function updateWallpaperChoice(value) {
    uiPreferences.wallpaper = value;
    applyWallpaper(value);
    saveUserPreferences();
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

function updateFontSize(size) {
    uiPreferences.fontSize = size;
    applyFontSize(size);
    saveUserPreferences();
}

function applyFontSize(size) {
    document.documentElement.style.setProperty('--font-size-base', size + 'px');
}

function toggleCompactMode() {
    uiPreferences.compactMode = !uiPreferences.compactMode;
    applyCompactMode(uiPreferences.compactMode);
    updateCustomizationUI();
    saveUserPreferences();
}

function applyCompactMode(isCompact) {
    document.body.classList.toggle('compact', isCompact);
}

function updateBubbleStyle(style) {
    uiPreferences.bubbleStyle = style;
    applyBubbleStyle(style);
    saveUserPreferences();
}

function applyBubbleStyle(style) {
    const root = document.documentElement;
    let radius = '7.5px';
    if (style === 'boxy') radius = '2px';
    else if (style === 'leaf') radius = '7.5px';
    else if (style === 'rounded') radius = '18px';
    root.style.setProperty('--bubble-radius', radius);
}

function updateAppSurfaceOpacity(opacity) {
    const parsed = Number.parseInt(opacity, 10);
    const clamped = Number.isFinite(parsed) ? Math.max(0, Math.min(100, parsed)) : 100;
    uiPreferences.appSurfaceOpacity = clamped;
    applyAppSurfaceOpacity(clamped);
    updateCustomizationUI();
    saveUserPreferences();
}

function applyAppSurfaceOpacity(opacity) {
    const parsed = Number.parseInt(opacity, 10);
    const clamped = Number.isFinite(parsed) ? Math.max(0, Math.min(100, parsed)) : 100;
    document.documentElement.style.setProperty('--app-surface-opacity', String(clamped) + '%');
}

function applyChatMetaPanelSetting() {
    const activeChatView = document.getElementById('activeChatView');
    if (activeChatView) {
        activeChatView.classList.toggle('meta-collapsed', Boolean(uiPreferences.chatMetaCollapsed));
    }
    const toggleBtn = document.getElementById('toggleChatMetaBtn');
    if (toggleBtn) {
        toggleBtn.classList.toggle('active', !uiPreferences.chatMetaCollapsed);
    }
}

function toggleChatMetaPanel() {
    uiPreferences.chatMetaCollapsed = !uiPreferences.chatMetaCollapsed;
    applyChatMetaPanelSetting();
    saveUserPreferences();
}

function updateDesktopBackgroundType(type) {
    uiPreferences.desktopBackgroundType = type;
    updateCustomizationUI(); // to toggle inputs
    applyDesktopBackgroundSettings();
    saveUserPreferences();
}

function updateDesktopBackgroundImage(url) {
    uiPreferences.desktopBackgroundImage = url;
    applyDesktopBackgroundSettings();
    saveUserPreferences();
}

function updateDesktopBackgroundColor(color) {
    uiPreferences.desktopBackgroundColor = color;
    applyDesktopBackgroundSettings();
    saveUserPreferences();
}

function updateDesktopBackgroundGradient(value) {
    if (value === 'auto') {
        uiPreferences.desktopBackgroundGradient = '';
    } else if (value === 'custom') {
        const existing = String(uiPreferences.desktopBackgroundGradient || '').trim();
        if (!existing || existing.startsWith('preset:')) {
            uiPreferences.desktopBackgroundGradient = getDefaultDesktopBackground();
        }
    } else if (GRADIENT_PRESETS[value]) {
        uiPreferences.desktopBackgroundGradient = 'preset:' + value;
    } else {
        uiPreferences.desktopBackgroundGradient = '';
    }

    updateCustomizationUI();
    applyDesktopBackgroundSettings();
    saveUserPreferences();
}

function updateDesktopBackgroundGradientCustom(value) {
    const trimmed = String(value || '').trim();
    if (!trimmed) {
        uiPreferences.desktopBackgroundGradient = '';
        updateCustomizationUI();
        applyDesktopBackgroundSettings();
        saveUserPreferences();
        return;
    }

    if (!isSafeCssGradient(trimmed)) {
        showToast('Gradyan formati gecersiz (linear-gradient / radial-gradient)', 'error');
        updateCustomizationUI();
        return;
    }

    uiPreferences.desktopBackgroundGradient = trimmed;
    updateCustomizationUI();
    applyDesktopBackgroundSettings();
    saveUserPreferences();
}

function getDefaultDesktopBackground() {
    return 'linear-gradient(180deg, var(--accent) 0%, var(--accent) 127px, var(--bg-secondary) 127px)';
}

function getResolvedDesktopGradientValue() {
    const rawGradient = String(uiPreferences.desktopBackgroundGradient || '').trim();
    if (rawGradient.startsWith('preset:')) {
        const presetKey = rawGradient.slice('preset:'.length);
        return GRADIENT_PRESETS[presetKey] || getDefaultDesktopBackground();
    }
    if (rawGradient && isSafeCssGradient(rawGradient)) {
        return rawGradient;
    }
    return getDefaultDesktopBackground();
}

function applyDesktopBackgroundSettings() {
    const root = document.documentElement;
    const type = uiPreferences.desktopBackgroundType;

    if (type === 'default') {
        root.style.removeProperty('--desktop-background');
        return;
    }

    let bgValue = getDefaultDesktopBackground();

    if (type === 'image' && uiPreferences.desktopBackgroundImage) {
        bgValue = `url("${uiPreferences.desktopBackgroundImage}")`;
    } else if (type === 'solid') {
        bgValue = uiPreferences.desktopBackgroundColor || '#f0f2f5';
    } else if (type === 'gradient') {
        bgValue = getResolvedDesktopGradientValue();
    }

    root.style.setProperty('--desktop-background', bgValue);
}

function updateBackgroundType(type) {
    uiPreferences.backgroundType = type;
    updateCustomizationUI(); // to toggle inputs
    applyBackgroundSettings();
    saveUserPreferences();
}

function updateBackgroundImage(url) {
    uiPreferences.backgroundImage = url;
    applyBackgroundSettings();
    saveUserPreferences();
}

function updateBackgroundColor(color) {
    uiPreferences.backgroundColor = color;
    applyBackgroundSettings();
    saveUserPreferences();
}

function updateBackgroundGradient(value) {
    if (value === 'auto') {
        uiPreferences.backgroundGradient = '';
    } else if (value === 'custom') {
        const existing = String(uiPreferences.backgroundGradient || '').trim();
        if (!existing || existing.startsWith('preset:')) {
            uiPreferences.backgroundGradient = getDerivedGradientFromColor(uiPreferences.backgroundColor);
        }
    } else if (GRADIENT_PRESETS[value]) {
        uiPreferences.backgroundGradient = 'preset:' + value;
    } else {
        uiPreferences.backgroundGradient = '';
    }

    updateCustomizationUI();
    applyBackgroundSettings();
    saveUserPreferences();
}

function updateBackgroundGradientCustom(value) {
    const trimmed = String(value || '').trim();
    if (!trimmed) {
        uiPreferences.backgroundGradient = '';
        updateCustomizationUI();
        applyBackgroundSettings();
        saveUserPreferences();
        return;
    }

    if (!isSafeCssGradient(trimmed)) {
        showToast('Gradyan formati gecersiz (linear-gradient / radial-gradient)', 'error');
        updateCustomizationUI();
        return;
    }

    uiPreferences.backgroundGradient = trimmed;
    updateCustomizationUI();
    applyBackgroundSettings();
    saveUserPreferences();
}

function updateBackgroundOpacity(opacity) {
    uiPreferences.backgroundOpacity = opacity;
    applyBackgroundSettings();
    saveUserPreferences();
}

function isSafeCssGradient(value) {
    if (typeof value !== 'string') return false;
    const trimmed = value.trim();
    if (!trimmed) return false;
    if (trimmed.length > 240) return false;
    if (!/^(linear-gradient|radial-gradient)\(/i.test(trimmed)) return false;
    if (/url\s*\(/i.test(trimmed)) return false;
    if (/expression\s*\(/i.test(trimmed)) return false;
    // Allow only a strict set of characters to avoid CSS injection primitives.
    if (/[^a-z0-9#(),.%+\-\s]/i.test(trimmed)) return false;
    return true;
}

function getDerivedGradientFromColor(color) {
    const base = color || '#efeae2';
    const color2 = adjustColor(base, -30);
    return `linear-gradient(135deg, ${base} 0%, ${color2} 100%)`;
}

function getResolvedGradientValue() {
    const rawGradient = String(uiPreferences.backgroundGradient || '').trim();
    if (rawGradient.startsWith('preset:')) {
        const presetKey = rawGradient.slice('preset:'.length);
        return GRADIENT_PRESETS[presetKey] || getDerivedGradientFromColor(uiPreferences.backgroundColor);
    }
    if (rawGradient && isSafeCssGradient(rawGradient)) {
        return rawGradient;
    }
    return getDerivedGradientFromColor(uiPreferences.backgroundColor);
}

function applyBackgroundSettings() {
    const root = document.documentElement;
    const type = uiPreferences.backgroundType;
    let bgValue = 'var(--wallpaper-default)'; // Default fallback

    if (type === 'image' && uiPreferences.backgroundImage) {
        bgValue = `url("${uiPreferences.backgroundImage}")`;
    } else if (type === 'solid') {
        bgValue = uiPreferences.backgroundColor;
    } else if (type === 'gradient') {
        bgValue = getResolvedGradientValue();
    } else if (type === 'default') {
        bgValue = 'var(--wallpaper-default)';
    }

    root.style.setProperty('--chat-wallpaper', bgValue);

    // Opacity handling via overlay hack on body or specific container
    // Since we use background-image on .chat-area, changing opacity on it affects text.
    // Best way: use a pseudo-element or separate container.
    // For now, let's assume direct assignment works for type, but opacity might need CSS change.
    // If we simply set opacity on the element, text fades.
    // We'll trust the CSS update to handle ::before overlay if possible, or skip opacity for now.
    // Wait, the plan said "A pseudo-element ::before on .chat-area".
    // I need to ensure CSS has that. I'll stick to variable setting here.
    root.style.setProperty('--chat-bg-opacity', uiPreferences.backgroundOpacity / 100);
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

    // Mark as read if Ghost Mode is off
    if (currentChat && !settings.ghostMode) {
        api('api/chats/' + encodeURIComponent(currentChat) + '/mark-read', 'POST').catch(() => {});
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
let chatsReloadTimeout = null;
function scheduleChatsReload(delayMs = 250) {
    if (chatsReloadTimeout) return;
    chatsReloadTimeout = setTimeout(() => {
        chatsReloadTimeout = null;
        loadChats();
    }, delayMs);
}

function initSocket() {
    const basePath = window.location.pathname.endsWith('/') ? window.location.pathname : window.location.pathname + '/';
    socket = io({ path: basePath + 'socket.io/', auth: { accountId: activeAccountId } });

    socket.on('connect', () => console.log('Socket connected'));
    socket.on('disconnect', () => console.log('Socket disconnected'));
    socket.on('status', (status) => {
        updateConnectionStatus(status);
        if (status && status.status === 'qr' && status.qrCode) {
            showQR(status.qrCode);
        } else {
            hideQR();
        }
    });
    socket.on('qr', showQR);
    socket.on('ready', (info) => {
        hideQR();
        updateConnectionStatus({ status: 'ready', info });
        showToast('WhatsApp baglandi: ' + info.pushname, 'success');
        loadChats();
        loadAllMessages();
    });
    socket.on('disconnected', () => {
        hideQR();
        updateConnectionStatus({ status: 'disconnected' });
        showToast('WhatsApp baglantisi kesildi', 'warning');
    });
    socket.on('message', handleNewMessage);
    socket.on('message_ack', handleMessageAck);
    socket.on('media_downloaded', handleMediaDownloaded);
    socket.on('chat_updated', () => scheduleChatsReload());
    socket.on('sync_chats_indexed', () => scheduleChatsReload());
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

async function api(url, method, body, fetchOptions) {
    method = method || 'GET';
    fetchOptions = fetchOptions || {};
    const headers = { 'Content-Type': 'application/json' };
    const isAccountsList = method === 'GET' && url === 'api/accounts';
    if (activeAccountId && !isAccountsList && fetchOptions.includeAccount !== false) {
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
    if (response.status === 429 && url === 'api/accounts') {
        return { accounts: [], currentAccountId: activeAccountId };
    }
    const rawText = await response.text();
    let data = null;
    try {
        data = rawText ? JSON.parse(rawText) : null;
    } catch (e) {
        data = null;
    }
    if (!response.ok) {
        const message = (data && data.error) ? data.error : (rawText || 'API Error');
        throw new Error(message);
    }
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
        case 'initializing':
            container.classList.add('connecting');
            icon.style.display = 'none';
            spinner.style.display = 'inline-block';
            text.textContent = 'Baslatiliyor...';
            break;
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
        case 'auth_failure':
            container.classList.add('disconnected');
            icon.className = 'bi bi-wifi-off';
            icon.style.display = 'inline';
            spinner.style.display = 'none';
            text.textContent = 'Kimlik dogrulama hatasi';
            break;
        case 'error':
            container.classList.add('disconnected');
            icon.className = 'bi bi-wifi-off';
            icon.style.display = 'inline';
            spinner.style.display = 'none';
            text.textContent = 'Baglanti hatasi';
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
        await loadSyncProgress();
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
        const container = document.getElementById('messagesContainer');
        if (container) {
            // New chat load should always auto-scroll; clear previous chat's scroll memory.
            container.dataset.autoScrollTop = '';
            container.dataset.autoScrollSeq = '';
        }
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
            scrollToBottom: shouldReset,
            scrollAttempts: shouldReset ? 25 : undefined,
            scrollIntervalMs: shouldReset ? 200 : undefined
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
        // UI-only flags
        const localNotifications = localStorage.getItem('uiNotifications');
        if (localNotifications !== null) settings.notifications = localNotifications === 'true';
        const localSounds = localStorage.getItem('uiSounds');
        if (localSounds !== null) settings.sounds = localSounds === 'true';
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
        'toggleDownloadMediaOnSync': settings.downloadMediaOnSync,
        'toggleDownloadProfilePictures': settings.downloadProfilePictures,
        'toggleSyncOnConnect': settings.syncOnConnect,
        'toggleUploadToDrive': settings.uploadToDrive,
        'toggleNotifications': settings.notifications,
        'toggleSounds': settings.sounds,
        'toggleGhostMode': settings.ghostMode
    };

    Object.entries(toggles).forEach(([id, value]) => {
        const el = document.getElementById(id);
        if (el) el.classList.toggle('active', value);
    });
}

function getWhatsAppSettingsPayload() {
    return {
        downloadMedia: settings.downloadMedia,
        downloadMediaOnSync: settings.downloadMediaOnSync,
        downloadProfilePictures: settings.downloadProfilePictures,
        syncOnConnect: settings.syncOnConnect,
        uploadToDrive: settings.uploadToDrive,
        ghostMode: settings.ghostMode
    };
}

async function toggleSetting(key) {
    settings[key] = !settings[key];
    updateSettingsUI();
    try {
        if (key === 'notifications') {
            localStorage.setItem('uiNotifications', String(settings.notifications));
            return;
        }
        if (key === 'sounds') {
            localStorage.setItem('uiSounds', String(settings.sounds));
            return;
        }
        await api('api/settings', 'POST', getWhatsAppSettingsPayload());
    } catch (err) {
        showToast('Ayar kaydedilemedi: ' + err.message, 'error');
    }
}

// Render Functions
function renderAvatarContent(chat) {
    const isGroup = chat && chat.chat_id && chat.chat_id.includes('@g.us');
    const avatarIcon = isGroup ? 'bi-people-fill' : 'bi-person-fill';
    const profileUrl = sanitizeUrl(chat.profile_pic || chat.profilePic || '');
    if (profileUrl) {
        return '<img src="' + profileUrl + '" alt="">';
    }
    return '<i class="bi ' + avatarIcon + '"></i>';
}

function renderChatAvatar(chat) {
    const isGroup = chat && chat.chat_id && chat.chat_id.includes('@g.us');
    const avatarClass = isGroup ? 'avatar group' : 'avatar';
    return '<div class="' + avatarClass + '">' + renderAvatarContent(chat) + '</div>';
}

function renderChatList(chatList) {
    const container = document.getElementById('chatList');
    if (!container) return;

    if (chatList.length === 0) {
        container.innerHTML = '<div class="chat-item"><div class="chat-info"><div class="chat-name" style="color: var(--text-secondary)">Henuz sohbet yok</div></div></div>';
        return;
    }

    container.innerHTML = chatList.map(c => {
        const isActive = currentChat === c.chat_id;
        const hasUnread = c.unread_count > 0;

        return '<div class="chat-item' + (isActive ? ' active' : '') + (hasUnread ? ' unread' : '') + '" onclick="selectChat(\'' + c.chat_id + '\', \'' + escapeHtml(c.name) + '\')">' +
            renderChatAvatar(c) +
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
    const previewText = getMessagePreviewText(message);

    return '<div class="chat-item" onclick="openChatForMessage(\'' + (message.chat_id || '') + '\')">' +
        '<div class="avatar"><i class="bi bi-chat-text-fill"></i></div>' +
        '<div class="chat-info">' +
            '<div class="top-row">' +
                '<div class="chat-name">' + direction + ' ' + escapeHtml(formatSenderName(displayName)) + '</div>' +
                '<span class="chat-time">' + formatTime(message.timestamp) + '</span>' +
            '</div>' +
            '<div class="chat-preview">' +
                '<span class="preview-text">' + escapeHtml(previewText.substring(0, 50)) + '</span>' +
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

function getChatMessageId(message) {
    const raw = message?.message_id || message?.messageId || '';
    return typeof raw === 'string' ? raw : String(raw || '');
}

function buildChatMessageRow(message, context = {}, options = {}) {
    const chatId = context.chatId || currentChat;
    const isMine = message.is_from_me === 1 || message.is_from_me === true;
    let mediaHtml = '';
    const type = message.type || 'chat';
    const mediaUrl = message.media_url || message.mediaUrl;
    const mediaTypes = ['image', 'video', 'audio', 'ptt', 'document', 'sticker'];
    const hasMediaType = mediaTypes.includes(type);

    if (mediaUrl) {
        const safeMediaUrl = sanitizeUrl(mediaUrl);
        if (safeMediaUrl) {
            if (type === 'image' || type === 'sticker') {
                mediaHtml = '<div class="message-media"><img src="' + safeMediaUrl + '" onclick="openMediaLightbox(this.src)" loading="lazy" alt=""></div>';
            } else if (type === 'video') {
                mediaHtml = '<div class="message-media"><video src="' + safeMediaUrl + '" controls></video></div>';
            } else if (type === 'audio' || type === 'ptt') {
                mediaHtml = '<div class="message-media"><audio src="' + safeMediaUrl + '" controls></audio></div>';
            } else if (type === 'document') {
                const fileName = message.body || 'Belge';
                mediaHtml = '<div class="document-bubble" onclick="window.open(\'' + safeMediaUrl + '\')">' +
                    '<div class="doc-icon pdf"><i class="bi bi-file-earmark-pdf"></i></div>' +
                    '<div class="doc-info"><div class="doc-name">' + escapeHtml(fileName) + '</div>' +
                    '<div class="doc-size">Indir</div></div></div>';
            }
        }
    }

    const isSystem = !mediaHtml && !message.body && !hasMediaType && type !== 'chat';
    let textHtml = '';

    if (message.body && (type === 'chat' || (mediaUrl && message.body && type !== 'document'))) {
        textHtml = '<div class="message-text">' + linkifyTextToHtml(message.body) + '</div>';
    } else if (type === 'document' && mediaUrl) {
        const fileName = message.body || 'Belge';
        textHtml = '<div class="message-text muted">[Dosya] ' + escapeHtml(fileName) + '</div>';
    } else if (hasMediaType && !mediaUrl) {
        // Loading State
        let iconClass = 'bi-file-earmark';
        let label = 'Dosya';
        if (type === 'image') { iconClass = 'bi-image'; label = 'Fotograf'; }
        else if (type === 'sticker') { iconClass = 'bi-sticky-fill'; label = 'Sticker'; }
        else if (type === 'video') { iconClass = 'bi-camera-video'; label = 'Video'; }
        else if (type === 'audio' || type === 'ptt') { iconClass = 'bi-mic'; label = 'Ses'; }

        const fileName = message.body || label;

        textHtml = `<div class="media-loading">
            <div class="loading-info">
                <i class="bi ${iconClass} file-icon"></i>
                <div class="loading-text">
                    <div>${escapeHtml(fileName)}</div>
                    <div style="font-size: 10px; opacity: 0.8;">Sunucuya indiriliyor...</div>
                </div>
            </div>
            <div class="progress-track">
                <div class="progress-bar"></div>
            </div>
        </div>`;
    } else if (hasMediaType) {
        textHtml = '<div class="message-text muted">[Medya]</div>';
    } else if (isSystem) {
        textHtml = '<div class="message-text muted">[Sistem: ' + escapeHtml(type) + ']</div>';
    } else if (!mediaHtml) {
        textHtml = '<div class="message-text muted">[Bos mesaj]</div>';
    }

    const showSenderNames = isGroupChatId(chatId);
    const canShowGroupSender = showSenderNames && !isMine && !isSystem;
    const displayName = canShowGroupSender ? getDisplayNameFromMessage(message, chatId) : '';
    const senderContactId = canShowGroupSender ? getSenderContactIdFromMessage(message, chatId) : '';
    const senderKey = senderContactId || displayName || '';

    const prevSenderKey = context.prevSenderKey || null;
    const prevCanStack = context.prevCanStack === true;
    const prevTs = context.prevTs || null;
    const msgTs = normalizeTimestamp(message.timestamp);
    const prevTsMs = normalizeTimestamp(prevTs);
    const timeGapMs = (prevTsMs && msgTs) ? (msgTs - prevTsMs) : Number.POSITIVE_INFINITY;
    const isStacked = (canShowGroupSender && prevCanStack && prevSenderKey && prevSenderKey === senderKey && timeGapMs < (5 * 60 * 1000));
    const showSenderMeta = (canShowGroupSender && !isStacked);

    const senderIdAttr = senderContactId ? ' data-sender-id="' + escapeHtml(senderContactId) + '"' : '';
    const senderHtml = (showSenderMeta && displayName)
        ? '<div class="sender-name"' + senderIdAttr + '>' + escapeHtml(formatSenderName(displayName)) + '</div>'
        : '';

    const avatarHtml = canShowGroupSender
        ? renderSenderAvatar(senderContactId, displayName, showSenderMeta)
        : '';

    let quotedHtml = '';
    if (!isSystem) {
        const quotedMessageId = message.quoted_message_id || message.quotedMessageId;
        const quotedBodyRaw = message.quoted_body || message.quotedBody;
        const quotedFromNameRaw = message.quoted_from_name || message.quotedFromName;

        if (quotedMessageId || quotedBodyRaw || quotedFromNameRaw) {
            const quotedSender = quotedFromNameRaw
                ? formatSenderName(String(quotedFromNameRaw))
                : 'Yanıt';
            const quotedText = quotedBodyRaw
                ? String(quotedBodyRaw).slice(0, 180)
                : '[Mesaj]';
            const quotedId = quotedMessageId ? String(quotedMessageId) : '';
            const quotedClick = quotedId
                ? ' onclick="scrollToMessage(\'' + escapeHtml(quotedId) + '\'); event.stopPropagation();"'
                : '';

            quotedHtml = '<div class="reply-quote"' + quotedClick + '>' +
                '<div class="reply-quote-sender">' + escapeHtml(quotedSender) + '</div>' +
                '<div class="reply-quote-text">' + escapeHtml(quotedText) + '</div>' +
            '</div>';
        }
    }

    const checkIcon = isMine && !isSystem ? getMessageStatusIcon(message.ack) : '';
    const messageId = getChatMessageId(message);
    const messageIdAttr = escapeHtml(messageId);
    const isPending = Boolean(message.client_pending) || (messageId && String(messageId).startsWith('pending-'));

    const rowClass = 'message-row ' + (isMine ? 'sent' : 'received') +
        (isSystem ? ' system' : '') +
        (canShowGroupSender ? ' group' : '') +
        (isStacked ? ' stacked' : '') +
        (isPending ? ' pending' : '') +
        (options.animate ? ' animate-in' : '');

    const dataSenderKeyAttr = escapeHtml(senderKey);
    const dataTsAttr = msgTs ? String(msgTs) : '';
    const dataCanStackAttr = canShowGroupSender ? '1' : '0';

    const bubbleClass = isSystem
        ? 'message-bubble system'
        : ('message-bubble ' + (isMine ? 'sent' : 'received'));
    const replyBtn = (!isSystem && messageId && !isPending)
        ? '<button class="message-action reply-btn" type="button" onclick="setReplyTargetFromButton(this); event.stopPropagation();" title="Yanıtla">' +
            '<i class="bi bi-reply"></i>' +
          '</button>'
        : '';
    const bubbleContent = senderHtml + quotedHtml + mediaHtml + textHtml +
        '<div class="message-footer">' + replyBtn + '<span class="message-time">' + formatTime(message.timestamp) + '</span>' + checkIcon + '</div>';

    const html = '<div class="' + rowClass + '"' +
        ' data-message-id="' + messageIdAttr + '"' +
        ' data-sender-key="' + dataSenderKeyAttr + '"' +
        ' data-can-stack="' + dataCanStackAttr + '"' +
        ' data-ts="' + escapeHtml(dataTsAttr) + '"' +
        '>' +
        avatarHtml +
        '<div class="' + bubbleClass + '">' +
        bubbleContent +
        '</div></div>';

    return {
        html,
        meta: {
            senderKey,
            canStack: canShowGroupSender,
            timestamp: msgTs || null
        }
    };
}

function upsertChatMessageRow(message, options = {}) {
    const container = document.getElementById('messagesContainer');
    if (!container) return;

    const messageId = getChatMessageId(message);
    if (messageId) {
        const existing = container.querySelector('[data-message-id="' + CSS.escape(messageId) + '"]');
        if (existing) {
            return;
        }
    }

    const shouldStickToBottom = isChatNearBottom(container, 160);
    const lastRow = container.lastElementChild;
    const prevSenderKey = lastRow?.dataset?.senderKey || null;
    const prevCanStack = lastRow?.dataset?.canStack === '1';
    const prevTs = lastRow?.dataset?.ts ? parseInt(lastRow.dataset.ts, 10) : null;

    const { html } = buildChatMessageRow(message, { chatId: currentChat, prevSenderKey, prevCanStack, prevTs }, options);
    container.insertAdjacentHTML('beforeend', html);

    if (shouldStickToBottom) {
        ensureChatScrolledToBottom(container);
    }
}

function renderChatMessages(messages, options = {}) {
    const container = document.getElementById('messagesContainer');
    if (!container) return;

    const previousScrollHeight = container.scrollHeight;
    const previousScrollTop = container.scrollTop;

    // Sort messages chronologically (timestamps may be ms, seconds, or SQLite DATETIME strings)
    const sorted = [...messages].sort((a, b) => {
        const aTs = normalizeTimestamp(a?.timestamp) || 0;
        const bTs = normalizeTimestamp(b?.timestamp) || 0;
        return aTs - bTs;
    });

    const rows = [];
    let prevSenderKey = null;
    let prevCanStack = false;
    let prevTs = null;

    for (const m of sorted) {
        const rendered = buildChatMessageRow(m, { chatId: currentChat, prevSenderKey, prevCanStack, prevTs });
        rows.push(rendered.html);
        prevSenderKey = rendered.meta.senderKey;
        prevCanStack = rendered.meta.canStack;
        prevTs = rendered.meta.timestamp;
    }

    container.innerHTML = rows.join('');

    if (options.preserveScroll) {
        const newScrollHeight = container.scrollHeight;
        container.scrollTop = newScrollHeight - previousScrollHeight + previousScrollTop;
        return;
    }

    if (options.scrollToBottom !== false) {
        const attempts = options.scrollAttempts ?? 10;
        const intervalMs = options.scrollIntervalMs ?? 150;
        ensureChatScrolledToBottom(container, { attempts, intervalMs });
        bindChatMediaAutoScroll(container);
    }
}

// Chat Selection
function selectChat(chatId, name) {
    currentChat = chatId;
    currentChatTags = [];
    currentChatNotes = [];
    renderChatMeta();
    const selectedChat = chats.find(chat => chat.chat_id === chatId) || null;

    if (!settings.ghostMode) {
        api('api/chats/' + encodeURIComponent(chatId) + '/mark-read', 'POST').catch(() => {});
    }

    const chatArea = document.getElementById('chatArea');
    const emptyChatView = document.getElementById('emptyChatView');
    const qrSection = document.getElementById('qrSection');
    const activeChatView = document.getElementById('activeChatView');
    const chatName = document.getElementById('chatName');
    const chatStatus = document.getElementById('chatStatus');
    const chatAvatar = document.getElementById('chatAvatar');

    chatArea.classList.remove('empty');
    emptyChatView.style.display = 'none';
    qrSection.style.display = 'none';
    activeChatView.style.display = 'flex';
    activeChatView.style.flexDirection = 'column';
    activeChatView.style.height = '100%';

    chatName.textContent = name;
    chatStatus.textContent = 'son gorulme yakin zamanda';
    if (chatAvatar) {
        chatAvatar.innerHTML = selectedChat ? renderAvatarContent(selectedChat) : renderAvatarContent({ chat_id: chatId });
    }

    loadChatMessages(chatId);
    renderChatList(chats);

    // Mobile: show chat area with transition
    chatArea.classList.add('active');
}

function closeChat() {
    currentChat = null;
    const chatArea = document.getElementById('chatArea');
    const activeChatView = document.getElementById('activeChatView');

    // Mobile transition
    chatArea.classList.remove('active');
    
    // Delay hiding content slightly for transition to finish if needed, 
    // but clearing immediately is safer for state.
    // However, on desktop we want to show empty view.
    // CSS handles mobile hiding via transform.
    
    setTimeout(() => {
        if (!chatArea.classList.contains('active')) {
             activeChatView.style.display = 'none';
             chatArea.classList.add('empty');
             document.getElementById('emptyChatView').style.display = 'flex';
        }
    }, 300); // Match CSS transition duration
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
function selectMessageRow(messageId) {
    const container = document.getElementById('messagesContainer');
    if (!container) return;
    container.querySelectorAll('.message-row.selected').forEach((row) => row.classList.remove('selected'));
    if (!messageId) return;
    const row = container.querySelector('[data-message-id="' + CSS.escape(messageId) + '"]');
    if (row) {
        row.classList.add('selected');
    }
}

function setReplyTarget(messageId) {
    const id = typeof messageId === 'string' ? messageId.trim() : String(messageId || '').trim();
    if (!id) return;
    if (!currentChat) return;
    if (id.startsWith('pending-')) {
        showToast('Mesaj gonderiliyor; yanitlamak icin biraz bekleyin', 'info');
        return;
    }

    const msg = chatMessagesPagination.items.find(item => (item.message_id || item.messageId) === id) || null;
    const isMine = msg ? (msg.is_from_me === 1 || msg.is_from_me === true) : false;
    const fromName = msg
        ? (isMine ? 'Sen' : (msg.from_name || msg.fromName || msg.from_number || msg.fromNumber || ''))
        : '';

    let previewText = '[Mesaj]';
    if (msg) {
        if (msg.body) {
            previewText = String(msg.body);
        } else {
            const type = msg.type || 'chat';
            if (type === 'document') previewText = '[Dosya]';
            else if (['image', 'video', 'audio', 'ptt', 'sticker'].includes(type)) previewText = '[Medya]';
        }
    }

    replyTarget = { messageId: id, fromName, previewText };
    renderReplyPreview();
    selectMessageRow(id);

    const input = document.getElementById('messageInput');
    if (input) input.focus();
}

function setReplyTargetFromButton(button) {
    const row = button?.closest?.('.message-row');
    const messageId = row?.getAttribute?.('data-message-id') || '';
    if (!messageId) return;
    setReplyTarget(messageId);
}

function clearReplyTarget() {
    replyTarget = null;
    renderReplyPreview();
    selectMessageRow(null);
}

function renderReplyPreview() {
    const container = document.getElementById('replyPreview');
    if (!container) return;

    if (!replyTarget) {
        container.style.display = 'none';
        container.innerHTML = '';
        return;
    }

    const sender = replyTarget.fromName ? escapeHtml(replyTarget.fromName) : 'Yanıt';
    const text = escapeHtml(String(replyTarget.previewText || '').slice(0, 180));

    container.style.display = 'flex';
    container.innerHTML =
        '<div class="reply-preview-content">' +
            '<div class="reply-preview-title">Yanıt: ' + sender + '</div>' +
            '<div class="reply-preview-text">' + text + '</div>' +
        '</div>' +
        '<button class="icon-btn" type="button" onclick="clearReplyTarget()" title="Iptal">' +
            '<i class="bi bi-x"></i>' +
        '</button>';
}

function scrollToMessage(messageId) {
    const id = typeof messageId === 'string' ? messageId.trim() : String(messageId || '').trim();
    if (!id) return;
    const container = document.getElementById('messagesContainer');
    if (!container) return;
    const row = container.querySelector('[data-message-id="' + CSS.escape(id) + '"]');
    if (!row) {
        showToast('Mesaj bulunamadi', 'info');
        return;
    }

    row.classList.add('highlight');
    try {
        row.scrollIntoView({ behavior: 'smooth', block: 'center' });
    } catch (e) {
        row.scrollIntoView();
    }

    setTimeout(() => row.classList.remove('highlight'), 1800);
}

function createPendingMessage({ body, type, mediaMimetype, attachmentName }) {
    const now = Date.now();
    const tempId = 'pending-' + now.toString(36) + '-' + Math.random().toString(36).slice(2, 8);
    const message = {
        message_id: tempId,
        chat_id: currentChat,
        is_from_me: 1,
        ack: 0,
        timestamp: now,
        body: body || (attachmentName || ''),
        type: type || 'chat',
        media_url: null,
        media_mimetype: mediaMimetype || null,
        quoted_message_id: replyTarget?.messageId || null,
        quoted_body: replyTarget?.previewText || null,
        quoted_from_name: replyTarget?.fromName || null,
        client_pending: true
    };

    pendingOutgoing.set(tempId, {
        tempId,
        chatId: currentChat,
        body: message.body || '',
        timestamp: now,
        serverMessageId: null
    });

    chatMessagesPagination.items.push(message);
    upsertChatMessageRow(message, { animate: true });

    return tempId;
}

function resolvePendingMessage(tempId, serverMessageId, serverTimestamp) {
    const record = pendingOutgoing.get(tempId);
    if (!record) return;
    if (!serverMessageId) return;
    if (record.serverMessageId && record.serverMessageId !== serverMessageId) return;
    record.serverMessageId = serverMessageId;

    // Update in-memory message id
    const item = chatMessagesPagination.items.find(m => (m.message_id || m.messageId) === tempId);
    if (item) {
        item.message_id = serverMessageId;
        if (serverTimestamp) item.timestamp = serverTimestamp;
        item.client_pending = false;
    }

    // Update DOM
    const container = document.getElementById('messagesContainer');
    if (!container) return;
    const row = container.querySelector('[data-message-id="' + CSS.escape(tempId) + '"]');
    if (!row) return;
    row.setAttribute('data-message-id', String(serverMessageId));
    if (serverTimestamp) {
        row.setAttribute('data-ts', String(serverTimestamp));
        const timeEl = row.querySelector('.message-time');
        if (timeEl) timeEl.textContent = formatTime(serverTimestamp);
    }
    row.classList.remove('pending');
    pendingOutgoing.delete(tempId);
}

function maybeResolvePendingFromSocketMessage(normalized) {
    const isMine = normalized?.is_from_me === 1 || normalized?.is_from_me === true;
    if (!isMine) return;
    const serverId = normalized?.message_id || '';
    if (!serverId) return;

    // Already rendered with real id
    const container = document.getElementById('messagesContainer');
    if (container && container.querySelector('[data-message-id="' + CSS.escape(serverId) + '"]')) {
        return;
    }

    const candidates = Array.from(pendingOutgoing.values())
        .filter(p => p.chatId === normalized.chat_id && !p.serverMessageId);

    if (!candidates.length) return;

    const body = String(normalized.body || '').trim();
    const ts = Number(normalized.timestamp) || Date.now();

    let best = null;
    let bestScore = Number.POSITIVE_INFINITY;
    for (const cand of candidates) {
        const delta = Math.abs(ts - (cand.timestamp || 0));
        if (delta > 2 * 60 * 1000) continue;
        const bodyMatch = !body || !cand.body || body === String(cand.body).trim();
        if (!bodyMatch) continue;
        if (delta < bestScore) {
            best = cand;
            bestScore = delta;
        }
    }

    if (!best) return;
    resolvePendingMessage(best.tempId, serverId, ts);
}

async function sendMessage() {
    const input = document.getElementById('messageInput');
    const message = input.value.trim();

    if (!currentChat || (!message && !selectedAttachment)) return;

    input.value = '';
    autoResizeInput(input);
    closeEmojiPicker();

    const file = selectedAttachment;
    const sendAsSticker = Boolean(
        file &&
        attachmentSendMode === 'sticker' &&
        typeof file.type === 'string' &&
        file.type.startsWith('image/')
    );
    const mediaType = file
        ? (file.type.startsWith('image/') ? (sendAsSticker ? 'sticker' : 'image')
            : (file.type.startsWith('video/') ? 'video'
                : (file.type.startsWith('audio/') ? 'audio' : 'document')))
        : 'chat';

    const tempId = createPendingMessage({
        body: message,
        type: file ? mediaType : 'chat',
        mediaMimetype: file ? file.type : null,
        attachmentName: file ? file.name : null
    });

    try {
        const quotedMessageId = replyTarget?.messageId && !String(replyTarget.messageId).startsWith('pending-')
            ? replyTarget.messageId
            : undefined;

        if (file) {
            const result = await sendMessageWithAttachment(message, file, {
                quotedMessageId,
                sendAsSticker
            });
            resolvePendingMessage(tempId, result.messageId, Date.now());
            clearAttachment();
        } else {
            const result = await api('api/send', 'POST', { chatId: currentChat, message, quotedMessageId });
            resolvePendingMessage(tempId, result.messageId, Date.now());
        }
        clearReplyTarget();
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
    if (settings.notifications) {
        const isMine = msg?.isFromMe === true || msg?.isFromMe === 1 || msg?.is_from_me === 1 || msg?.is_from_me === true || msg?.fromMe === true;
        if (!isMine) {
            const displayName = getDisplayNameFromMessage(msg);
            showToast('Yeni mesaj: ' + formatSenderName(displayName), 'info');
        }
    }

    const incomingChatId = msg.chatId || msg.chat_id;
    if (currentChat && incomingChatId && currentChat === incomingChatId) {
        const normalized = {
            message_id: msg.messageId || msg.message_id,
            chat_id: incomingChatId,
            is_from_me: msg.isFromMe ?? msg.is_from_me ?? 0,
            ack: msg.ack || 0,
            timestamp: msg.timestamp || Date.now(),
            body: msg.body || msg.message || '',
            from_name: msg.fromName || msg.from_name,
            from_number: msg.fromNumber || msg.from_number,
            type: msg.type,
            media_url: msg.mediaUrl || msg.media_url,
            media_mimetype: msg.mediaMimeType || msg.media_mimetype,
            quoted_message_id: msg.quotedMessageId || msg.quoted_message_id,
            quoted_body: msg.quotedBody || msg.quoted_body,
            quoted_from_name: msg.quotedFromName || msg.quoted_from_name
        };

        maybeResolvePendingFromSocketMessage(normalized);
        const messageId = normalized.message_id || '';
        const existing = messageId
            ? chatMessagesPagination.items.find(item => (item.message_id || item.messageId) === messageId)
            : null;
        if (existing) {
            Object.assign(existing, normalized);
        } else {
            chatMessagesPagination.items.push(normalized);
        }

        upsertChatMessageRow(normalized, { animate: true });
    }

    scheduleChatsReload();
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

    const type = msg.type || 'chat';
    const mediaTypes = ['image', 'video', 'audio', 'ptt', 'document', 'sticker'];
    const hasMediaType = mediaTypes.includes(type);
    const isSystem = !mediaHtml && !msg.body && !hasMediaType && type !== 'chat';
    let textHtml = '';
    
    if (msg.body && (type === 'chat' || type === undefined)) {
        textHtml = '<div class="message-text">' + escapeHtml(msg.body) + '</div>';
    } else if (type === 'document' && mediaUrl) {
        const fileName = msg.body || 'Belge';
        textHtml = '<div class="message-text muted">[Dosya] ' + escapeHtml(fileName) + '</div>';
    } else if (hasMediaType && !mediaUrl) {
         // Loading State
         let iconClass = 'bi-file-earmark';
         let label = 'Dosya';
         if (type === 'image') { iconClass = 'bi-image'; label = 'Fotograf'; }
         else if (type === 'video') { iconClass = 'bi-camera-video'; label = 'Video'; }
         else if (type === 'audio' || type === 'ptt') { iconClass = 'bi-mic'; label = 'Ses'; }
         
         const fileName = msg.body || label;
         
         textHtml = `<div class="media-loading">
             <div class="loading-info">
                 <i class="bi ${iconClass} file-icon"></i>
                 <div class="loading-text">
                     <div>${escapeHtml(fileName)}</div>
                     <div style="font-size: 10px; opacity: 0.8;">Sunucuya indiriliyor...</div>
                 </div>
             </div>
             <div class="progress-track">
                 <div class="progress-bar"></div>
             </div>
         </div>`;
    } else if (hasMediaType) {
        textHtml = '<div class="message-text muted">[Medya]</div>';
    } else if (isSystem) {
        textHtml = '<div class="message-text muted">[Sistem: ' + escapeHtml(type) + ']</div>';
    } else if (!mediaHtml) {
        textHtml = '<div class="message-text muted">[Bos mesaj]</div>';
    }

    const displayName = getDisplayNameFromMessage(msg);
    const showSenderNames = isGroupChatId(msg.chatId || msg.chat_id || currentChat);
    const senderHtml = (!isMine && displayName && showSenderNames) ?
        '<div class="sender-name">' + escapeHtml(formatSenderName(displayName)) + '</div>' : '';

    const checkIcon = isMine && !isSystem ? getMessageStatusIcon(msg.ack || 0) : '';
    const time = msg.timestamp ? formatTime(msg.timestamp) : formatTime(Date.now());
    const messageIdAttr = escapeHtml(msg.messageId || msg.message_id || '');

    const messageHtml = '<div class="message-row ' + (isMine ? 'sent' : 'received') + '" data-message-id="' + messageIdAttr + '">' +
        '<div class="message-bubble ' + (isMine ? 'sent' : 'received') + '">' +
        senderHtml + mediaHtml + textHtml +
        '<div class="message-footer"><span class="message-time">' + time + '</span>' + checkIcon + '</div>' +
        '</div></div>';

    container.insertAdjacentHTML('beforeend', messageHtml);
    container.scrollTop = container.scrollHeight;
}

function handleMessageAck(payload) {
    if (!payload || !payload.messageId) return;
    const messageId = payload.messageId;
    const ack = payload.ack || 0;

    if (chatMessagesPagination.items.length) {
        chatMessagesPagination.items.forEach((item) => {
            const itemId = item.message_id || item.messageId;
            if (itemId === messageId) {
                item.ack = ack;
            }
        });
    }

    const rows = document.querySelectorAll('[data-message-id="' + CSS.escape(messageId) + '"]');
    rows.forEach((row) => {
        const footer = row.querySelector('.message-footer');
        if (!footer) return;
        footer.querySelectorAll('.check-icon').forEach((icon) => icon.remove());
        const checkIcon = getMessageStatusIcon(ack);
        if (checkIcon) {
            footer.insertAdjacentHTML('beforeend', checkIcon);
        }
    });
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
        const result = await api('api/sync/full', 'POST');
        if (!result.success) {
            showToast('Senkronizasyon hatasi: ' + result.error, 'error');
            return;
        }
        scheduleSyncProgressPoll();
    } catch (err) {
        showToast('Hata: ' + err.message, 'error');
    }
}

let syncProgressPoller = null;

function scheduleSyncProgressPoll() {
    if (syncProgressPoller) {
        clearInterval(syncProgressPoller);
    }
    syncProgressPoller = setInterval(loadSyncProgress, 5000);
    loadSyncProgress();
}

async function loadSyncProgress() {
    try {
        const progress = await api('api/sync/progress');
        updateSyncProgress(progress);
    } catch (e) {
        console.warn('Failed to load sync progress', e);
    }
}

function updateSyncProgress(progress) {
    if (!progress || progress.status === 'idle') return;
    console.log('Sync progress:', progress);

    if (progress.status === 'done') {
        if (syncProgressPoller) {
            clearInterval(syncProgressPoller);
            syncProgressPoller = null;
        }
        showToast('Senkronizasyon tamamlandi', 'success');
        loadChats();
        loadAllMessages();
    } else if (progress.status === 'failed') {
        if (syncProgressPoller) {
            clearInterval(syncProgressPoller);
            syncProgressPoller = null;
        }
        showToast('Senkronizasyon hatasi: ' + (progress.error || 'Bilinmeyen hata'), 'error');
    }
}

// Chat actions
function searchInChat() {
    showToast('Sohbette arama henuz desteklenmiyor', 'info');
}

async function refreshChat() {
    if (currentChat) {
        setListStatus('chatMessagesStatus', 'Yenileniyor...', true);
        try {
            // Refresh messages
            await loadChatMessages(currentChat);
            
            // Refresh profile picture
            await api('api/chats/' + encodeURIComponent(currentChat) + '/refresh-picture', 'POST');
            
            // Reload chat info to update UI
            loadChats();
            
            showToast('Sohbet ve profil fotografi yenilendi', 'success');
        } catch (e) {
            console.error(e);
            showToast('Yenileme kismen basarisiz oldu', 'warning');
        } finally {
            setListStatus('chatMessagesStatus', '', false);
        }
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

async function downloadAllMedia() {
    try {
        showToast('Tum sohbetlerde eksik medyalar kuyruga ekleniyor...', 'info');
        const result = await api('api/media/download-all', 'POST');
        if (result && typeof result.enqueued === 'number' && typeof result.found === 'number') {
            showToast(`Islem baslatildi: ${result.enqueued}/${result.found} dosya kuyruga eklendi.`, 'success');
            return;
        }
        showToast((result && result.message) ? result.message : 'Islem baslatildi.', 'success');
    } catch (err) {
        showToast('Islem baslatilamadi: ' + err.message, 'error');
    }
}

async function recoverMedia() {
    if (!currentChat) return;
    try {
        showToast('Eksik dosyalar araniyor ve indiriliyor...', 'info');
        await api('api/chats/' + encodeURIComponent(currentChat) + '/force-media', 'POST');
    } catch (err) {
        showToast('Islem baslatilamadi: ' + err.message, 'error');
    }
    document.querySelectorAll('.dropdown-menu.show').forEach(m => m.classList.remove('show'));
}

// Attachments
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
    if (!file.type.startsWith('image/') && attachmentSendMode === 'sticker') {
        attachmentSendMode = 'media';
        showToast('Sticker sadece resimler icin destekleniyor', 'info');
    }
    updateStickerButtonUI();
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
    const canSticker = selectedAttachment.type.startsWith('image/');
    const modeBadge = (canSticker && attachmentSendMode === 'sticker')
        ? '<span class="attachment-badge">Sticker</span>'
        : '';
    preview.style.display = 'flex';
    preview.innerHTML = `
        <div class="attachment-chip">
            <i class="bi bi-paperclip"></i>
            <span>${escapeHtml(selectedAttachment.name)}</span>
            ${modeBadge}
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

async function sendMessageWithAttachment(message, file, options = {}) {
    const formData = new FormData();
    formData.append('chatId', currentChat);
    formData.append('message', message || '');
    formData.append('media', file);
    if (options.quotedMessageId) {
        formData.append('quotedMessageId', String(options.quotedMessageId));
    }
    if (options.sendAsSticker) {
        formData.append('sendAsSticker', 'true');
    }

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

// Emoji Picker
const DEFAULT_EMOJIS = [
    '😀', '😁', '😂', '🤣', '😊', '😍', '😘', '😎',
    '🤔', '😅', '😇', '🥳', '😴', '😢', '😭', '😡',
    '👍', '👎', '🙏', '👏', '💪', '🔥', '🎉', '❤️',
    '💯', '✨', '✅', '❌', '⚡', '📌', '📎', '📷',
    '🎧', '🎁', '🧠', '💡', '🚀', '🌿', '🌙', '☀️'
];
const EMOJI_RECENTS_KEY = 'emojiRecents';
const EMOJI_RECENTS_MAX = 24;
let emojiPickerInitialized = false;

function initEmojiPicker() {
    const picker = document.getElementById('emojiPicker');
    if (!picker || emojiPickerInitialized) return;
    emojiPickerInitialized = true;
    renderEmojiPicker();
}

function getEmojiRecents() {
    try {
        const raw = localStorage.getItem(EMOJI_RECENTS_KEY);
        const parsed = raw ? JSON.parse(raw) : [];
        return Array.isArray(parsed) ? parsed.filter(Boolean).slice(0, EMOJI_RECENTS_MAX) : [];
    } catch (e) {
        return [];
    }
}

function setEmojiRecents(list) {
    try {
        localStorage.setItem(EMOJI_RECENTS_KEY, JSON.stringify(list.slice(0, EMOJI_RECENTS_MAX)));
    } catch (e) {}
}

function addEmojiRecent(emoji) {
    const value = String(emoji || '').trim();
    if (!value) return;
    const current = getEmojiRecents().filter(item => item !== value);
    current.unshift(value);
    setEmojiRecents(current);
}

function renderEmojiPicker() {
    const picker = document.getElementById('emojiPicker');
    if (!picker) return;
    const recents = getEmojiRecents();
    const combined = [...recents, ...DEFAULT_EMOJIS.filter(e => !recents.includes(e))];
    const buttons = combined
        .map((e) => '<button class="emoji-item" type="button" data-emoji="' + escapeHtml(e) + '">' + escapeHtml(e) + '</button>')
        .join('');
    picker.innerHTML = '<div class="emoji-grid">' + buttons + '</div>';

    picker.querySelectorAll('.emoji-item').forEach((btn) => {
        btn.addEventListener('click', (ev) => {
            ev.preventDefault();
            ev.stopPropagation();
            const emoji = btn.getAttribute('data-emoji') || btn.textContent || '';
            insertEmojiIntoMessageInput(emoji);
            addEmojiRecent(emoji);
            renderEmojiPicker();
        });
    });
}

function setEmojiButtonActive(active) {
    const btn = document.querySelector('.chat-input-area .emoji-btn');
    if (!btn) return;
    btn.classList.toggle('active', Boolean(active));
}

function isEmojiPickerOpen() {
    const picker = document.getElementById('emojiPicker');
    if (!picker) return false;
    return picker.style.display !== 'none';
}

function openEmojiPicker() {
    const picker = document.getElementById('emojiPicker');
    if (!picker) return;
    if (!emojiPickerInitialized) initEmojiPicker();
    picker.style.display = 'block';
    setEmojiButtonActive(true);
}

function closeEmojiPicker() {
    const picker = document.getElementById('emojiPicker');
    if (!picker) return;
    if (picker.style.display === 'none') return;
    picker.style.display = 'none';
    setEmojiButtonActive(false);
}

function toggleEmojiPicker() {
    if (isEmojiPickerOpen()) {
        closeEmojiPicker();
        return;
    }
    openEmojiPicker();
}

function insertEmojiIntoMessageInput(emoji) {
    const input = document.getElementById('messageInput');
    if (!input) return;
    const value = String(emoji || '');
    if (!value) return;

    const start = Number.isFinite(input.selectionStart) ? input.selectionStart : input.value.length;
    const end = Number.isFinite(input.selectionEnd) ? input.selectionEnd : input.value.length;
    input.value = input.value.slice(0, start) + value + input.value.slice(end);
    const nextPos = start + value.length;
    try {
        input.selectionStart = nextPos;
        input.selectionEnd = nextPos;
    } catch (e) {}
    autoResizeInput(input);
    input.focus();
}

// Sticker Mode
function updateStickerButtonUI() {
    const btn = document.querySelector('.chat-input-area .sticker-btn');
    if (!btn) return;
    btn.classList.toggle('active', attachmentSendMode === 'sticker');
}

function toggleStickerMode() {
    attachmentSendMode = attachmentSendMode === 'sticker' ? 'media' : 'sticker';
    updateStickerButtonUI();
    renderAttachmentPreview();

    if (attachmentSendMode === 'sticker') {
        if (selectedAttachment && !selectedAttachment.type.startsWith('image/')) {
            showToast('Sticker icin resim secin', 'info');
            toggleAttachMenu();
            return;
        }
        if (!selectedAttachment) {
            showToast('Sticker icin resim secin', 'info');
            toggleAttachMenu();
            return;
        }
        showToast('Sticker olarak gonderilecek', 'info');
    }
}

// Functions referenced via inline/dynamic onclick handlers
window.setReplyTargetFromButton = setReplyTargetFromButton;
window.scrollToMessage = scrollToMessage;
window.toggleStickerMode = toggleStickerMode;

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

function handleMediaDownloaded(payload) {
    if (!payload || !payload.messageId || !payload.mediaUrl) return;
    
    const messageId = payload.messageId;
    const mediaUrl = payload.mediaUrl;
    const container = document.getElementById('messagesContainer');
    const shouldStickToBottom = container ? isChatNearBottom(container, 160) : false;
    
    // Update data model
    const item = chatMessagesPagination.items.find(m => (m.message_id || m.messageId) === messageId);
    if (item) {
        item.media_url = mediaUrl;
        item.mediaUrl = mediaUrl;
    }
    
    // Update DOM
    const row = document.querySelector(`[data-message-id="${CSS.escape(messageId)}"]`);
    if (!row) return;
    
    const bubble = row.querySelector('.message-bubble');
    if (!bubble) return;
    
    // Remove existing "Media" or "Dosya" text if simple placeholder
    const mutedText = bubble.querySelector('.message-text.muted');
    const loadingEl = bubble.querySelector('.media-loading');
    
    if (mutedText && mutedText.textContent.includes('[Medya]')) {
        mutedText.remove();
    }
    
    // Insert new media content
    let mediaHtml = '';
    const type = item ? item.type : 'image'; // fallback
    const safeMediaUrl = sanitizeUrl(mediaUrl);
    
    if (safeMediaUrl) {
        if (type === 'image' || type === 'sticker') {
            mediaHtml = `<div class="message-media"><img src="${safeMediaUrl}" onclick="openMediaLightbox(this.src)" loading="lazy" alt=""></div>`;
        } else if (type === 'video') {
            mediaHtml = `<div class="message-media"><video src="${safeMediaUrl}" controls></video></div>`;
        } else if (type === 'audio' || type === 'ptt') {
            mediaHtml = `<div class="message-media"><audio src="${safeMediaUrl}" controls></audio></div>`;
        } else if (type === 'document') {
            // For document, we might want to replace the whole bubble content or just add the icon
            // If text was "[Dosya] filename", we transform it to clickable bubble
            // But usually document structure is different. 
            // Let's just reload the chat messages for this chat if it's open, it's easier and cleaner
            if (currentChat && (item && item.chat_id === currentChat)) {
                // If we are looking at this chat, reload to render properly
                // Or smarter: rerender just this message
                // Construct a fake message object with new URL
                const msgObj = item || { 
                    is_from_me: row.classList.contains('sent'), 
                    timestamp: Date.now(), 
                    type: type,
                    media_url: mediaUrl,
                    body: bubble.textContent 
                };
                
                // Use existing render logic? No, too complex to extract.
                // Simple replacement for document:
                const fileName = msgObj.body || 'Belge';
                mediaHtml = `<div class="document-bubble" onclick="window.open('${safeMediaUrl}')">` +
                        `<div class="doc-icon pdf"><i class="bi bi-file-earmark-pdf"></i></div>` +
                        `<div class="doc-info"><div class="doc-name">${escapeHtml(fileName)}</div>` +
                        `<div class="doc-size">Indir</div></div></div>`;
                
                // If there was a text placeholder, replace it
                if (mutedText) {
                    mutedText.outerHTML = mediaHtml;
                    if (container && shouldStickToBottom) ensureChatScrolledToBottom(container);
                    return; // Done
                }
                // If there was a loading placeholder, replace it
                if (loadingEl) {
                    loadingEl.outerHTML = mediaHtml;
                    if (container && shouldStickToBottom) ensureChatScrolledToBottom(container);
                    return;
                }
            }
        }
        
        if (mediaHtml) {
            if (loadingEl) {
                loadingEl.outerHTML = mediaHtml;
            } else {
                const senderName = bubble.querySelector('.sender-name');
                if (senderName) {
                    senderName.insertAdjacentHTML('afterend', mediaHtml);
                } else {
                    bubble.insertAdjacentHTML('afterbegin', mediaHtml);
                }
            }
        }
    }

    if (container && shouldStickToBottom) {
        ensureChatScrolledToBottom(container);
        const img = row.querySelector('.message-media img');
        if (img && img.dataset.stickToBottomBound !== '1') {
            img.dataset.stickToBottomBound = '1';
            img.addEventListener('load', () => {
                if (shouldKeepChatAutoScrolled(container)) {
                    scrollMessagesToBottom(container);
                }
            }, { once: true });
        }
    }
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
        case 'templates':
            title = 'Mesaj Sablonlari';
            content = getTemplatesContent();
            loadTemplatesData();
            break;
        case 'template-picker':
            title = 'Sablon Sec';
            content = getTemplatePickerContent();
            loadTemplatePickerData();
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
    return '<div style="margin-bottom: 16px; display: flex; gap: 10px;">' +
        '<button class="btn btn-primary" onclick="showScriptEditor()"><i class="bi bi-plus"></i> Yeni Script</button>' +
        '<button class="btn btn-secondary" onclick="openGeminiAssistant()" style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); border: none;"><i class="bi bi-stars"></i> AI Asistan</button>' +
        '</div>' +
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

// Templates Content
function getTemplatesContent() {
    return '<form id="templateFormModal" onsubmit="submitTemplate(event)" style="margin-bottom: 20px; padding: 16px; background: var(--bg-secondary); border-radius: 8px;">' +
        '<div class="form-group"><label class="form-label">Sablon Adi</label><input type="text" class="form-input" id="templateNameModal" required></div>' +
        '<div class="form-group"><label class="form-label">Kategori</label><input type="text" class="form-input" id="templateCategoryModal" placeholder="Kampanya, Bilgilendirme..."></div>' +
        '<div class="form-group"><label class="form-label">Degiskenler (virgulle ayir)</label><input type="text" class="form-input" id="templateVariablesModal" placeholder="name, message, date"></div>' +
        '<div class="form-group"><label class="form-label">Icerik</label><textarea class="form-input" id="templateContentModal" rows="4" required></textarea></div>' +
        '<div style="display: flex; gap: 8px;">' +
            '<button type="submit" class="btn btn-primary" id="templateSubmitButton">Kaydet</button>' +
            '<button type="button" class="btn" onclick="resetTemplateForm()">Vazgec</button>' +
        '</div>' +
        '<div style="margin-top: 8px; color: var(--text-secondary); font-size: 12px;">Desteklenen degiskenler: {name}, {message}, {date}, {time}, {chatId}, {chatName}</div>' +
        '</form>' +
        '<div id="templatesListModal"></div>';
}

function getTemplatePickerContent() {
    return '<div id="templatePickerListModal"></div>';
}

async function loadTemplatesCache() {
    try {
        templates = await api('api/templates');
    } catch (err) {
        console.error('Templates load error:', err);
        templates = [];
    }
    return templates;
}

function parseTemplateVariables(template) {
    if (!template || !template.variables) return [];
    try {
        const parsed = JSON.parse(template.variables);
        if (Array.isArray(parsed)) return parsed;
    } catch (err) {
        console.warn('Template variables parse failed:', err);
    }
    return [];
}

async function loadTemplatesData() {
    const templateList = await loadTemplatesCache();
    const container = document.getElementById('templatesListModal');
    if (!container) return;

    if (templateList.length === 0) {
        container.innerHTML = '<p style="color: var(--text-secondary)">Henuz sablon yok</p>';
        return;
    }

    container.innerHTML = templateList.map(template => {
        const variables = parseTemplateVariables(template);
        const variableText = variables.length ? variables.join(', ') : 'Yok';
        const categoryText = template.category ? template.category : 'Kategori yok';
        return '<div class="settings-item" style="border: 1px solid var(--border-color); border-radius: 8px; margin-bottom: 8px; padding: 12px;">' +
            '<div class="info" style="flex: 1;">' +
                '<div class="title">' + escapeHtml(template.name) + '</div>' +
                '<div class="subtitle">' + escapeHtml(categoryText) + ' • ' + escapeHtml(variableText) + '</div>' +
                '<div class="subtitle">' + escapeHtml(template.content.substring(0, 80)) + '</div>' +
            '</div>' +
            '<button class="icon-btn" onclick="startTemplateEdit(' + template.id + ')" title="Duzenle"><i class="bi bi-pencil"></i></button>' +
            '<button class="icon-btn" onclick="deleteTemplate(' + template.id + ')" title="Sil"><i class="bi bi-trash" style="color: #f15c6d;"></i></button>' +
            '</div>';
    }).join('');
}

async function loadTemplatePickerData() {
    const templateList = await loadTemplatesCache();
    const container = document.getElementById('templatePickerListModal');
    if (!container) return;

    if (templateList.length === 0) {
        container.innerHTML = '<p style="color: var(--text-secondary)">Henuz sablon yok</p>';
        return;
    }

    container.innerHTML = templateList.map(template => {
        return '<div class="settings-item" style="border: 1px solid var(--border-color); border-radius: 8px; margin-bottom: 8px; padding: 12px;">' +
            '<div class="info" style="flex: 1;">' +
                '<div class="title">' + escapeHtml(template.name) + '</div>' +
                '<div class="subtitle">' + escapeHtml(template.content.substring(0, 80)) + '</div>' +
            '</div>' +
            '<button class="btn btn-primary" onclick="useTemplate(' + template.id + ')">Sec</button>' +
            '</div>';
    }).join('');
}

function startTemplateEdit(id) {
    const template = templates.find(item => item.id === id);
    if (!template) return;
    editingTemplateId = id;
    document.getElementById('templateNameModal').value = template.name || '';
    document.getElementById('templateCategoryModal').value = template.category || '';
    document.getElementById('templateVariablesModal').value = parseTemplateVariables(template).join(', ');
    document.getElementById('templateContentModal').value = template.content || '';
    const submitButton = document.getElementById('templateSubmitButton');
    if (submitButton) submitButton.textContent = 'Guncelle';
}

function resetTemplateForm() {
    editingTemplateId = null;
    const form = document.getElementById('templateFormModal');
    if (form) {
        form.reset();
    }
    const submitButton = document.getElementById('templateSubmitButton');
    if (submitButton) submitButton.textContent = 'Kaydet';
}

async function submitTemplate(event) {
    event.preventDefault();
    const payload = {
        name: document.getElementById('templateNameModal').value,
        category: document.getElementById('templateCategoryModal').value,
        variables: document.getElementById('templateVariablesModal').value,
        content: document.getElementById('templateContentModal').value
    };
    try {
        if (editingTemplateId) {
            await api('api/templates/' + editingTemplateId, 'PUT', payload);
            showToast('Sablon guncellendi', 'success');
        } else {
            await api('api/templates', 'POST', payload);
            showToast('Sablon eklendi', 'success');
        }
        resetTemplateForm();
        loadTemplatesData();
    } catch (err) {
        showToast('Hata: ' + err.message, 'error');
    }
}

async function deleteTemplate(id) {
    try {
        await api('api/templates/' + id, 'DELETE');
        showToast('Sablon silindi', 'success');
        if (editingTemplateId === id) {
            resetTemplateForm();
        }
        loadTemplatesData();
    } catch (err) {
        showToast('Hata: ' + err.message, 'error');
    }
}

function populateTemplateSelect(selectId, templateList = templates) {
    const select = document.getElementById(selectId);
    if (!select) return;
    const currentValue = select.value;
    const options = ['<option value="">Sablon sec (opsiyonel)</option>'].concat(
        templateList.map(template => '<option value="' + template.id + '">' + escapeHtml(template.name) + '</option>')
    );
    select.innerHTML = options.join('');
    if (currentValue) {
        select.value = currentValue;
    }
}

function handleScheduledTemplateChange() {
    const select = document.getElementById('schedTemplateIdModal');
    const messageInput = document.getElementById('schedMessageModal');
    if (!select || !messageInput) return;
    const templateId = select.value;
    const template = templates.find(item => String(item.id) === String(templateId));
    if (template) {
        messageInput.value = template.content;
    }
}

function getScheduledPreviewText(scheduleItem, templateMap) {
    if (scheduleItem.template_id) {
        const template = templateMap.get(String(scheduleItem.template_id));
        if (template) {
            return '[Sablon] ' + (template.name || '');
        }
    }
    return (scheduleItem.message || '').substring(0, 50);
}

function openTemplatePicker() {
    if (!currentChat) {
        showToast('Once bir sohbet secin', 'info');
        return;
    }
    showModal('template-picker');
}

function useTemplate(id) {
    const template = templates.find(item => item.id === id);
    if (!template) return;
    const input = document.getElementById('messageInput');
    if (input) {
        input.value = template.content || '';
        autoResizeInput(input);
        input.focus();
    }
    closeModal();
}

// Scheduled Content
function getScheduledContent() {
    return '<form id="scheduledFormModal" onsubmit="submitScheduled(event)" style="margin-bottom: 20px; padding: 16px; background: var(--bg-secondary); border-radius: 8px;">' +
        '<div class="form-group"><label class="form-label">Sohbet ID</label><input type="text" class="form-input" id="schedChatIdModal" placeholder="905xxxxxxxxxx@c.us" required></div>' +
        '<div class="form-group"><label class="form-label">Sohbet Adi</label><input type="text" class="form-input" id="schedChatNameModal" required></div>' +
        '<div class="form-group"><label class="form-label">Mesaj Sablonu</label><select class="form-input" id="schedTemplateIdModal" onchange="handleScheduledTemplateChange()"><option value="">Sablon sec (opsiyonel)</option></select></div>' +
        '<div class="form-group"><label class="form-label">Mesaj</label><textarea class="form-input" id="schedMessageModal" rows="3" placeholder="Sablon secerseniz otomatik doldurulur"></textarea></div>' +
        '<div class="form-group"><label class="form-label">Gonderim Zamani</label><input type="datetime-local" class="form-input" id="schedTimeModal" required></div>' +
        '<button type="submit" class="btn btn-primary">Zamanla</button>' +
        '</form>' +
        '<div id="scheduledListModal"></div>';
}

async function submitScheduled(event) {
    event.preventDefault();
    const templateId = document.getElementById('schedTemplateIdModal').value;
    const data = {
        chat_id: document.getElementById('schedChatIdModal').value,
        chat_name: document.getElementById('schedChatNameModal').value,
        message: document.getElementById('schedMessageModal').value,
        template_id: templateId || null,
        scheduled_at: document.getElementById('schedTimeModal').value
    };
    if (!data.message && !data.template_id) {
        showToast('Mesaj ya da sablon secmelisiniz', 'info');
        return;
    }
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
        const templateList = await loadTemplatesCache();
        populateTemplateSelect('schedTemplateIdModal', templateList);
        const container = document.getElementById('scheduledListModal');
        if (!container) return;

        if (scheduled.length === 0) {
            container.innerHTML = '<p style="color: var(--text-secondary)">Henuz zamanli mesaj yok</p>';
            return;
        }

        const templateMap = new Map(templateList.map(template => [String(template.id), template]));

        container.innerHTML = scheduled.map(s =>
            '<div class="settings-item" style="border: 1px solid var(--border-color); border-radius: 8px; margin-bottom: 8px; padding: 12px;">' +
            '<div class="info" style="flex: 1;">' +
                '<div class="title">' + escapeHtml(s.chat_name || s.chat_id) + '</div>' +
                '<div class="subtitle">' + escapeHtml(getScheduledPreviewText(s, templateMap)) + ' - ' + formatDateTime(s.scheduled_at) + '</div>' +
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
function getMessageStatusIcon(ack) {
    // 0: Pending, 1: Sent, 2: Received, 3: Read, 4: Played
    if (ack === 3 || ack === 4) return '<i class="bi bi-check2-all check-icon read" style="color: #53bdeb;"></i>';
    if (ack === 2) return '<i class="bi bi-check2-all check-icon" style="color: #999;"></i>';
    if (ack === 1) return '<i class="bi bi-check2 check-icon" style="color: #999;"></i>';
    return '<i class="bi bi-clock check-icon" style="color: #999;"></i>';
}

function getMessagePreviewText(message) {
    if (!message) return '[Bos mesaj]';
    const body = message.body || message.message || '';
    if (body) return body;
    const type = message.type || 'chat';
    if (type === 'document') return '[Dosya]';
    if (['image', 'video', 'audio', 'ptt', 'sticker'].includes(type)) return '[Medya]';
    if (type && type !== 'chat') return '[Sistem: ' + type + ']';
    return '[Bos mesaj]';
}

function isGroupChatId(chatId) {
    return typeof chatId === 'string' && chatId.includes('@g.us');
}

function escapeHtml(text) {
    if (!text) return '';
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

function normalizeTimestamp(value) {
    if (value === undefined || value === null || value === '') return null;

    if (value instanceof Date) {
        const ms = value.getTime();
        return Number.isFinite(ms) ? ms : null;
    }

    if (typeof value === 'number') {
        if (!Number.isFinite(value)) return null;
        // Heuristic: treat < 1e12 as epoch seconds
        return value < 1e12 ? value * 1000 : value;
    }

    const raw = String(value).trim();
    if (!raw) return null;

    if (/^\\d+$/.test(raw)) {
        const asNumber = Number(raw);
        if (!Number.isFinite(asNumber)) return null;
        return asNumber < 1e12 ? asNumber * 1000 : asNumber;
    }

    // SQLite DATETIME (UTC): "YYYY-MM-DD HH:MM:SS"
    if (/^\\d{4}-\\d{2}-\\d{2} \\d{2}:\\d{2}:\\d{2}/.test(raw)) {
        const iso = raw.replace(' ', 'T') + 'Z';
        const parsed = Date.parse(iso);
        return Number.isFinite(parsed) ? parsed : null;
    }

    const parsed = Date.parse(raw);
    return Number.isFinite(parsed) ? parsed : null;
}

function normalizeLinkHref(raw) {
    const input = typeof raw === 'string' ? raw.trim() : String(raw || '').trim();
    if (!input) return null;

    let candidate = input;
    if (!/^https?:\/\//i.test(candidate)) {
        const domainLike = /^(?:[a-z0-9-]+\.)+[a-z]{2,}(?::\d{1,5})?(?:\/\S*)?$/i.test(candidate);
        if (candidate.toLowerCase().startsWith('www.') || domainLike) {
            candidate = 'https://' + candidate;
        } else {
            return null;
        }
    }

    try {
        const parsed = new URL(candidate);
        if (!['http:', 'https:'].includes(parsed.protocol)) return null;
        return parsed.toString();
    } catch (e) {
        return null;
    }
}

function linkifyTextToHtml(text) {
    if (!text) return '';
    const input = String(text);

    // Very simple URL detector: http(s)://, www., or bare domain.tld[/path]
    const urlRegex = /(?:https?:\/\/[^\s]+|www\.[^\s]+|(?:[a-z0-9-]+\.)+[a-z]{2,}(?::\d{1,5})?(?:\/[^\s]*)?)/ig;
    const parts = [];
    let lastIndex = 0;

    for (let match; (match = urlRegex.exec(input)) !== null;) {
        const raw = match[0];
        const start = match.index;
        if (start > lastIndex) {
            parts.push({ type: 'text', value: input.slice(lastIndex, start) });
        }

        let urlText = raw;
        let trailing = '';
        while (urlText && /[),.!?;:'"\]]$/.test(urlText)) {
            trailing = urlText.slice(-1) + trailing;
            urlText = urlText.slice(0, -1);
        }

        const href = normalizeLinkHref(urlText);
        if (href) {
            parts.push({ type: 'link', href, text: urlText });
        } else {
            parts.push({ type: 'text', value: raw });
        }

        if (trailing) {
            parts.push({ type: 'text', value: trailing });
        }

        lastIndex = start + raw.length;
    }

    if (lastIndex < input.length) {
        parts.push({ type: 'text', value: input.slice(lastIndex) });
    }

    return parts.map((part) => {
        if (part.type === 'text') {
            return escapeHtml(part.value);
        }
        const safeHref = escapeHtml(part.href);
        return '<a class="message-link" href="' + safeHref + '" target="_blank" rel="noopener noreferrer" onclick="event.stopPropagation()">' +
            escapeHtml(part.text) +
        '</a>';
    }).join('');
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

function scrollMessagesToBottom(container) {
    if (!container) return;
    container.scrollTop = container.scrollHeight;
    const last = container.lastElementChild;
    if (last && typeof last.scrollIntoView === 'function') {
        try {
            last.scrollIntoView({ block: 'end', inline: 'nearest' });
        } catch (e) {}
    }
    container.dataset.autoScrollTop = String(container.scrollTop);
}

function bindChatMediaAutoScroll(container) {
    if (!container) return;
    const elements = container.querySelectorAll('.message-media img, .message-media video');
    elements.forEach((el) => {
        if (!el || el.dataset.autoScrollBound === '1') return;
        el.dataset.autoScrollBound = '1';
        const eventName = el.tagName === 'VIDEO' ? 'loadedmetadata' : 'load';
        el.addEventListener(eventName, () => {
            if (shouldKeepChatAutoScrolled(container)) {
                scrollMessagesToBottom(container);
            }
        }, { once: true });
    });
}

function isChatNearBottom(container, thresholdPx = 120) {
    if (!container) return false;
    const distance = container.scrollHeight - container.scrollTop - container.clientHeight;
    return distance <= thresholdPx;
}

function shouldKeepChatAutoScrolled(container) {
    if (!container) return false;
    const lastTop = Number(container.dataset.autoScrollTop || NaN);
    if (!Number.isFinite(lastTop)) return true;
    return container.scrollTop >= (lastTop - 32);
}

function ensureChatScrolledToBottom(container, options = {}) {
    if (!container) return;
    const attempts = Number.isFinite(options.attempts) ? options.attempts : 10;
    const intervalMs = Number.isFinite(options.intervalMs) ? options.intervalMs : 150;
    const seq = String(++chatAutoScrollSeq);
    container.dataset.autoScrollSeq = seq;

    const step = (remaining) => {
        if (!container || container.dataset.autoScrollSeq !== seq) return;
        if (!shouldKeepChatAutoScrolled(container)) return;
        scrollMessagesToBottom(container);
        if (remaining <= 1) return;
        setTimeout(() => step(remaining - 1), intervalMs);
    };

    const raf = (window.requestAnimationFrame || ((cb) => setTimeout(cb, 0)));
    raf(() => step(attempts));
}

function formatSenderName(name) {
    if (!name) return '';
    let normalized = String(name);
    if (normalized.includes('@')) {
        normalized = normalized.split('@')[0];
    }
    normalized = normalized.trim();
    if (/^\d{7,16}$/.test(normalized)) {
        return '+' + normalized;
    }
    return normalized;
}

function looksLikeGroupInternalId(value) {
    const v = String(value || '').trim();
    if (!v) return false;
    if (!v.includes('-')) return false;
    // Typical WhatsApp group internal IDs look like "<digits>-<digits>"
    return /^\d{8,}-\d{3,}$/.test(v);
}

function getDisplayNameFromMessage(message, chatIdForContext) {
    if (!message) return '';
    const isGroup = isGroupChatId(chatIdForContext || message.chat_id || message.chatId || currentChat);
    const name = String(message.from_name || message.fromName || '').trim();
    const number = String(message.from_number || message.fromNumber || '').trim();
    const from = String(message.from || '').trim();

    if (isGroup) {
        if (name && looksLikeGroupInternalId(name) && number) return number;
        if (name && name.toLowerCase() === 'unknown' && number) return number;
    }

    return name || number || from || '';
}

function getSenderContactIdFromMessage(message, chatIdForContext) {
    if (!message) return '';
    const isGroup = isGroupChatId(chatIdForContext || message.chat_id || message.chatId || currentChat);
    if (!isGroup) return '';

    const rawNumber = String(message.from_number || message.fromNumber || '').trim();
    if (rawNumber) {
        if (rawNumber.includes('@')) return rawNumber;
        if (/^\d{7,16}$/.test(rawNumber)) return rawNumber + '@c.us';
    }

    const rawName = String(message.from_name || message.fromName || '').trim();
    if (rawName && rawName.includes('@')) return rawName;

    return '';
}

function getInitials(value) {
    const raw = String(value || '').trim();
    if (!raw) return '?';
    const cleaned = formatSenderName(raw);
    const parts = cleaned.split(/\s+/).filter(Boolean);
    if (!parts.length) return '?';
    if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
    return (parts[0][0] + parts[1][0]).toUpperCase();
}

function isSenderProfilePicCacheFresh(contactId) {
    const entry = senderProfilePicCache.get(contactId);
    if (!entry || typeof entry !== 'object') return false;
    const ageMs = Date.now() - (entry.fetchedAt || 0);
    const ttlMs = entry.url ? SENDER_PROFILE_PIC_TTL_MS : SENDER_PROFILE_PIC_NULL_TTL_MS;
    if (ageMs > ttlMs) {
        senderProfilePicCache.delete(contactId);
        return false;
    }
    return true;
}

function getCachedSenderProfilePicUrl(contactId) {
    if (!isSenderProfilePicCacheFresh(contactId)) return null;
    const entry = senderProfilePicCache.get(contactId);
    return (entry && entry.url) ? entry.url : null;
}

function updateSenderNameElements(contactId, displayName) {
    const name = String(displayName || '').trim();
    if (!contactId || !name) return;
    const escaped = (window.CSS && CSS.escape) ? CSS.escape(contactId) : contactId;
    document.querySelectorAll('.sender-name[data-sender-id="' + escaped + '"]').forEach((node) => {
        node.textContent = formatSenderName(name);
    });
}

function updateSenderAvatarNameAttributes(contactId, displayName) {
    const name = String(displayName || '').trim();
    if (!contactId || !name) return;
    const escaped = (window.CSS && CSS.escape) ? CSS.escape(contactId) : contactId;
    document.querySelectorAll('.sender-avatar[data-sender-id="' + escaped + '"]').forEach((node) => {
        node.setAttribute('data-sender-name', name);
    });
}

function updateSenderAvatarElements(contactId) {
    if (!contactId) return;
    const escaped = (window.CSS && CSS.escape) ? CSS.escape(contactId) : contactId;
    const nodes = document.querySelectorAll('.sender-avatar[data-sender-id="' + escaped + '"]');
    if (!nodes.length) return;

    const cached = getCachedSenderProfilePicUrl(contactId);
    nodes.forEach((node) => {
        if (node.classList.contains('spacer')) return;
        const safeUrl = cached ? sanitizeUrl(cached) : '';
        if (safeUrl) {
            node.innerHTML = '<img src="' + safeUrl + '" alt="" loading="lazy">';
            const img = node.querySelector('img');
            if (img) {
                img.onerror = () => {
                    if (node.getAttribute('data-avatar-download-tried') !== '1') {
                        node.setAttribute('data-avatar-download-tried', '1');
                        fetchSenderProfilePic(contactId, { download: true, bypassCache: true });
                        return;
                    }
                    const name = node.getAttribute('data-sender-name') || '';
                    node.innerHTML = '<span class="sender-avatar-initials">' + escapeHtml(getInitials(name || contactId)) + '</span>';
                };
            }
            return;
        }
        const name = node.getAttribute('data-sender-name') || '';
        node.innerHTML = '<span class="sender-avatar-initials">' + escapeHtml(getInitials(name || contactId)) + '</span>';
    });
}

async function fetchSenderProfilePic(contactId, options = {}) {
    if (!contactId) return;
    if (senderProfilePicPending.has(contactId) || (!options.bypassCache && isSenderProfilePicCacheFresh(contactId))) return;
    senderProfilePicPending.add(contactId);
    try {
        const qs = [];
        if (options.download) qs.push('download=1');
        if (options.bypassCache) qs.push('bypassCache=1');
        const urlPath = 'api/contacts/' + encodeURIComponent(contactId) + '/profile-picture' + (qs.length ? ('?' + qs.join('&')) : '');
        const result = await api(urlPath);
        const url = result && result.success ? (result.url || null) : null;
        const displayName = result && result.displayName ? String(result.displayName) : '';
        senderProfilePicCache.set(contactId, { url, fetchedAt: Date.now() });
        if (displayName) {
            updateSenderAvatarNameAttributes(contactId, displayName);
            updateSenderNameElements(contactId, displayName);
        }
    } catch (e) {
        senderProfilePicCache.set(contactId, { url: null, fetchedAt: Date.now() });
    } finally {
        senderProfilePicPending.delete(contactId);
        updateSenderAvatarElements(contactId);
    }
}

function renderSenderAvatar(contactId, displayName, showSenderMeta) {
    const id = String(contactId || '').trim();
    const name = String(displayName || '').trim();
    const className = 'sender-avatar' + (showSenderMeta ? '' : ' spacer');

    let inner = '';
    if (showSenderMeta) {
        const cached = id ? getCachedSenderProfilePicUrl(id) : null;
        const safeUrl = cached ? sanitizeUrl(cached) : '';
        if (safeUrl) {
            inner = '<img src="' + safeUrl + '" alt="">';
        } else {
            inner = '<span class="sender-avatar-initials">' + escapeHtml(getInitials(name || id)) + '</span>';
        }

        if (id && !isSenderProfilePicCacheFresh(id) && !senderProfilePicPending.has(id)) {
            fetchSenderProfilePic(id);
        }
    }

    return '<div class="' + className + '" data-sender-id="' + escapeHtml(id) + '" data-sender-name="' + escapeHtml(name) + '">' +
        inner +
        '</div>';
}

function formatTime(ts) {
    const ms = normalizeTimestamp(ts);
    if (!ms) return '';
    const date = new Date(ms);
    const now = new Date();
    const isToday = date.toDateString() === now.toDateString();

    if (isToday) {
        return date.toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' });
    }
    return date.toLocaleDateString('tr-TR', { day: '2-digit', month: '2-digit' });
}

function formatDateTime(ts) {
    const ms = normalizeTimestamp(ts);
    if (!ms) return '';
    return new Date(ms).toLocaleString('tr-TR');
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

Object.assign(window, {
    toggleTheme,
    updateAccentColor,
    updateWallpaperChoice,
    updateFontSize,
    toggleCompactMode,
    updateBubbleStyle,
    toggleChatMetaPanel,
    updateAppSurfaceOpacity,
    updateDesktopBackgroundType,
    updateDesktopBackgroundImage,
    updateDesktopBackgroundColor,
    updateDesktopBackgroundGradient,
    updateDesktopBackgroundGradientCustom,
    updateBackgroundType,
    updateBackgroundImage,
    updateBackgroundColor,
    updateBackgroundGradient,
    updateBackgroundGradientCustom,
    updateBackgroundOpacity,
    createAccount,
    openSettings,
    openFeatures,
    closeFeatures,
    toggleDropdown,
    switchSidebarTab,
    showTab,
    openReports,
    toggleSetting,
    openChatForMessage,
    filterChats,
    handleInputKeydown,
    addTagToChat,
    removeTagFromChat,
    addNoteToChat,
    editNote,
    deleteNote,
    appendNewMessage,
    reconnect,
    disconnect,
    startSync,
    searchInChat,
    refreshChat,
    downloadAllMedia,
    recoverMedia,
    exportChat,
    clearChat,
    toggleEmojiPicker,
    toggleAttachMenu,
    openMediaLightbox,
    submitAutoReply,
    startTemplateEdit,
    submitTemplate,
    deleteTemplate,
    handleScheduledTemplateChange,
    openTemplatePicker,
    useTemplate,
    submitScheduled,
    submitWebhook,
    showWebhookDetails,
    replayWebhookDelivery,
    submitRole,
    deleteRole,
    submitUser,
    assignUserRole,
    deleteUser,
    migrateToDrive,
    saveScriptCode,
    testScriptCode,
    toggleAutoReply,
    deleteAutoReply,
    deleteScheduled,
    deleteWebhook,
    editScript,
    toggleScript,
    deleteScript,
    logout,
    api,
    showToast,
    closeModal,
    loadScriptsData
});
