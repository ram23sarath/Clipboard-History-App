/**
 * Authentication Module
 * Handles user authentication with Supabase
 */

import { getSupabaseClient, getSession } from './supabase-client.js';

/**
 * Sign up a new user with email and password
 * @param {string} email - User's email
 * @param {string} password - User's password
 * @returns {Promise<{success: boolean, user?: Object, error?: string}>}
 */
export async function signUp(email, password) {
    try {
        const client = getSupabaseClient();
        const { data, error } = await client.auth.signUp({
            email,
            password,
        });

        if (error) {
            return { success: false, error: error.message };
        }

        // Initialize user preferences after signup
        if (data.user) {
            await initializeUserPreferences(data.user.id);
        }

        return { success: true, user: data.user };
    } catch (err) {
        console.error('SignUp error:', err);
        return { success: false, error: 'An unexpected error occurred' };
    }
}

/**
 * Sign in an existing user with email and password
 * @param {string} email - User's email
 * @param {string} password - User's password
 * @returns {Promise<{success: boolean, user?: Object, session?: Object, error?: string}>}
 */
export async function signIn(email, password) {
    try {
        const client = getSupabaseClient();
        const { data, error } = await client.auth.signInWithPassword({
            email,
            password,
        });

        if (error) {
            return { success: false, error: error.message };
        }

        return {
            success: true,
            user: data.user,
            session: data.session
        };
    } catch (err) {
        console.error('SignIn error:', err);
        return { success: false, error: 'An unexpected error occurred' };
    }
}

/**
 * Sign out the current user
 * @returns {Promise<{success: boolean, error?: string}>}
 */
export async function signOut() {
    try {
        const client = getSupabaseClient();
        const { error } = await client.auth.signOut();

        if (error) {
            return { success: false, error: error.message };
        }

        // Clear local cached data
        await chrome.storage.local.remove([
            'cloudclip_cached_items',
            'cloudclip_last_sync',
        ]);

        return { success: true };
    } catch (err) {
        console.error('SignOut error:', err);
        return { success: false, error: 'An unexpected error occurred' };
    }
}

/**
 * Send password reset email
 * @param {string} email - User's email
 * @returns {Promise<{success: boolean, error?: string}>}
 */
export async function resetPassword(email) {
    try {
        const client = getSupabaseClient();
        const { error } = await client.auth.resetPasswordForEmail(email);

        if (error) {
            return { success: false, error: error.message };
        }

        return { success: true };
    } catch (err) {
        console.error('ResetPassword error:', err);
        return { success: false, error: 'An unexpected error occurred' };
    }
}

/**
 * Get the current user's profile
 * @returns {Promise<Object|null>}
 */
export async function getCurrentUser() {
    const session = await getSession();
    return session?.user || null;
}

/**
 * Initialize default preferences for a new user
 * @param {string} userId - User's ID
 */
async function initializeUserPreferences(userId) {
    try {
        const client = getSupabaseClient();
        await client.from('user_preferences').upsert({
            user_id: userId,
            auto_capture_enabled: false,
            max_items: 50,
        }, {
            onConflict: 'user_id',
        });
    } catch (err) {
        console.error('Error initializing preferences:', err);
    }
}

/**
 * Delete all user data (GDPR compliance)
 * @returns {Promise<{success: boolean, error?: string}>}
 */
export async function deleteAllUserData() {
    try {
        const client = getSupabaseClient();
        const session = await getSession();

        if (!session?.user?.id) {
            return { success: false, error: 'Not authenticated' };
        }

        const userId = session.user.id;

        // Delete all clipboard items
        const { error: clipboardError } = await client
            .from('clipboard_items')
            .delete()
            .eq('user_id', userId);

        if (clipboardError) {
            console.error('Error deleting clipboard items:', clipboardError);
        }

        // Delete all device records
        const { error: devicesError } = await client
            .from('user_devices')
            .delete()
            .eq('user_id', userId);

        if (devicesError) {
            console.error('Error deleting devices:', devicesError);
        }

        // Delete preferences
        const { error: prefsError } = await client
            .from('user_preferences')
            .delete()
            .eq('user_id', userId);

        if (prefsError) {
            console.error('Error deleting preferences:', prefsError);
        }

        // Clear local storage
        await chrome.storage.local.clear();

        return { success: true };
    } catch (err) {
        console.error('DeleteAllUserData error:', err);
        return { success: false, error: 'An unexpected error occurred' };
    }
}
