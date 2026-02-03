/**
 * Minimal Background Service Worker - Supabase Upload
 * 
 * SECURITY NOTES:
 * - The anon key is safe to include in client-side code
 * - It only allows operations permitted by Row Level Security (RLS) policies
 * - Your Supabase RLS policies should restrict users to their own data
 * - Never include the service_role key in client code
 */

// =============================================================================
// CONFIGURATION - Replace with your Supabase credentials
// =============================================================================
const SUPABASE_URL = 'https://YOUR_PROJECT_REF.supabase.co';
const SUPABASE_ANON_KEY = 'YOUR_ANON_KEY_HERE';  // Safe to include - RLS enforces security

// =============================================================================
// MESSAGE HANDLER
// =============================================================================

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === 'CLIPBOARD_COPY') {
        handleClipboardCopy(message.data, sender)
            .then(sendResponse)
            .catch(err => sendResponse({ success: false, error: err.message }));
        return true; // Keep channel open for async response
    }
});

/**
 * Handle clipboard copy event
 */
async function handleClipboardCopy(data, sender) {
    console.log('[Background] Received clipboard copy:', data.content.substring(0, 50));

    // Get auth token from storage (you'd set this after user login)
    const { auth_token } = await chrome.storage.local.get('auth_token');
    
    if (!auth_token) {
        console.log('[Background] Not authenticated, skipping upload');
        return { success: false, error: 'Not authenticated' };
    }

    try {
        const response = await fetch(`${SUPABASE_URL}/rest/v1/clipboard_items`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'apikey': SUPABASE_ANON_KEY,
                'Authorization': `Bearer ${auth_token}`,
                'Prefer': 'return=representation'  // Return the inserted row
            },
            body: JSON.stringify({
                content: data.content,
                origin: data.url,
                page_title: data.title,
                // user_id is set automatically by RLS or database trigger
            })
        });

        if (!response.ok) {
            const errorText = await response.text();
            console.error('[Background] Supabase error:', response.status, errorText);
            return { success: false, error: `HTTP ${response.status}: ${errorText}` };
        }

        const result = await response.json();
        console.log('[Background] Upload success:', result);
        return { success: true, item: result[0] };

    } catch (err) {
        console.error('[Background] Network error:', err);
        return { success: false, error: err.message };
    }
}

// =============================================================================
// SERVICE WORKER LIFECYCLE
// =============================================================================

// Log when service worker starts
console.log('[Background] Service worker started');

// MV3 service workers can be terminated after ~30s of inactivity
// When a message arrives, Chrome will wake the worker automatically
// No keep-alive needed for basic message handling

chrome.runtime.onInstalled.addListener((details) => {
    console.log('[Background] Extension installed/updated:', details.reason);
});

chrome.runtime.onStartup.addListener(() => {
    console.log('[Background] Browser started');
});
