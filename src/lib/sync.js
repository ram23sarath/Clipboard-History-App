/**
 * Sync Module
 * Handles clipboard item synchronization with Supabase
 * Includes debouncing, rate limiting, and retry logic
 */

import { getSupabaseClient, getSession } from './supabase-client.js';
import { getDeviceId, getDeviceName } from './device.js';
import { redactSensitiveData, hashContent, truncateContent } from './redaction.js';
import { CONFIG } from '../config.js';

// Rate limiting state
const rateLimitState = {
    requestCount: 0,
    windowStart: Date.now(),
};

// Debounce state
const debounceTimers = new Map();

// Track recently uploaded hashes to prevent loops
const recentlyUploaded = new Set();
const UPLOAD_HASH_TTL = 5000; // 5 seconds

// Realtime subscription
let realtimeSubscription = null;

/**
 * Upload a clipboard item to Supabase
 * Applies debouncing, rate limiting, and redaction
 * @param {string} content - Clipboard content
 * @param {Object} options - Upload options
 * @returns {Promise<{success: boolean, item?: Object, error?: string}>}
 */
export async function uploadClipboardItem(content, options = {}) {
    const {
        skipDebounce = false,
        origin = 'extension',
    } = options;

    // Check if content is valid
    if (!content || typeof content !== 'string' || content.trim().length === 0) {
        return { success: false, error: 'Empty content' };
    }

    // Generate content hash for duplicate/loop detection
    const contentHash = hashContent(content);

    // Prevent upload loops - skip if we recently uploaded this content
    if (recentlyUploaded.has(contentHash)) {
        return { success: false, error: 'Duplicate content (upload loop prevention)' };
    }

    // Check rate limit
    if (!checkRateLimit()) {
        return { success: false, error: 'Rate limit exceeded' };
    }

    // Apply debounce unless skipped
    if (!skipDebounce) {
        return new Promise((resolve) => {
            // Clear existing timer for this hash
            if (debounceTimers.has(contentHash)) {
                clearTimeout(debounceTimers.get(contentHash));
            }

            // Set new timer
            const timer = setTimeout(async () => {
                debounceTimers.delete(contentHash);
                const result = await performUpload(content, contentHash, origin);
                resolve(result);
            }, CONFIG.SYNC.DEBOUNCE_MS);

            debounceTimers.set(contentHash, timer);
        });
    }

    return performUpload(content, contentHash, origin);
}

/**
 * Perform the actual upload to Supabase
 * @param {string} content - Original content
 * @param {string} contentHash - Content hash
 * @param {string} origin - Origin identifier
 * @returns {Promise<Object>}
 */
async function performUpload(content, contentHash, origin) {
    try {
        const session = await getSession();
        if (!session?.user?.id) {
            return { success: false, error: 'Not authenticated' };
        }

        const client = getSupabaseClient();
        const deviceId = await getDeviceId();
        const deviceName = await getDeviceName();

        // Truncate if too long
        const { content: truncatedContent } = truncateContent(content);

        // Apply redaction
        const { redacted, wasRedacted, redactionTypes } = redactSensitiveData(truncatedContent);

        if (wasRedacted) {
            console.log('CloudClip: Redacted sensitive data:', redactionTypes);
        }

        // Check for duplicate in database
        const { data: existing } = await client
            .from('clipboard_items')
            .select('id')
            .eq('user_id', session.user.id)
            .eq('content_hash', contentHash)
            .eq('is_deleted', false)
            .limit(1);

        if (existing && existing.length > 0) {
            return { success: false, error: 'Duplicate content' };
        }

        // Upload with retry
        const result = await retryWithBackoff(async () => {
            const { data, error } = await client
                .from('clipboard_items')
                .insert({
                    user_id: session.user.id,
                    content: redacted,
                    device_id: deviceId,
                    device_name: deviceName,
                    origin: origin,
                    content_hash: contentHash,
                })
                .select()
                .single();

            if (error) throw error;
            return data;
        });

        // Mark as recently uploaded to prevent loops
        recentlyUploaded.add(contentHash);
        setTimeout(() => recentlyUploaded.delete(contentHash), UPLOAD_HASH_TTL);

        // Update rate limit counter
        incrementRateLimit();

        return { success: true, item: result };
    } catch (err) {
        console.error('Upload error:', err);
        return { success: false, error: err.message };
    }
}

