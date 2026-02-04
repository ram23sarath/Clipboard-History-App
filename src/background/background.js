/**
 * CloudClip Background Service Worker
 * Handles clipboard sync, message routing, and Realtime subscriptions
 */

import { getSupabaseClient, getSession, onAuthStateChange, isAuthenticated } from '../lib/supabase-client.js';
import { updateDeviceRecord, getDeviceId } from '../lib/device.js';
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
const DEBUG_PREFIX = 'CloudClip:DEBUG';

/**
 * Initialize the service worker
 */
async function initialize() {
    if (isInitialized) return;

    console.log('CloudClip: Initializing service worker...');
    console.log(`${DEBUG_PREFIX} init start`, {
        time: new Date().toISOString(),
        runtimeId: chrome.runtime?.id || null
    });

    try {
        // Ensure defaults exist even if onInstalled didn't run (e.g., restart)
        const onboardingKey = CONFIG.STORAGE_KEYS.ONBOARDING_COMPLETE;
        const onboarding = await chrome.storage.local.get(onboardingKey);
        if (typeof onboarding[onboardingKey] === 'undefined') {
            await chrome.storage.local.set({ [onboardingKey]: false });
        }

        // Listen for auth state changes
        onAuthStateChange(handleAuthStateChange);
        console.log(`${DEBUG_PREFIX} auth listener registered`);

        // Check if user is already authenticated
        const session = await getSession();
        console.log(`${DEBUG_PREFIX} getSession (init)`, {
            hasSession: !!session,
            userId: session?.user?.id || null,
            expiresAt: session?.expires_at || null
        });
        if (session?.user) {
            await handleUserLogin(session.user);
        }

        isInitialized = true;
        console.log('CloudClip: Service worker initialized');
        console.log(`${DEBUG_PREFIX} init complete`, {
            time: new Date().toISOString()
        });
    } catch (err) {
        console.error('CloudClip: Initialization error:', err);
        console.error(`${DEBUG_PREFIX} init error`, err);
    }
}

/**
 * Update cached items in storage (durable UI updates)
 * @param {Array} items
 */
async function updateCachedItems(items) {
    await chrome.storage.local.set({
        [CONFIG.STORAGE_KEYS.CACHED_ITEMS]: items,
        [CONFIG.STORAGE_KEYS.LAST_SYNC]: Date.now(),
    });
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
        case 'INITIAL_SESSION':
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
    console.log(`${DEBUG_PREFIX} handleUserLogin`, {
        userId: user?.id || null,
        email: user?.email || null
    });

    try {
        // Register/update device
        await updateDeviceRecord(user.id);

        // Check if auto-capture is enabled
        const autoCapture = await getAutoCaptureSetting();
        console.log(`${DEBUG_PREFIX} autoCapture`, { enabled: autoCapture });

        // Set up Realtime subscription
        await setupRealtimeSubscription();
        console.log(`${DEBUG_PREFIX} realtime subscription set`);

        // Initial sync
        await syncClipboardItems();
        console.log(`${DEBUG_PREFIX} initial sync complete`);

        // Process any locally cached pending uploads (from when SW was offline/not-authenticated)
        await processPendingUploads();
        console.log(`${DEBUG_PREFIX} pending uploads processed`);

        // Notify popup if open
        broadcastMessage({ type: 'AUTH_STATE_CHANGED', loggedIn: true, user });
        console.log(`${DEBUG_PREFIX} broadcast AUTH_STATE_CHANGED loggedIn`);
    } catch (err) {
        console.error('CloudClip: Login handler error:', err);
        console.error(`${DEBUG_PREFIX} handleUserLogin error`, err);
    }
}

/**
 * Add a clipboard item to local cache marked as pending upload
 * This ensures the popup shows the item immediately even if not authenticated
 * @param {Object} payload
 */
