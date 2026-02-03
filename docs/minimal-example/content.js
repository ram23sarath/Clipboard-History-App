/**
 * Minimal Content Script - Copy Event Capture
 * This script captures copy events and sends them to the background service worker
 */

(function() {
    // Prevent double injection
    if (window.__clipboardCaptureInjected) return;
    window.__clipboardCaptureInjected = true;

    console.log('[ClipCapture] Content script loaded on:', location.href);

    document.addEventListener('copy', async (event) => {
        // Get the selected text (most reliable method)
        let text = '';
        
        // Method 1: Window selection (works for most cases)
        const selection = window.getSelection();
        if (selection && selection.toString().trim()) {
            text = selection.toString();
        }
        // Method 2: Active input/textarea selection
        else if (document.activeElement) {
            const el = document.activeElement;
            if ((el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') &&
                typeof el.selectionStart === 'number' &&
                el.selectionEnd > el.selectionStart) {
                text = el.value.substring(el.selectionStart, el.selectionEnd);
            }
        }

        if (!text || text.trim().length === 0) {
            console.log('[ClipCapture] Empty selection, skipping');
            return;
        }

        console.log('[ClipCapture] Captured text:', text.substring(0, 50) + '...');

        // Send to background - use try/catch for robustness
        try {
            const response = await chrome.runtime.sendMessage({
                type: 'CLIPBOARD_COPY',
                data: {
                    content: text,
                    url: location.href,
                    title: document.title,
                    timestamp: Date.now()
                }
            });
            console.log('[ClipCapture] Background response:', response);
        } catch (err) {
            // Common errors:
            // - "Receiving end does not exist" = SW is sleeping (normal in MV3)
            // - "Extension context invalidated" = extension reloaded
            console.warn('[ClipCapture] Failed to send:', err.message);
        }
    }, true); // Use capture phase to intercept before page handlers

})();
