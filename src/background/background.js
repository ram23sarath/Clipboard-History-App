/**
 * CloudClip Background Service Worker
 * Handles clipboard sync, message routing, and Realtime subscriptions
 */

import { getSupabaseClient, getSession, onAuthStateChange, isAuthenticated } from '../lib/supabase-client.js';
import { updateDeviceRecord, removeDeviceRecord, getDeviceId } from '../lib/device.js';
import {
    uploadClipboardItem,
    fetchClipboardItems,
    subscribeToClipboardChanges,
    unsubscribeFromClipboardChanges,
    getCachedItems,
    clearPendingUploads
} from '../lib/sync.js';
import { CONFIG } from '../config.js';

// State tracking
let isInitialized = false;
let realtimeSubscription = null;

/**
 * Initialize the service worker
 */
async function initialize() {
    if (isInitialized) return;

    console.log('CloudClip: Initializing service worker...');

    try {
        // Listen for auth state changes
        onAuthStateChange(handleAuthStateChange);

        // Check if user is already authenticated
        const session = await getSession();
        if (session?.user) {
            await handleUserLogin(session.user);
        }

        isInitialized = true;
        console.log('CloudClip: Service worker initialized');
    } catch (err) {
        console.error('CloudClip: Initialization error:', err);
    }
}

/**
 * Handle auth state changes
 * @param {string} event - Auth event type
 * @param {Object} session - Current session
 */
async function handleAuthStateChange(event, session) {
    console.log('CloudClip: Auth state changed:', event);

    switch (event) {
        case 'SIGNED_IN':
            if (session?.user) {
                await handleUserLogin(session.user);
            }
            break;

        case 'SIGNED_OUT':
            handleUserLogout();
            break;

        case 'TOKEN_REFRESHED':
            console.log('CloudClip: Token refreshed');
            break;
    }
}

/**
 * Handle user login
 * @param {Object} user - User object
 */
async function handleUserLogin(user) {
    console.log('CloudClip: User logged in:', user.email);

    try {
        // Register/update device
        await updateDeviceRecord(user.id);

        // Check if auto-capture is enabled
        const autoCapture = await getAutoCaptureSetting();
        if (autoCapture) {
            await injectContentScripts();
        }

        // Set up Realtime subscription
        await setupRealtimeSubscription();

        // Initial sync
        await syncClipboardItems();

        // Notify popup if open
        broadcastMessage({ type: 'AUTH_STATE_CHANGED', loggedIn: true, user });
    } catch (err) {
        console.error('CloudClip: Login handler error:', err);
    }
}

/**
 * Handle user logout
 */
function handleUserLogout() {
    console.log('CloudClip: User logged out');

    // Clean up
    unsubscribeFromClipboardChanges();
    clearPendingUploads();

    // Notify popup
    broadcastMessage({ type: 'AUTH_STATE_CHANGED', loggedIn: false });
}

/**
 * Set up Realtime subscription for clipboard changes
 */
async function setupRealtimeSubscription() {
    realtimeSubscription = await subscribeToClipboardChanges(
        // On new item from another device
        (item) => {
            console.log('CloudClip: New item from another device:', item.id);
            broadcastMessage({ type: 'NEW_CLIPBOARD_ITEM', item });
        },
        // On item deleted
        (item) => {
            console.log('CloudClip: Item deleted:', item.id);
            broadcastMessage({ type: 'CLIPBOARD_ITEM_DELETED', itemId: item.id });
        }
    );
}

/**
 * Sync clipboard items from server
 */
async function syncClipboardItems() {
    const result = await fetchClipboardItems();
    if (result.success) {
        broadcastMessage({ type: 'CLIPBOARD_ITEMS_UPDATED', items: result.items });
    }
    return result;
}

/**
 * Get auto-capture setting
 * @returns {Promise<boolean>}
 */
async function getAutoCaptureSetting() {
    const key = CONFIG.STORAGE_KEYS.AUTO_CAPTURE;
    const result = await chrome.storage.local.get(key);
    return result[key] === true;
}

/**
 * Register dynamic content scripts
 * This ensures Chrome injects them automatically into all matching pages
 */
