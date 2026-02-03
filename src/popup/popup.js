/**
 * CloudClip Popup JavaScript
 * Handles UI logic, authentication, and clipboard management
 */

import { getSupabaseClient, getSession, isAuthenticated, onAuthStateChange } from '../lib/supabase-client.js';
import { signIn, signUp, signOut, deleteAllUserData, getCurrentUser } from '../lib/auth.js';
import { getDeviceId, getDeviceName, setDeviceName } from '../lib/device.js';
import { fetchClipboardItems, deleteClipboardItem, getCachedItems, uploadClipboardItem } from '../lib/sync.js';
import { CONFIG } from '../config.js';

// =============================================================================
// STATE
// =============================================================================
const state = {
    currentScreen: 'loading',
    authMode: 'login',
    onboardingSlide: 0,
    clipboardItems: [],
    searchQuery: '',
    isLoading: false,
    longPressTimer: null,
    longPressItemId: null,
};

// =============================================================================
// INITIALIZATION
// =============================================================================

/**
 * Initialize the popup
 */
async function init() {
    try {
        // Set up event listeners
        setupEventListeners();

        // Listen for storage changes so UI stays updated after restart
        chrome.storage.onChanged.addListener(handleStorageChange);

        // Check authentication state
        const authenticated = await isAuthenticated();
        console.log('CloudClip:DEBUG popup init', { authenticated });

        if (!authenticated) {
            // Check if onboarding is complete
            const onboardingComplete = await getOnboardingStatus();

            if (onboardingComplete) {
                showScreen('auth');
            } else {
                showScreen('onboarding');
            }
        } else {
            await loadMainScreen();
        }

        // Listen for auth changes
        onAuthStateChange(handleAuthChange);

        // Listen for messages from background
        chrome.runtime.onMessage.addListener(handleBackgroundMessage);
        console.log('CloudClip:DEBUG popup listeners registered');

    } catch (err) {
        console.error('Popup init error:', err);
        console.error('CloudClip:DEBUG popup init error', err);

        // Check if it's a configuration error
        if (err.message?.includes('not configured')) {
            showScreen('auth');
            const errorEl = document.getElementById('auth-error');
            if (errorEl) {
                errorEl.textContent = 'Supabase not configured. Please update src/config.js with your credentials.';
            }
        } else {
            showToast('Failed to initialize. Please try again.', 'error');
            showScreen('auth');
        }
    }
}

/**
 * Hydrate clipboard items from local cache
 */
async function hydrateFromCache() {
    const cached = await getCachedItems();
    if (Array.isArray(cached) && cached.length > 0) {
        state.clipboardItems = cached;
        renderClipboardItems();
    }
}

/**
 * Handle storage changes (durable UI updates)
 * @param {Object} changes
 * @param {string} area
 */
function handleStorageChange(changes, area) {
    if (area !== 'local') return;

    const cacheKey = CONFIG.STORAGE_KEYS.CACHED_ITEMS;
    if (changes[cacheKey]) {
        state.clipboardItems = changes[cacheKey].newValue || [];
        renderClipboardItems();
    }
}

/**
 * Get onboarding status from storage
 */
async function getOnboardingStatus() {
    const key = CONFIG.STORAGE_KEYS.ONBOARDING_COMPLETE;
    const result = await chrome.storage.local.get(key);
    return result[key] === true;
}

/**
 * Set onboarding status
 */
async function setOnboardingStatus(complete) {
    await chrome.storage.local.set({
        [CONFIG.STORAGE_KEYS.ONBOARDING_COMPLETE]: complete
    });
}

// =============================================================================
// SCREEN MANAGEMENT
// =============================================================================

/**
 * Show a specific screen
 */
function showScreen(screenName) {
    // Hide all screens
    document.querySelectorAll('.screen').forEach(screen => {
        screen.classList.remove('active');
    });

    // Show target screen
    const screen = document.getElementById(`${screenName}-screen`);
    if (screen) {
        screen.classList.add('active');
        state.currentScreen = screenName;
        if (screenName === 'settings') {
            updateDebugPanel();
        }
    }
}