/**
 * Fetch clipboard items from Supabase
 * @param {Object} options - Fetch options
 * @returns {Promise<{success: boolean, items?: Array, error?: string}>}
 */
export async function fetchClipboardItems(options = {}) {
    const {
        limit = CONFIG.SYNC.FETCH_LIMIT,
        offset = 0,
        since = null,
    } = options;

    try {
        const session = await getSession();
        if (!session?.user?.id) {
            return { success: false, error: 'Not authenticated' };
        }

        const client = getSupabaseClient();

        let query = client
            .from('clipboard_items')
            .select('*')
            .eq('user_id', session.user.id)
            .eq('is_deleted', false)
            .order('created_at', { ascending: false })
            .range(offset, offset + limit - 1);

        // Filter by date if provided
        if (since) {
            query = query.gte('created_at', since);
        }

        const { data, error } = await query;

        if (error) {
            console.error('Fetch error:', error);
            return { success: false, error: error.message };
        }

        // Cache the items locally
        await cacheItems(data);

        return { success: true, items: data || [] };
    } catch (err) {
        console.error('Fetch error:', err);
        return { success: false, error: err.message };
    }
}

/**
 * Delete a clipboard item (soft delete)
 * @param {string} itemId - Item ID to delete
 * @returns {Promise<{success: boolean, error?: string}>}
 */
export async function deleteClipboardItem(itemId) {
    try {
        const session = await getSession();
        if (!session?.user?.id) {
            return { success: false, error: 'Not authenticated' };
        }

        const client = getSupabaseClient();

        const { error } = await client
            .from('clipboard_items')
            .update({
                is_deleted: true,
                deleted_at: new Date().toISOString()
            })
            .eq('id', itemId)
            .eq('user_id', session.user.id);

        if (error) {
            return { success: false, error: error.message };
        }

        return { success: true };
    } catch (err) {
        console.error('Delete error:', err);
        return { success: false, error: err.message };
    }
}

/**
 * Set up Supabase Realtime subscription for clipboard items
 * @param {Function} onInsert - Callback for new items
 * @param {Function} onDelete - Callback for deleted items
 * @returns {Object} Subscription object
 */
export async function subscribeToClipboardChanges(onInsert, onDelete) {
    try {
        const session = await getSession();
        if (!session?.user?.id) {
            console.error('Cannot subscribe: not authenticated');
            return null;
        }

        const client = getSupabaseClient();
        const deviceId = await getDeviceId();

        // Unsubscribe from existing subscription
        if (realtimeSubscription) {
            realtimeSubscription.unsubscribe();
        }

        realtimeSubscription = client
            .channel('clipboard_changes')
            .on(
                'postgres_changes',
                {
                    event: 'INSERT',
                    schema: 'public',
                    table: 'clipboard_items',
                    filter: `user_id=eq.${session.user.id}`,
                },
                (payload) => {
                    // Ignore items from this device (prevent showing our own uploads)
                    if (payload.new.device_id !== deviceId) {
                        onInsert?.(payload.new);
                    }
                }
            )
            .on(
                'postgres_changes',
                {
                    event: 'UPDATE',
                    schema: 'public',
                    table: 'clipboard_items',
                    filter: `user_id=eq.${session.user.id}`,
                },
                (payload) => {
                    // Handle soft deletes
                    if (payload.new.is_deleted && !payload.old.is_deleted) {
                        onDelete?.(payload.new);
                    }
                }
            )
            .subscribe((status) => {
                console.log('Realtime subscription status:', status);
            });

        return realtimeSubscription;
    } catch (err) {
        console.error('Subscription error:', err);
        return null;
    }
}

/**
 * Unsubscribe from Realtime changes
 */
export function unsubscribeFromClipboardChanges() {
    if (realtimeSubscription) {
        realtimeSubscription.unsubscribe();
        realtimeSubscription = null;
    }
}

/**
 * Merge local cached items with server items
 * @param {Array} serverItems - Items from server
 * @returns {Array} Merged items
 */
