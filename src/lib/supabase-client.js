/**
 * Supabase Client Module
 * Initializes and exports the Supabase client with session handling
 */

// Import from node_modules - esbuild will bundle it
import { createClient } from '@supabase/supabase-js';
import { CONFIG, validateConfig } from '../config.js';

let supabaseClient = null;
const SUPABASE_STORAGE_KEY = (() => {
    try {
        const hostname = new URL(CONFIG.SUPABASE_URL).hostname;
        const projectRef = hostname.split('.')[0];
        return `sb-${projectRef}-auth-token`;
    } catch (err) {
        console.warn('CloudClip: Failed to compute Supabase storage key:', err);
        return null;
    }
})();

/**
 * Initialize the Supabase client
 * Uses the anon key (never the service role key)
 * @returns {Object} Supabase client instance
 */
export function getSupabaseClient() {
    if (supabaseClient) {
        return supabaseClient;
    }

    const errors = validateConfig();
    if (errors.length > 0) {
        console.error('CloudClip Configuration Errors:', errors);
        throw new Error('Supabase not configured. Please update src/config.js');
    }

    supabaseClient = createClient(
        CONFIG.SUPABASE_URL,
        CONFIG.SUPABASE_ANON_KEY,
        {
            auth: {
                autoRefreshToken: true,
                persistSession: true,
                detectSessionInUrl: false,
                storageKey: SUPABASE_STORAGE_KEY || undefined,
                storage: {
                    // Custom storage adapter for Chrome extension
                    getItem: async (key) => {
                        const result = await chrome.storage.local.get(key);
                        return result[key] || null;
                    },
                    setItem: async (key, value) => {
                        await chrome.storage.local.set({ [key]: value });
                    },
                    removeItem: async (key) => {
                        await chrome.storage.local.remove(key);
                    },
                },
            },
            realtime: {
                params: {
                    eventsPerSecond: 10,
                },
            },
        }
    );

    return supabaseClient;
}

/**
 * Get the current session from Supabase
 * @returns {Promise<Object|null>} Current session or null
 */
export async function getSession() {
    const client = getSupabaseClient();
    try {
        const { data: { session }, error } = await client.auth.getSession();

        if (error) {
            // If the refresh token is invalid, force sign out to clear the bad state
            if (error.message && (error.message.includes('Refresh Token Not Found') || error.message.includes('Invalid Refresh Token'))) {
                console.log('CloudClip: Invalid session detected (bad refresh token), signing out...');
                await client.auth.signOut().catch(() => { });
                return null;
            }

            console.error('Error getting session:', error);
            return null;
        }

        return session;
    } catch (err) {
        console.error('CloudClip: Unexpected error getting session:', err);
        return null;
    }
}

/**
 * Check if user is authenticated
 * @returns {Promise<boolean>}
 */
export async function isAuthenticated() {
    const session = await getSession();
    return session !== null;
}

/**
 * Get the current user ID
 * @returns {Promise<string|null>}
 */
export async function getCurrentUserId() {
    const session = await getSession();
    return session?.user?.id || null;
}

/**
 * Refresh the session if needed
 * @returns {Promise<Object|null>} New session or null
 */
export async function refreshSession() {
    const client = getSupabaseClient();
    const { data: { session }, error } = await client.auth.refreshSession();

    if (error) {
        // Expected when there is no stored session after restart.
        if (error?.message && error.message.includes('Auth session missing')) {
            return null;
        }
        console.error('Error refreshing session:', error);
        return null;
    }

    return session;
}

/**
 * Subscribe to auth state changes
 * @param {Function} callback - Callback function (event, session)
 * @returns {Object} Subscription object with unsubscribe method
 */
export function onAuthStateChange(callback) {
    const client = getSupabaseClient();
    const { data: { subscription } } = client.auth.onAuthStateChange(callback);
    return subscription;
}

export { supabaseClient };