/**
 * Load and show main screen
 */
async function loadMainScreen() {
    showScreen('main');
    console.log('CloudClip:DEBUG loadMainScreen');

    // Load user info for settings
    await loadUserInfo();

    // Hydrate from cache immediately for fast UI
    await hydrateFromCache();

    // Load clipboard items
    await refreshClipboardItems();

    // Load device name
    await loadDeviceName();

    // Load auto-capture setting
    await loadAutoCaptureStatus();

    // Ensure content scripts are injected after restart
    try {
        await chrome.runtime.sendMessage({ type: 'ENSURE_CONTENT_SCRIPTS' });
    } catch (err) {
        // Ignore if background is unavailable briefly
    }

    await updateDebugPanel();
}

// =============================================================================
// EVENT LISTENERS
// =============================================================================

function setupEventListeners() {
    // Onboarding navigation
    document.getElementById('onboarding-next')?.addEventListener('click', handleOnboardingNext);
    document.getElementById('onboarding-back')?.addEventListener('click', handleOnboardingBack);

    // Dot navigation
    document.querySelectorAll('.dot').forEach(dot => {
        dot.addEventListener('click', (e) => {
            const slideIndex = parseInt(e.target.dataset.slide);
            goToOnboardingSlide(slideIndex);
        });
    });

    // Auth tabs
    document.querySelectorAll('.auth-tab').forEach(tab => {
        tab.addEventListener('click', (e) => {
            state.authMode = e.target.dataset.tab;
            updateAuthTabs();
        });
    });

    // Auth form
    document.getElementById('auth-form')?.addEventListener('submit', handleAuthSubmit);

    // Forgot password
    document.getElementById('forgot-password')?.addEventListener('click', handleForgotPassword);

    // Main screen
    document.getElementById('refresh-btn')?.addEventListener('click', handleRefresh);
    document.getElementById('settings-btn')?.addEventListener('click', () => showScreen('settings'));
    document.getElementById('search-input')?.addEventListener('input', handleSearch);

    // Settings
    document.getElementById('settings-back')?.addEventListener('click', () => showScreen('main'));
    document.getElementById('logout-btn')?.addEventListener('click', handleLogout);
    document.getElementById('save-device-name')?.addEventListener('click', handleSaveDeviceName);
    document.getElementById('auto-capture-toggle')?.addEventListener('change', handleAutoCapture);
    document.getElementById('delete-data-btn')?.addEventListener('click', () => showModal('delete-modal'));
    document.getElementById('privacy-link')?.addEventListener('click', openPrivacyPolicy);

    // Delete modal
    document.getElementById('delete-cancel')?.addEventListener('click', () => hideModal('delete-modal'));
    document.getElementById('delete-confirm')?.addEventListener('click', handleDeleteAllData);

    // Item delete modal
    document.getElementById('item-delete-cancel')?.addEventListener('click', () => hideModal('item-delete-modal'));
    document.getElementById('item-delete-confirm')?.addEventListener('click', handleDeleteItem);

    // Privacy policy link in onboarding
    document.getElementById('privacy-policy-link')?.addEventListener('click', openPrivacyPolicy);

    document.getElementById('debug-refresh')?.addEventListener('click', updateDebugPanel);
    document.getElementById('debug-ping')?.addEventListener('click', pingBackground);
    document.getElementById('debug-upload')?.addEventListener('click', debugUploadClipboard);
}

// =============================================================================
// ONBOARDING
// =============================================================================

function handleOnboardingNext() {
    const totalSlides = 4;

    if (state.onboardingSlide < totalSlides - 1) {
        goToOnboardingSlide(state.onboardingSlide + 1);
    } else {
        // Final slide - check consent
        const consent = document.getElementById('consent-checkbox');
        if (!consent?.checked) {
            showToast('Please accept the terms to continue', 'error');
            return;
        }

        // Complete onboarding
        completeOnboarding();
    }
}

