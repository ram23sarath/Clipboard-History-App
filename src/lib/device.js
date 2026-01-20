/**
 * Device Management Module
 * Handles device ID generation, naming, and cleanup
 */

import { getSupabaseClient, getSession } from './supabase-client.js';
import { CONFIG } from '../config.js';

/**
 * Generate a unique device ID
 * Uses crypto API for randomness
 * @returns {string} Unique device ID
 */
function generateDeviceId() {
    const array = new Uint8Array(16);
    crypto.getRandomValues(array);
    return Array.from(array, byte => byte.toString(16).padStart(2, '0')).join('');
}

/**
 * Get or create the device ID for this browser instance
 * @returns {Promise<string>} Device ID
 */
export async function getDeviceId() {
    const key = CONFIG.STORAGE_KEYS.DEVICE_ID;
    const result = await chrome.storage.local.get(key);

    if (result[key]) {
        return result[key];
    }

    // Generate new device ID
    const deviceId = generateDeviceId();
    await chrome.storage.local.set({ [key]: deviceId });

    return deviceId;
}

/**
 * Get the device name
 * @returns {Promise<string>} Device name
 */
export async function getDeviceName() {
    const key = CONFIG.STORAGE_KEYS.DEVICE_NAME;
    const result = await chrome.storage.local.get(key);

    if (result[key]) {
        return result[key];
    }

    // Generate default device name
    const defaultName = await generateDefaultDeviceName();
    await chrome.storage.local.set({ [key]: defaultName });

    return defaultName;
}

/**
 * Set a custom device name
 * @param {string} name - New device name
 * @returns {Promise<void>}
 */
export async function setDeviceName(name) {
    const key = CONFIG.STORAGE_KEYS.DEVICE_NAME;
    const sanitizedName = name.trim().substring(0, 50); // Limit length

    await chrome.storage.local.set({ [key]: sanitizedName });

    // Update device record in database if authenticated
    const session = await getSession();
    if (session?.user?.id) {
        await updateDeviceRecord(session.user.id);
    }
}

/**
 * Generate a default device name based on platform info
 * @returns {Promise<string>} Default device name
 */
async function generateDefaultDeviceName() {
    try {
        const platformInfo = await chrome.runtime.getPlatformInfo();
        const os = platformInfo.os.charAt(0).toUpperCase() + platformInfo.os.slice(1);
        const arch = platformInfo.arch;

        // Get browser info
        const browserInfo = navigator.userAgent;
        let browser = 'Chrome';

        if (browserInfo.includes('Edg/')) {
            browser = 'Edge';
        } else if (browserInfo.includes('Brave')) {
            browser = 'Brave';
        }

        return `${browser} on ${os}`;
    } catch (err) {
        console.error('Error getting platform info:', err);
        return 'Unknown Device';
    }
}

/**
 * Register or update this device in the database
 * @param {string} userId - User ID
 * @returns {Promise<void>}
 */
export async function updateDeviceRecord(userId) {
    try {
        const client = getSupabaseClient();
        const deviceId = await getDeviceId();
        const deviceName = await getDeviceName();

        await client.from('user_devices').upsert({
            user_id: userId,
            device_id: deviceId,
            device_name: deviceName,
            last_seen_at: new Date().toISOString(),
            is_active: true,
        }, {
            onConflict: 'user_id,device_id',
        });
    } catch (err) {
        console.error('Error updating device record:', err);
    }
}

/**
 * Get all devices for the current user
 * @returns {Promise<Array>} List of devices
 */
export async function getUserDevices() {
    try {
        const client = getSupabaseClient();
        const session = await getSession();

        if (!session?.user?.id) {
            return [];
        }

        const { data, error } = await client
            .from('user_devices')
            .select('*')
            .eq('user_id', session.user.id)
            .order('last_seen_at', { ascending: false });

        if (error) {
            console.error('Error fetching devices:', error);
            return [];
        }

        return data || [];
    } catch (err) {
        console.error('Error getting user devices:', err);
        return [];
    }
}

/**
 * Remove this device's record from the database
 * Called on extension uninstall
 * @returns {Promise<void>}
 */
export async function removeDeviceRecord() {
    try {
        const client = getSupabaseClient();
        const session = await getSession();

        if (!session?.user?.id) {
            return;
        }

        const deviceId = await getDeviceId();

        await client
            .from('user_devices')
            .delete()
            .eq('user_id', session.user.id)
            .eq('device_id', deviceId);

        // Also soft-delete clipboard items from this device
        await client
            .from('clipboard_items')
            .update({ is_deleted: true, deleted_at: new Date().toISOString() })
            .eq('user_id', session.user.id)
            .eq('device_id', deviceId);

    } catch (err) {
        console.error('Error removing device record:', err);
    }
}

/**
 * Mark a device as inactive
 * @param {string} deviceId - Device ID to deactivate
 * @returns {Promise<boolean>} Success status
 */
export async function deactivateDevice(deviceId) {
    try {
        const client = getSupabaseClient();
        const session = await getSession();

        if (!session?.user?.id) {
            return false;
        }

        const { error } = await client
            .from('user_devices')
            .update({ is_active: false })
            .eq('user_id', session.user.id)
            .eq('device_id', deviceId);

        return !error;
    } catch (err) {
        console.error('Error deactivating device:', err);
        return false;
    }
}