async function injectContentScripts() {
    try {
        const SCRIPT_ID = 'cloudclip-content-script';

        // Check if already registered
        const existing = await chrome.scripting.getRegisteredContentScripts({ ids: [SCRIPT_ID] });
        if (existing.length > 0) {
            console.log('CloudClip: Content scripts already registered');
            return;
        }

        // Register the script
        await chrome.scripting.registerContentScripts([{
            id: SCRIPT_ID,
            js: ['src/content/content.js'],
            matches: ['<all_urls>'],
            runAt: 'document_start',
        }]);

        console.log('CloudClip: Content scripts registered');

        // Also inject into currently open tabs immediately (for instant enablement)
        const tabs = await chrome.tabs.query({});
        for (const tab of tabs) {
            if (tab.url?.startsWith('http')) {
                chrome.scripting.executeScript({
                    target: { tabId: tab.id },
                    files: ['src/content/content.js']
                }).catch(() => { }); // Ignore errors
            }
        }

    } catch (err) {
        console.error('CloudClip: Error registering content scripts:', err);
    }
}

/**
 * Unregister content scripts
 */
async function removeContentScripts() {
    try {
        const SCRIPT_ID = 'cloudclip-content-script';
        await chrome.scripting.unregisterContentScripts({ ids: [SCRIPT_ID] });
        console.log('CloudClip: Content scripts unregistered');

        // Notify existing instances to stop
        broadcastToAllTabs({ type: 'DISABLE_CAPTURE' });
    } catch (err) {
        // Ignore error if not registered
    }
}

/**
 * Broadcast message to popup
 * @param {Object} message - Message to send
 */
function broadcastMessage(message) {
    chrome.runtime.sendMessage(message).catch(() => {
        // Popup might not be open, ignore errors
    });
}

/**
 * Broadcast message to all tabs
 * @param {Object} message - Message to send
 */
async function broadcastToAllTabs(message) {
    try {
        const tabs = await chrome.tabs.query({});
        for (const tab of tabs) {
            chrome.tabs.sendMessage(tab.id, message).catch(() => { });
        }
    } catch (err) {
        console.error('CloudClip: Error broadcasting to tabs:', err);
    }
}

// =============================================================================
// MESSAGE HANDLERS
// =============================================================================

/**
 * Handle messages from popup and content scripts
 */
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    // Handle async responses
    handleMessage(message, sender).then(sendResponse);
    return true; // Keep channel open for async response
});

/**
 * Process incoming messages
 * @param {Object} message - Message object
 * @param {Object} sender - Sender info
 * @returns {Promise<any>}
 */
async function handleMessage(message, sender) {
    const { type, payload } = message;

    switch (type) {
        case 'CLIPBOARD_COPIED':
            return handleClipboardCopied(payload);

        case 'SYNC_ITEMS':
            return syncClipboardItems();

        case 'GET_ITEMS':
            return getCachedItems();

        case 'UPLOAD_ITEM':
            return uploadClipboardItem(payload.content, payload.options);

        case 'ENABLE_AUTO_CAPTURE':
            return handleEnableAutoCapture();

        case 'DISABLE_AUTO_CAPTURE':
            return handleDisableAutoCapture();

        case 'GET_AUTH_STATE':
            const authenticated = await isAuthenticated();
            const session = await getSession();
            return { authenticated, user: session?.user };

        case 'COPY_TO_CLIPBOARD':
            return handleCopyToClipboard(payload.text);

        default:
            console.warn('CloudClip: Unknown message type:', type);
            return { error: 'Unknown message type' };
    }
}

/**
 * Handle clipboard copy event from content script
 * @param {Object} payload - Copy event payload
 */
async function handleClipboardCopied(payload) {
    console.log('CloudClip: Received clipboard copy event:', payload);

    const { content, url, timestamp } = payload;

    // Check if auto-capture is enabled
    const autoCapture = await getAutoCaptureSetting();
    console.log('CloudClip: Auto-capture enabled:', autoCapture);

    if (!autoCapture) {
        console.log('CloudClip: Skipping - auto-capture disabled');
        return { success: false, error: 'Auto-capture disabled' };
    }

    // Check if authenticated
    const authenticated = await isAuthenticated();
    console.log('CloudClip: Authenticated:', authenticated);

    if (!authenticated) {
        console.log('CloudClip: Skipping - not authenticated');
        return { success: false, error: 'Not authenticated' };
    }

    // Upload to Supabase
    console.log('CloudClip: Uploading content to Supabase...');
    const result = await uploadClipboardItem(content, { origin: url });
    console.log('CloudClip: Upload result:', result);

    if (result.success) {
        broadcastMessage({ type: 'NEW_CLIPBOARD_ITEM', item: result.item });
    }

    return result;
}

/**
 * Handle enable auto-capture request
 */