function handleOnboardingBack() {
    if (state.onboardingSlide > 0) {
        goToOnboardingSlide(state.onboardingSlide - 1);
    }
}

function goToOnboardingSlide(index) {
    state.onboardingSlide = index;

    // Update slides
    document.querySelectorAll('.slide').forEach((slide, i) => {
        slide.classList.toggle('active', i === index);
    });

    // Update dots
    document.querySelectorAll('.dot').forEach((dot, i) => {
        dot.classList.toggle('active', i === index);
    });

    // Update buttons
    const backBtn = document.getElementById('onboarding-back');
    const nextBtn = document.getElementById('onboarding-next');

    if (backBtn) backBtn.disabled = index === 0;
    if (nextBtn) nextBtn.textContent = index === 3 ? 'Get Started' : 'Next';
}

async function completeOnboarding() {
    await setOnboardingStatus(true);
    showScreen('auth');
}

// =============================================================================
// AUTHENTICATION
// =============================================================================

function updateAuthTabs() {
    document.querySelectorAll('.auth-tab').forEach(tab => {
        tab.classList.toggle('active', tab.dataset.tab === state.authMode);
    });

    const submitBtn = document.getElementById('auth-submit');
    const btnText = submitBtn?.querySelector('.btn-text');
    if (btnText) {
        btnText.textContent = state.authMode === 'login' ? 'Sign In' : 'Sign Up';
    }

    // Clear error
    const errorEl = document.getElementById('auth-error');
    if (errorEl) errorEl.textContent = '';
}

async function handleAuthSubmit(e) {
    e.preventDefault();

    const email = document.getElementById('auth-email')?.value;
    const password = document.getElementById('auth-password')?.value;
    const submitBtn = document.getElementById('auth-submit');
    const errorEl = document.getElementById('auth-error');

    if (!email || !password) {
        if (errorEl) errorEl.textContent = 'Please fill in all fields';
        return;
    }

    // Show loading
    submitBtn?.classList.add('loading');

    try {
        let result;

        if (state.authMode === 'login') {
            result = await signIn(email, password);
        } else {
            result = await signUp(email, password);

            if (result.success) {
                showToast('Account created! Please check your email to verify.', 'success');
                state.authMode = 'login';
                updateAuthTabs();
                submitBtn?.classList.remove('loading');
                return;
            }
        }

        if (result.success) {
            await loadMainScreen();
        } else {
            if (errorEl) errorEl.textContent = result.error || 'Authentication failed';
        }
    } catch (err) {
        console.error('Auth error:', err);
        if (errorEl) errorEl.textContent = 'An unexpected error occurred';
    } finally {
        submitBtn?.classList.remove('loading');
    }
}

async function handleLogout() {
    const result = await signOut();

    if (result.success) {
        showScreen('auth');
        showToast('Signed out successfully', 'success');
    } else {
        showToast(result.error || 'Failed to sign out', 'error');
    }
}

function handleAuthChange(event, session) {
    if (event === 'SIGNED_OUT') {
        showScreen('auth');
    }
    updateDebugPanel();
}

async function handleForgotPassword(e) {
    e.preventDefault();
    showToast('Password reset is not implemented in this demo', 'error');
}

// =============================================================================
// CLIPBOARD ITEMS
// =============================================================================

async function refreshClipboardItems() {
    setSyncStatus('syncing');

    try {
        // Try to fetch from server
        const result = await fetchClipboardItems();

        if (result.success) {
            state.clipboardItems = result.items;
            renderClipboardItems();
            setSyncStatus('synced');
        } else {
            // Fall back to cached items
            const cached = await getCachedItems();
            state.clipboardItems = cached;
            renderClipboardItems();
            setSyncStatus('error');
        }
    } catch (err) {
        console.error('Refresh error:', err);
        setSyncStatus('error');
    }
}