export async function mergeWithLocalCache(serverItems) {
    try {
        const key = CONFIG.STORAGE_KEYS.CACHED_ITEMS;
        const result = await chrome.storage.local.get(key);
        const cachedItems = result[key] || [];

        // Create a map for deduplication
        const itemMap = new Map();

        // Add server items first (they're authoritative)
        for (const item of serverItems) {
            itemMap.set(item.id, item);
        }

        // Add cached items that aren't on server (might be pending upload)
        for (const item of cachedItems) {
            if (!itemMap.has(item.id) && item.pending) {
                itemMap.set(item.id, item);
            }
        }

        // Sort by created_at descending
        const merged = Array.from(itemMap.values())
            .sort((a, b) => new Date(b.created_at) - new Date(a.created_at));

        return merged;
    } catch (err) {
        console.error('Merge error:', err);
        return serverItems;
    }
}

/**
 * Cache items locally for offline access
 * @param {Array} items - Items to cache
 */
async function cacheItems(items) {
    try {
        const key = CONFIG.STORAGE_KEYS.CACHED_ITEMS;
        await chrome.storage.local.set({
            [key]: items,
            [CONFIG.STORAGE_KEYS.LAST_SYNC]: Date.now(),
        });
    } catch (err) {
        console.error('Cache error:', err);
    }
}

/**
 * Get cached items (for offline mode)
 * @returns {Promise<Array>}
 */
export async function getCachedItems() {
    try {
        const key = CONFIG.STORAGE_KEYS.CACHED_ITEMS;
        const result = await chrome.storage.local.get(key);
        return result[key] || [];
    } catch (err) {
        console.error('Get cache error:', err);
        return [];
    }
}

/**
 * Check if request is within rate limit
 * @returns {boolean}
 */
function checkRateLimit() {
    const now = Date.now();
    const windowMs = CONFIG.SYNC.RATE_LIMIT_WINDOW_MS;

    // Reset window if expired
    if (now - rateLimitState.windowStart > windowMs) {
        rateLimitState.requestCount = 0;
        rateLimitState.windowStart = now;
    }

    return rateLimitState.requestCount < CONFIG.SYNC.RATE_LIMIT_MAX_REQUESTS;
}

/**
 * Increment rate limit counter
 */
function incrementRateLimit() {
    rateLimitState.requestCount++;
}

/**
 * Get current rate limit status
 * @returns {Object} Rate limit info
 */
export function getRateLimitStatus() {
    const now = Date.now();
    const windowMs = CONFIG.SYNC.RATE_LIMIT_WINDOW_MS;
    const remaining = Math.max(0, CONFIG.SYNC.RATE_LIMIT_MAX_REQUESTS - rateLimitState.requestCount);
    const resetsIn = Math.max(0, windowMs - (now - rateLimitState.windowStart));

    return {
        remaining,
        total: CONFIG.SYNC.RATE_LIMIT_MAX_REQUESTS,
        resetsIn,
    };
}

/**
 * Retry a function with exponential backoff
 * @param {Function} fn - Async function to retry
 * @param {number} attempts - Max attempts (default from config)
 * @returns {Promise<any>}
 */
async function retryWithBackoff(fn, attempts = CONFIG.SYNC.RETRY_ATTEMPTS) {
    let lastError;

    for (let i = 0; i < attempts; i++) {
        try {
            return await fn();
        } catch (err) {
            lastError = err;

            // Don't retry on auth errors
            if (err.message?.includes('auth') || err.status === 401) {
                throw err;
            }

            // Calculate delay with exponential backoff
            const delay = CONFIG.SYNC.RETRY_BASE_DELAY_MS * Math.pow(2, i);
            console.log(`Retry attempt ${i + 1}/${attempts} in ${delay}ms`);

            await new Promise(resolve => setTimeout(resolve, delay));
        }
    }

    throw lastError;
}

/**
 * Clear all pending debounce timers
 */
export function clearPendingUploads() {
    for (const timer of debounceTimers.values()) {
        clearTimeout(timer);
    }
    debounceTimers.clear();
}

// Export for testing
export const _testExports = {
    checkRateLimit,
    incrementRateLimit,
    rateLimitState,
    debounceTimers,
    recentlyUploaded,
};