async function handleEnableAutoCapture() {
    try {
        // Verify we have permissions (requested by popup)
        const hasPermissions = await chrome.permissions.contains({
            permissions: ['clipboardRead', 'scripting']
        });

        if (!hasPermissions) {
            return { success: false, error: 'Permissions not granted' };
        }

        // Save setting
        await chrome.storage.local.set({
            [CONFIG.STORAGE_KEYS.AUTO_CAPTURE]: true
        });

        // Inject content scripts
        await injectContentScripts();

        return { success: true };
    } catch (err) {
        console.error('CloudClip: Enable auto-capture error:', err);
        return { success: false, error: err.message };
    }
}

/**
 * Handle disable auto-capture request
 */
async function handleDisableAutoCapture() {
    try {
        // Save setting
        await chrome.storage.local.set({
            [CONFIG.STORAGE_KEYS.AUTO_CAPTURE]: false
        });

        // Notify content scripts to stop
        await removeContentScripts();

        return { success: true };
    } catch (err) {
        console.error('CloudClip: Disable auto-capture error:', err);
        return { success: false, error: err.message };
    }
}

/**
 * Handle copy to clipboard request
 * @param {string} text - Text to copy
 */
async function handleCopyToClipboard(text) {
    try {
        // Check if we have clipboard write permission
        const hasPermission = await chrome.permissions.contains({
            permissions: ['clipboardWrite']
        });

        if (!hasPermission) {
            // Request permission
            const granted = await chrome.permissions.request({
                permissions: ['clipboardWrite']
            });

            if (!granted) {
                return { success: false, error: 'Clipboard write permission not granted' };
            }
        }

        // Use offscreen document for clipboard access in service worker
        await copyToClipboardViaOffscreen(text);

        return { success: true };
    } catch (err) {
        console.error('CloudClip: Copy to clipboard error:', err);
        return { success: false, error: err.message };
    }
}

/**
 * Copy text to clipboard using offscreen document
 * @param {string} text - Text to copy
 */
async function copyToClipboardViaOffscreen(text) {
    // Create offscreen document if it doesn't exist
    const existingContexts = await chrome.runtime.getContexts({
        contextTypes: ['OFFSCREEN_DOCUMENT']
    });

    if (existingContexts.length === 0) {
        await chrome.offscreen.createDocument({
            url: 'src/offscreen/offscreen.html',
            reasons: ['CLIPBOARD'],
            justification: 'Copy text to clipboard'
        });
    }

    // Send message to offscreen document
    await chrome.runtime.sendMessage({
        type: 'OFFSCREEN_COPY',
        target: 'offscreen',
        text
    });
}

// =============================================================================
// LIFECYCLE EVENTS
// =============================================================================

/**
 * Handle extension install/update
 */
chrome.runtime.onInstalled.addListener(async (details) => {
    console.log('CloudClip: Extension installed/updated:', details.reason);

    if (details.reason === 'install') {
        // First install - open onboarding
        await chrome.storage.local.set({
            [CONFIG.STORAGE_KEYS.ONBOARDING_COMPLETE]: false
        });
    }

    // Initialize
    await initialize();
});

/**
 * Handle extension startup
 */
chrome.runtime.onStartup.addListener(async () => {
    console.log('CloudClip: Extension started');
    await initialize();
});

/**
 * Handle extension uninstall
 * Note: This runs in a very limited context
 */
chrome.runtime.setUninstallURL('', async () => {
    // Try to clean up device record
    try {
        await removeDeviceRecord();
    } catch (err) {
        console.error('CloudClip: Cleanup error:', err);
    }
});



/**
 * Keep service worker alive
 * Service workers can be terminated after 30s of inactivity
 */
const KEEP_ALIVE_INTERVAL = 20000; // 20 seconds
let lastSupabasePing = Date.now();
const SUPABASE_PING_INTERVAL = 3600000; // 1 hour

setInterval(async () => {
    // Ping to keep alive, but only if user is authenticated
    const authenticated = await isAuthenticated();
    if (authenticated) {
        console.debug('CloudClip: Keep-alive ping');

        // Periodically ping Supabase to prevent project pausing
        const now = Date.now();
        if (now - lastSupabasePing > SUPABASE_PING_INTERVAL) {
            console.log('CloudClip: Pinging Supabase to prevent sleep...');
            try {
                const client = getSupabaseClient();
                // Lightweight query just to touch the DB
                await client.from('clipboard_items').select('count', { count: 'exact', head: true });
                lastSupabasePing = now;
            } catch (err) {
                console.error('CloudClip: Supabase ping failed:', err);
            }
        }
    }
}, KEEP_ALIVE_INTERVAL);

// Initialize on load
initialize();