function renderClipboardItems() {
    const container = document.getElementById('clipboard-list');
    const emptyState = document.getElementById('empty-state');

    if (!container) return;

    // Filter by search query
    let items = state.clipboardItems;
    if (state.searchQuery) {
        const query = state.searchQuery.toLowerCase();
        items = items.filter(item =>
            item.content.toLowerCase().includes(query)
        );
    }

    // Show empty state if no items
    if (items.length === 0) {
        container.innerHTML = '';
        emptyState?.classList.remove('hidden');
        return;
    }

    emptyState?.classList.add('hidden');

    // Render items
    container.innerHTML = items.map(item => `
    <div class="clipboard-item" data-id="${item.id}">
      <div class="item-content">${escapeHtml(item.content)}</div>
      <div class="item-meta">
        <div class="item-device">
          <svg viewBox="0 0 24 24" fill="currentColor">
            <path d="M20 18c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2H4c-1.1 0-2 .9-2 2v10c0 1.1.9 2 2 2H0v2h24v-2h-4zM4 6h16v10H4V6z"/>
          </svg>
          <span>${escapeHtml(item.device_name || 'Unknown')}</span>
        </div>
        <span>${formatTime(item.created_at)}</span>
      </div>
    </div>
  `).join('');

    // Add click handlers
    container.querySelectorAll('.clipboard-item').forEach(el => {
        el.addEventListener('click', () => handleItemClick(el.dataset.id));
        el.addEventListener('mousedown', (e) => handleItemMouseDown(e, el.dataset.id));
        el.addEventListener('mouseup', handleItemMouseUp);
        el.addEventListener('mouseleave', handleItemMouseUp);
    });
}

function handleItemClick(itemId) {
    // Skip if this was a long-press
    if (state.longPressItemId === itemId) {
        state.longPressItemId = null;
        return;
    }

    const item = state.clipboardItems.find(i => i.id === itemId);
    if (!item) return;

    copyToClipboard(item.content, itemId);
}

function handleItemMouseDown(e, itemId) {
    state.longPressTimer = setTimeout(() => {
        state.longPressItemId = itemId;
        showDeleteConfirmation(itemId);
    }, CONFIG.UI.LONG_PRESS_DELAY_MS);
}

function handleItemMouseUp() {
    if (state.longPressTimer) {
        clearTimeout(state.longPressTimer);
        state.longPressTimer = null;
    }
}

function showDeleteConfirmation(itemId) {
    state.pendingDeleteId = itemId;
    showModal('item-delete-modal');
}

async function handleDeleteItem() {
    const itemId = state.pendingDeleteId;
    if (!itemId) return;

    hideModal('item-delete-modal');

    const result = await deleteClipboardItem(itemId);

    if (result.success) {
        state.clipboardItems = state.clipboardItems.filter(i => i.id !== itemId);
        renderClipboardItems();
        showToast('Item deleted', 'success');
    } else {
        showToast(result.error || 'Failed to delete', 'error');
    }

    state.pendingDeleteId = null;
}

async function copyToClipboard(text, itemId) {
    try {
        // Visual feedback
        const el = document.querySelector(`[data-id="${itemId}"]`);
        el?.classList.add('copying');

        // Copy directly in popup (this works because of the user gesture)
        await navigator.clipboard.writeText(text);

        showToast('Copied to clipboard!', 'success');

        setTimeout(() => {
            el?.classList.remove('copying');
        }, 300);
    } catch (err) {
        console.error('Copy error:', err);
        showToast('Failed to copy', 'error');
    }
}

// =============================================================================
// SEARCH
// =============================================================================

let searchTimeout = null;

function handleSearch(e) {
    const query = e.target.value;

    clearTimeout(searchTimeout);
    searchTimeout = setTimeout(() => {
        state.searchQuery = query;
        renderClipboardItems();
    }, CONFIG.UI.SEARCH_DEBOUNCE_MS);
}