async function addPendingCachedItem(payload) {
    try {
        const item = {
            id: crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2,8)}`,
            content: payload.content,
            origin: payload.url || payload.origin || 'unknown',
            page_title: payload.pageTitle || '',
            created_at: payload.timestamp ? new Date(payload.timestamp).toISOString() : new Date().toISOString(),
            pending: true,
            device_id: await getDeviceId(),
            device_name: await getDeviceName(),
        };

        const cached = await getCachedItems();
        const merged = [item, ...cached.filter(i => i.id !== item.id)].slice(0, CONFIG.SYNC.MAX_ITEMS);
        await updateCachedItems(merged);

        // Broadcast so popup updates immediately
        broadcastMessage({ type: 'NEW_CLIPBOARD_ITEM', item });
    } catch (err) {
        console.error('CloudClip: Failed to add pending cached item:', err);
    }
}

/**
 * Process pending cached items and attempt to upload them now that we're authenticated
 */
async function processPendingUploads() {
    try {
        const cached = await getCachedItems();
        const pending = (cached || []).filter(i => i.pending);

        if (!pending.length) return;

        console.log('CloudClip: Processing pending uploads:', pending.length);

        for (const p of pending) {
            try {
                const res = await uploadClipboardItem(p.content, { skipDebounce: true, origin: p.origin });
                if (res.success && res.item) {
                    // Replace pending entry with server result
                    const updated = (await getCachedItems())
                        .map(i => i.id === p.id ? res.item : i)
                        .slice(0, CONFIG.SYNC.MAX_ITEMS);
                    await updateCachedItems(updated);
                }
            } catch (err) {
                console.error('CloudClip: Pending upload failed for item', p.id, err);
            }
        }
    } catch (err) {
        console.error('CloudClip: Error processing pending uploads:', err);
    }
}

/**
 * Handle user logout
 */
function handleUserLogout() {
    console.log('CloudClip: User logged out');
    console.log(`${DEBUG_PREFIX} handleUserLogout`);

    // Clean up
    unsubscribeFromClipboardChanges();
    clearPendingUploads();
    // No reinjection needed with declarative content scripts

    // Notify popup
    broadcastMessage({ type: 'AUTH_STATE_CHANGED', loggedIn: false });
}

/**
 * Set up Realtime subscription for clipboard changes
 */
async function setupRealtimeSubscription() {
    realtimeSubscription = await subscribeToClipboardChanges(
        // On new item from another device
        async (item) => {
            console.log('CloudClip: New item from another device:', item.id);
            try {
                const cached = await getCachedItems();
                const merged = [item, ...cached.filter(i => i.id !== item.id)]
                    .slice(0, CONFIG.SYNC.MAX_ITEMS);
                await updateCachedItems(merged);
            } catch (err) {
                console.error('CloudClip: Cache update error:', err);
            }
            broadcastMessage({ type: 'NEW_CLIPBOARD_ITEM', item });
        },
        // On item deleted
        async (item) => {
            console.log('CloudClip: Item deleted:', item.id);
            try {
                const cached = await getCachedItems();
                const filtered = cached.filter(i => i.id !== item.id);
                await updateCachedItems(filtered);
            } catch (err) {
                console.error('CloudClip: Cache delete error:', err);
            }
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
    // Default to true (enabled) unless explicitly disabled
    return result[key] !== false;
}

/**
 * Register dynamic content scripts
 * NOTE: With static content_scripts in manifest, we don't need dynamic registration
 * The content script itself checks the auto-capture setting from storage
 * This function is kept for backwards compatibility but does nothing
 */
async function injectContentScripts() {
    console.log('CloudClip: Content scripts loaded via manifest (static)');
    // No-op - content scripts are declarative in manifest.json
}

/**
 * Unregister content scripts
 * NOTE: With static manifest content scripts, we just notify them to disable
 */
async function removeContentScripts() {
    console.log('CloudClip: Notifying content scripts to disable capture');
    // Notify existing instances to stop capturing
    broadcastToAllTabs({ type: 'DISABLE_CAPTURE' });
}

/**
 * Broadcast message to popup
 * @param {Object} message - Message to send
 */
function broadcastMessage(message) {
    globalThis.chrome?.runtime?.sendMessage(message).catch(() => {
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
const runtimeApi = globalThis.chrome?.runtime;
if (!runtimeApi?.onMessage) {
    console.error('CloudClip: runtime.onMessage is unavailable', {
        hasChrome: !!globalThis.chrome,
        hasRuntime: !!globalThis.chrome?.runtime,
    });
} else {
    try {
        runtimeApi.onMessage.addListener((message, sender, sendResponse) => {
            console.log(`${DEBUG_PREFIX} onMessage`, {
                type: message?.type || null,
                from: sender?.tab?.id || 'extension',
                url: sender?.tab?.url || null
            });
            if (message?.type === 'PING') {
                sendResponse({ pong: true });
                return;
            }
            // Handle async responses. Ensure we always call sendResponse (including on error)
            initialize()
                .then(() => handleMessage(message, sender))
                .then((result) => {
                    try {
                        sendResponse(result);
                    } catch (err) {
                        console.error('CloudClip: Error sending response:', err);
                    }
                })
                .catch((err) => {
                    console.error('CloudClip: Message handler error:', err);
                    try {
                        sendResponse({ success: false, error: err?.message || String(err) });
                    } catch (e) {
                        console.error('CloudClip: Failed to send error response:', e);
                    }
                });

            // Return true to indicate we'll call sendResponse asynchronously.
            return true;
        });
    } catch (err) {
        console.error('CloudClip: Failed to register runtime.onMessage listener', err);
    }
}

/**
 * Process incoming messages
 * @param {Object} message - Message object
 * @param {Object} sender - Sender info
 * @returns {Promise<any>}
 */
async function handleMessage(message, sender) {
    const { type, payload } = message;

    try {
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

        case 'ENSURE_CONTENT_SCRIPTS':
            return { success: true, mode: 'manifest' };

        case 'GET_AUTH_STATE':
            const authenticated = await isAuthenticated();
            const session = await getSession();
            return { authenticated, user: session?.user };

        case 'COPY_TO_CLIPBOARD':
            return handleCopyToClipboard(payload.text);

        case 'PING':
            return { pong: true };

        default:
            console.warn('CloudClip: Unknown message type:', type);
            return { error: 'Unknown message type' };
    }
    } catch (err) {
        console.error('CloudClip: Unhandled message error:', err);
        console.error(`${DEBUG_PREFIX} handleMessage error`, err);
        return { success: false, error: err?.message || String(err) };
    }
}

/**
 * Handle clipboard copy event from content script
 * @param {Object} payload - Copy event payload
 */
async function handleClipboardCopied(payload) {
    console.log('CloudClip: Received clipboard copy event:', payload);
    console.log(`${DEBUG_PREFIX} clipboard payload`, {
        hasContent: !!payload?.content,
        url: payload?.url || null,
        ts: payload?.timestamp || null
    });

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
    console.log(`${DEBUG_PREFIX} authenticated`, { authenticated });

    if (!authenticated) {
        console.log('CloudClip: Not authenticated - caching pending item for later upload');
        // Cache the item so popup shows it immediately and upload can be retried later
        await addPendingCachedItem(payload);
        return { success: true, pending: true };
    }

    // Upload to Supabase
    console.log('CloudClip: Uploading content to Supabase...');
    const result = await uploadClipboardItem(content, { origin: url });
    console.log('CloudClip: Upload result:', result);

    if (result.success) {
        try {
            const cached = await getCachedItems();
            const merged = [result.item, ...cached.filter(i => i.id !== result.item.id)]
                .slice(0, CONFIG.SYNC.MAX_ITEMS);
            await updateCachedItems(merged);
        } catch (err) {
            console.error('CloudClip: Cache update error:', err);
        }
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
            permissions: ['clipboardRead']
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
globalThis.chrome?.runtime?.onInstalled?.addListener(async (details) => {
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
globalThis.chrome?.runtime?.onStartup?.addListener(async () => {
    console.log('CloudClip: Extension started');
    console.log(`${DEBUG_PREFIX} onStartup`);
    await initialize();
});

/**
 * Handle extension uninstall
 * Note: This runs in a very limited context
 */
try {
    chrome.runtime.setUninstallURL('');
} catch (err) {
    console.error('CloudClip: Failed to set uninstall URL:', err);
}



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
