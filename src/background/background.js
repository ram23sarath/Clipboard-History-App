/**
 * CloudClip Background Service Worker
 * Handles clipboard sync, message routing, and Realtime subscriptions
 */

import { getSupabaseClient, getSession, onAuthStateChange, isAuthenticated, refreshSession } from '../lib/supabase-client.js';
// FIX: Added 'getDeviceName' to imports. It was used in addPendingCachedItem but missing here.
import { updateDeviceRecord, getDeviceId, getDeviceName } from '../lib/device.js';
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
// FIX: Use a Promise to track initialization state, not a boolean
let initPromise = null;
let realtimeSubscription = null;
const DEBUG_PREFIX = 'CloudClip:DEBUG';

/**
 * Initialize the service worker (Promise Singleton)
 * Ensures initialization only runs once per SW lifecycle
 * CRITICAL: Must complete within ~25s or SW will be killed
 */
function initialize() {
    // If initialization is already running or complete, return the existing promise
    if (initPromise) return initPromise;

    // Otherwise, start initialization with timeout protection
    initPromise = (async () => {
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
            // Register this BEFORE checking session to catch immediate updates
            onAuthStateChange(handleAuthStateChange);
            console.log(`${DEBUG_PREFIX} auth listener registered`);

            // Wrap session check in timeout to prevent hanging
            const sessionWithTimeout = async (timeoutMs = 10000) => {
                return Promise.race([
                    (async () => {
                        let session = await getSession();
                        if (!session?.user) {
                            console.log('CloudClip: No active session, attempting refresh...');
                            session = await refreshSession();
                        }
                        return session;
                    })(),
                    new Promise((_, reject) => 
                        setTimeout(() => reject(new Error('Session check timeout')), timeoutMs)
                    )
                ]);
            };

            let session = null;
            try {
                session = await sessionWithTimeout(10000);
                console.log(`${DEBUG_PREFIX} getSession (init)`, {
                    hasSession: !!session,
                    userId: session?.user?.id || null,
                    expiresAt: session?.expires_at || null
                });
            } catch (timeoutErr) {
                console.warn('CloudClip: Session check timed out, will retry on next wake');
                // Don't fail init - alarm will retry later
            }

            if (session?.user) {
                // Do not block initialization on network-dependent startup work
                handleUserLogin(session.user).catch((err) => {
                    console.error('CloudClip: handleUserLogin (init) error:', err);
                });
            } else {
                console.log('CloudClip: No active session found during init');
            }

            console.log('CloudClip: Service worker initialized');
            console.log(`${DEBUG_PREFIX} init complete`, {
                time: new Date().toISOString()
            });
        } catch (err) {
            console.error('CloudClip: Initialization error:', err);
            console.error(`${DEBUG_PREFIX} init error`, err);
            // Reset promise on error so we can retry later
            initPromise = null;
            throw err;
        }
    })();

    return initPromise;
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
                // Fire-and-forget to avoid blocking auth event handler
                handleUserLogin(session.user).catch((err) => {
                    console.error('CloudClip: handleUserLogin (auth) error:', err);
                });
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

    // Safety check: Prevent tearing down an existing connection unnecessarily
    if (realtimeSubscription) {
        console.log('CloudClip: Realtime subscription already exists, skipping setup.');
        return;
    }

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

        // Process any locally cached pending uploads
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
        // FIX: Ensure getDeviceName is safe to call
        let deviceName = 'Chrome Extension';
        try {
            if (typeof getDeviceName === 'function') {
                deviceName = await getDeviceName();
            }
        } catch (e) { console.warn('Could not get device name', e); }

        const item = {
            id: crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2,8)}`,
            content: payload.content,
            origin: payload.url || payload.origin || 'unknown',
            page_title: payload.pageTitle || '',
            created_at: payload.timestamp ? new Date(payload.timestamp).toISOString() : new Date().toISOString(),
            pending: true,
            device_id: await getDeviceId(),
            device_name: deviceName,
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
                // Validate auth before trying to upload
                const isAuth = await isAuthenticated();
                if (!isAuth) {
                    console.log('CloudClip: Aborting pending upload - not authenticated');
                    return;
                }

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
    realtimeSubscription = null; // Clear tracking variable
    unsubscribeFromClipboardChanges();
    clearPendingUploads();

    // Notify popup
    broadcastMessage({ type: 'AUTH_STATE_CHANGED', loggedIn: false });
}

/**
 * Set up Realtime subscription for clipboard changes
 */
async function setupRealtimeSubscription() {
    // Prevent duplicate subscriptions
    if (realtimeSubscription) return;

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

// Content scripts are declarative via manifest.json - no dynamic injection needed

// Content scripts react to storage changes - no explicit disable broadcast needed

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
// Message listener is registered at top-level in boot section below

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

    // FIX: Enhanced Auth Check
    // On reload, isAuthenticated might briefly be false while token refreshes
    let authenticated = await isAuthenticated();
    
    // If not authenticated, try strict session check + refresh once
    if (!authenticated) {
        console.log('CloudClip: Auth check failed, attempting strict session check...');
        let session = await getSession();
        if (!session?.user) {
            console.log('CloudClip: No session, attempting refreshSession...');
            session = await refreshSession();
        }
        if (session?.user) {
            authenticated = true;
        }
    }
    
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
    // Skip debounce in MV3 SW to avoid timer suspension after restart
    const result = await uploadClipboardItem(content, { origin: url, skipDebounce: true });
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
    } else {
        // FIX: Fallback to pending if network upload fails despite being authenticated
        console.warn('CloudClip: Upload failed (network?), saving as pending');
        await addPendingCachedItem(payload);
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

        // Save setting - content scripts react via storage.onChanged
        await chrome.storage.local.set({
            [CONFIG.STORAGE_KEYS.AUTO_CAPTURE]: true
        });

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
        // Save setting - content scripts react via storage.onChanged
        await chrome.storage.local.set({
            [CONFIG.STORAGE_KEYS.AUTO_CAPTURE]: false
        });

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
// LIFECYCLE EVENTS (registered synchronously)
// =============================================================================

/**
 * Handle extension install/update
 * Non-blocking - fire-and-forget initialization
 */
chrome.runtime.onInstalled.addListener((details) => {
    console.log('CloudClip: Extension installed/updated:', details.reason);

    // Fire-and-forget: don't await, don't block
    (async () => {
        try {
            if (details.reason === 'install') {
                await chrome.storage.local.set({
                    [CONFIG.STORAGE_KEYS.ONBOARDING_COMPLETE]: false
                });
            }
            // Ensure alarm is set
            await ensureAlarmSet();
            // Initialize (non-blocking)
            await initialize();
        } catch (err) {
            console.error('CloudClip: onInstalled handler error:', err);
        }
    })();
});

/**
 * Handle extension startup (Chrome launch)
 * Non-blocking - fire-and-forget initialization
 */
chrome.runtime.onStartup.addListener(() => {
    console.log('CloudClip: Extension started (onStartup)');
    console.log(`${DEBUG_PREFIX} onStartup`);

    // Fire-and-forget: don't await, don't block
    (async () => {
        try {
            // Ensure alarm is set on every startup
            await ensureAlarmSet();
            // Initialize (non-blocking)
            await initialize();
        } catch (err) {
            console.error('CloudClip: onStartup handler error:', err);
        }
    })();
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



// =============================================================================
// TOP-LEVEL BOOT (runs synchronously on every SW start)
// =============================================================================
console.log('CloudClip:SW_BOOT', { time: new Date().toISOString(), runtimeId: chrome.runtime?.id });

// -----------------------------------------------------------------------------
// ALARM-BASED WAKE STRATEGY (replaces broken setInterval)
// -----------------------------------------------------------------------------
const ALARM_NAME = 'cloudclip-keepalive';
const ALARM_PERIOD_MINUTES = 1; // Wake every 1 minute (minimum allowed)

// Register alarm listener SYNCHRONOUSLY at top-level
chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === ALARM_NAME) {
        console.log('CloudClip: Alarm woke service worker');
        // Fire-and-forget: perform periodic tasks
        handleAlarmWake().catch((err) => {
            console.error('CloudClip: Alarm handler error:', err);
        });
    }
});

/**
 * Handle alarm wake - perform periodic sync/maintenance
 * Non-blocking, idempotent
 */
async function handleAlarmWake() {
    try {
        const authenticated = await isAuthenticated();
        if (!authenticated) {
            console.log('CloudClip: Alarm wake - not authenticated, skipping');
            return;
        }

        console.log('CloudClip: Alarm wake - processing');

        // Re-establish Realtime subscription if lost
        if (!realtimeSubscription) {
            await setupRealtimeSubscription();
        }

        // Process any pending uploads
        await processPendingUploads();

    } catch (err) {
        console.error('CloudClip: Alarm wake processing error:', err);
    }
}

/**
 * Ensure keepalive alarm is set (idempotent)
 */
async function ensureAlarmSet() {
    try {
        const existing = await chrome.alarms.get(ALARM_NAME);
        if (!existing) {
            await chrome.alarms.create(ALARM_NAME, {
                delayInMinutes: 1,
                periodInMinutes: ALARM_PERIOD_MINUTES
            });
            console.log('CloudClip: Keepalive alarm created');
        }
    } catch (err) {
        console.error('CloudClip: Failed to set alarm:', err);
    }
}

// Register message listener SYNCHRONOUSLY (before any async work)
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    console.log(`${DEBUG_PREFIX} onMessage`, {
        type: message?.type || null,
        from: sender?.tab?.id || 'extension',
        url: sender?.tab?.url || null
    });
    
    if (message?.type === 'PING') {
        sendResponse({ pong: true });
        return;
    }

    // Always trigger initialization, but don't block message handling on it.
    // This prevents restart/idle delays from dropping clipboard events.
    const initTask = initialize().catch((err) => {
        console.error('CloudClip: initialize error (non-blocking)', err);
        return null;
    });

    const handleAndRespond = () => {
        return handleMessage(message, sender)
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
    };

    // For CLIPBOARD_COPIED, do not wait for init to avoid missing copies after restart.
    if (message?.type === 'CLIPBOARD_COPIED') {
        handleAndRespond();
    } else {
        initTask.then(handleAndRespond);
    }

    // Return true to indicate we'll call sendResponse asynchronously.
    return true;
});

console.log('CloudClip:SW_LISTENER_REGISTERED');

// Set alarm IMMEDIATELY (idempotent, synchronous initiation)
ensureAlarmSet();

// Initialize IMMEDIATELY on every service worker start (non-blocking)
initialize().catch((err) => {
    console.error('CloudClip: Top-level initialize error:', err);
});