// =============================================================================
// SETTINGS
// =============================================================================

async function loadUserInfo() {
    const user = await getCurrentUser();
    const emailEl = document.getElementById('user-email');

    if (emailEl && user) {
        emailEl.textContent = user.email;
    }
}

async function loadDeviceName() {
    const name = await getDeviceName();
    const input = document.getElementById('device-name-input');

    if (input) {
        input.value = name;
    }
}

async function handleSaveDeviceName() {
    const input = document.getElementById('device-name-input');
    const name = input?.value?.trim();

    if (!name) {
        showToast('Please enter a device name', 'error');
        return;
    }

    await setDeviceName(name);
    showToast('Device name saved', 'success');
}

async function loadAutoCaptureStatus() {
    const key = CONFIG.STORAGE_KEYS.AUTO_CAPTURE;
    const result = await chrome.storage.local.get(key);
    const toggle = document.getElementById('auto-capture-toggle');

    if (toggle) {
        // Default to true (enabled) unless explicitly disabled
        toggle.checked = result[key] !== false;
    }
}

async function handleAutoCapture(e) {
    const enabled = e.target.checked;

    try {
        if (enabled) {
            // Permissions are now required in manifest, so we just enable the feature
            const result = await chrome.runtime.sendMessage({ type: 'ENABLE_AUTO_CAPTURE' });
            if (!result.success) {
                e.target.checked = false;
                showToast(result.error || 'Failed to enable', 'error');
                return;
            }
            showToast('Auto-capture enabled', 'success');
        } else {
            await chrome.runtime.sendMessage({ type: 'DISABLE_AUTO_CAPTURE' });
            showToast('Auto-capture disabled', 'success');
        }
    } catch (err) {
        console.error('Auto-capture toggle error:', err);
        e.target.checked = !enabled;
        showToast('Failed to change setting', 'error');
    }
}

async function handleDeleteAllData() {
    hideModal('delete-modal');

    const result = await deleteAllUserData();

    if (result.success) {
        state.clipboardItems = [];
        renderClipboardItems();
        showToast('All data deleted', 'success');
    } else {
        showToast(result.error || 'Failed to delete data', 'error');
    }
}

function openPrivacyPolicy(e) {
    e.preventDefault();
    chrome.tabs.create({ url: chrome.runtime.getURL('docs/privacy-policy.html') });
}

// =============================================================================
// BACKGROUND MESSAGE HANDLING
// =============================================================================

function handleBackgroundMessage(message) {
    switch (message.type) {
        case 'NEW_CLIPBOARD_ITEM':
            // Add new item to the top of the list
            state.clipboardItems.unshift(message.item);
            // Keep only the max items
            state.clipboardItems = state.clipboardItems.slice(0, CONFIG.SYNC.MAX_ITEMS);
            renderClipboardItems();
            break;

        case 'CLIPBOARD_ITEM_DELETED':
            state.clipboardItems = state.clipboardItems.filter(i => i.id !== message.itemId);
            renderClipboardItems();
            break;

        case 'CLIPBOARD_ITEMS_UPDATED':
            state.clipboardItems = message.items;
            renderClipboardItems();
            break;

        case 'AUTH_STATE_CHANGED':
            if (message.loggedIn) {
                loadMainScreen();
            } else {
                showScreen('auth');
            }
            break;
    }
}

// =============================================================================
// UI HELPERS
// =============================================================================

function handleRefresh() {
    const btn = document.getElementById('refresh-btn');
    btn?.classList.add('spinning');

    refreshClipboardItems().finally(() => {
        setTimeout(() => {
            btn?.classList.remove('spinning');
        }, 500);
    });
}

function setSyncStatus(status) {
    const statusEl = document.getElementById('sync-status');
    const textEl = statusEl?.querySelector('.status-text');

    if (!statusEl || !textEl) return;

    statusEl.classList.remove('syncing', 'error');

    switch (status) {
        case 'syncing':
            statusEl.classList.add('syncing');
            textEl.textContent = 'Syncing...';
            break;
        case 'synced':
            textEl.textContent = 'Synced';
            break;
        case 'error':
            statusEl.classList.add('error');
            textEl.textContent = 'Offline';
            break;
    }
}

function showModal(modalId) {
    const modal = document.getElementById(modalId);
    if (modal) {
        modal.classList.add('show');
    }
}

function hideModal(modalId) {
    const modal = document.getElementById(modalId);
    if (modal) {
        modal.classList.remove('show');
    }
}

function showToast(message, type = 'info') {
    const toast = document.getElementById('toast');
    if (!toast) return;

    toast.textContent = message;
    toast.className = `toast ${type} show`;

    setTimeout(() => {
        toast.classList.remove('show');
    }, CONFIG.UI.TOAST_DURATION_MS);
}

function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

function formatTime(timestamp) {
    const date = new Date(timestamp);
    const now = new Date();
    const diff = now - date;

    // Less than a minute
    if (diff < 60000) {
        return 'Just now';
    }

    // Less than an hour
    if (diff < 3600000) {
        const mins = Math.floor(diff / 60000);
        return `${mins}m ago`;
    }

    // Less than a day
    if (diff < 86400000) {
        const hours = Math.floor(diff / 3600000);
        return `${hours}h ago`;
    }

    // Less than a week
    if (diff < 604800000) {
        const days = Math.floor(diff / 86400000);
        return `${days}d ago`;
    }

    // Format as date
    return date.toLocaleDateString();
}

function getSupabaseStorageKey() {
    try {
        const hostname = new URL(CONFIG.SUPABASE_URL).hostname;
        const projectRef = hostname.split('.')[0];
        return `sb-${projectRef}-auth-token`;
    } catch (err) {
        return null;
    }
}

function summarizeSession(session) {
    if (!session || typeof session !== 'object') {
        return null;
    }

    return {
        user: session.user ? {
            id: session.user.id || null,
            email: session.user.email || null,
        } : null,
        expires_at: session.expires_at ?? null,
        has_access_token: !!session.access_token,
        has_refresh_token: !!session.refresh_token,
    };
}

function formatUserLabel(user) {
    if (!user) return 'none';
    return user.email || user.id || 'unknown';
}

function formatExpiry(expiresAtSeconds) {
    if (!expiresAtSeconds) return 'n/a';
    const date = new Date(expiresAtSeconds * 1000);
    return date.toLocaleString();
}

function setDebugPingResult(value) {
    const pingEl = document.getElementById('debug-ping-result');
    if (pingEl) {
        pingEl.textContent = value;
    }
}

function setDebugUploadResult(value) {
    const uploadEl = document.getElementById('debug-upload-result');
    if (uploadEl) {
        uploadEl.textContent = value;
    }
}

function promiseWithTimeout(promise, timeoutMs) {
    return Promise.race([
        promise,
        new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), timeoutMs)),
    ]);
}

async function pingBackground() {
    setDebugPingResult('Pinging...');
    console.log('CloudClip:DEBUG ping start');

    try {
        const response = await promiseWithTimeout(
            chrome.runtime.sendMessage({ type: 'PING' }),
            1500
        );
        if (response?.pong) {
            setDebugPingResult('Pong');
        } else {
            setDebugPingResult('No response');
        }
        console.log('CloudClip:DEBUG ping response', response);
    } catch (err) {
        setDebugPingResult(`Error (${err?.message || String(err)})`);
        console.error('CloudClip:DEBUG ping error', err);
    }
}

async function debugUploadClipboard() {
    setDebugUploadResult('Reading...');
    console.log('CloudClip:DEBUG upload start');

    try {
        const text = await navigator.clipboard.readText();
        if (!text || !text.trim()) {
            setDebugUploadResult('Empty clipboard');
            console.warn('CloudClip:DEBUG upload empty clipboard');
            return;
        }

        setDebugUploadResult('Uploading...');
        const result = await uploadClipboardItem(text, {
            skipDebounce: true,
            origin: 'debug-popup',
        });

        if (result?.success) {
            setDebugUploadResult('Uploaded');
            console.log('CloudClip:DEBUG upload success', { id: result?.item?.id || null });
            await refreshClipboardItems();
            await updateDebugPanel();
        } else {
            setDebugUploadResult(`Error (${result?.error || 'Unknown'})`);
            console.error('CloudClip:DEBUG upload failed', result);
        }
    } catch (err) {
        setDebugUploadResult(`Error (${err?.message || String(err)})`);
        console.error('CloudClip:DEBUG upload error', err);
    }
}

async function updateDebugPanel() {
    const storageKeyEl = document.getElementById('debug-storage-key');
    const storageSessionEl = document.getElementById('debug-storage-session');
    const clientSessionEl = document.getElementById('debug-client-session');
    const rawEl = document.getElementById('debug-session-raw');

    if (!storageKeyEl || !storageSessionEl || !clientSessionEl || !rawEl) {
        return;
    }

    const storageKey = getSupabaseStorageKey();
    storageKeyEl.textContent = storageKey || 'Invalid SUPABASE_URL';
    console.log('CloudClip:DEBUG storageKey', storageKey);

    let storageResult = {
        present: false,
        summary: null,
        expires_at_local: null,
        parse_error: null,
    };

    if (storageKey) {
        const result = await chrome.storage.local.get(storageKey);
        const raw = result[storageKey];
        if (raw) {
            storageResult.present = true;
            try {
                const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
                storageResult.summary = summarizeSession(parsed);
                if (storageResult.summary?.expires_at) {
                    storageResult.expires_at_local = formatExpiry(storageResult.summary.expires_at);
                }
            } catch (err) {
                storageResult.parse_error = err?.message || String(err);
            }
        }
    }
    console.log('CloudClip:DEBUG storageResult', storageResult);

    if (!storageKey) {
        storageSessionEl.textContent = 'n/a';
    } else if (!storageResult.present) {
        storageSessionEl.textContent = 'Missing';
    } else {
        const userLabel = formatUserLabel(storageResult.summary?.user);
        const expiry = storageResult.summary?.expires_at ? formatExpiry(storageResult.summary.expires_at) : 'n/a';
        storageSessionEl.textContent = `Present (${userLabel}, exp ${expiry})`;
    }

    let clientResult = {
        authenticated: false,
        summary: null,
        expires_at_local: null,
        error: null,
    };

    try {
        const session = await getSession();
        if (session) {
            clientResult.authenticated = true;
            clientResult.summary = summarizeSession(session);
            if (clientResult.summary?.expires_at) {
                clientResult.expires_at_local = formatExpiry(clientResult.summary.expires_at);
            }
        }
    } catch (err) {
        clientResult.error = err?.message || String(err);
    }
    console.log('CloudClip:DEBUG clientResult', clientResult);

    if (clientResult.authenticated) {
        const userLabel = formatUserLabel(clientResult.summary?.user);
        const expiry = clientResult.summary?.expires_at ? formatExpiry(clientResult.summary.expires_at) : 'n/a';
        clientSessionEl.textContent = `Authenticated (${userLabel}, exp ${expiry})`;
    } else if (clientResult.error) {
        clientSessionEl.textContent = `Error (${clientResult.error})`;
    } else {
        clientSessionEl.textContent = 'Not authenticated';
    }

    setDebugPingResult('Ready');

    rawEl.textContent = JSON.stringify(
        {
            storageKey,
            storage: storageResult,
            client: clientResult,
        },
        null,
        2
    );
}

// =============================================================================
// START
// =============================================================================

// Initialize when DOM is ready
document.addEventListener('DOMContentLoaded', init);
