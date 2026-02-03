/**
 * CloudClip Content Script
 * Listens for copy events and sends clipboard content to background worker
 */

// IMMEDIATE LOG - This should appear if the file loads at all
console.log('🔵 CloudClip: Content script FILE LOADED');
console.log('CloudClip:DEBUG content boot', {
    href: window.location.href,
    top: window === window.top
});

// Prevent multiple injections
if (window.cloudClipInjected) {
    console.log('🟡 CloudClip: Content script already injected (duplicate run)');
} else {
    window.cloudClipInjected = true;
    console.log('🟢 CloudClip: Setting cloudClipInjected = true');

    /**
     * State tracking
     */
    let captureEnabled = false;  // Start disabled, enable based on storage
    let lastCopiedContent = '';
    let lastCopyTime = 0;
    const COPY_DEBOUNCE_MS = 500;

    /**
     * Initialize content script
     */
    async function initialize() {
        // Check auto-capture setting from storage BEFORE enabling
        try {
            const result = await chrome.storage.local.get('cloudclip_auto_capture');
            // Default to true if not set, false if explicitly disabled
            captureEnabled = result.cloudclip_auto_capture !== false;
        } catch (e) {
            // If storage access fails, default to enabled
            captureEnabled = true;
        }
        console.log('CloudClip:DEBUG captureEnabled', { enabled: captureEnabled });

        // Add copy event listener
        document.addEventListener('copy', handleCopy, true);

        // Listen for messages from background
        chrome.runtime.onMessage.addListener(handleMessage);

        // Listen for storage changes to react to setting toggles
        chrome.storage.onChanged.addListener((changes, area) => {
            if (area === 'local' && changes.cloudclip_auto_capture) {
                captureEnabled = changes.cloudclip_auto_capture.newValue !== false;
                console.log('CloudClip: Auto-capture changed to:', captureEnabled);
            }
        });

        const isIframe = window !== window.top;
        console.log(`CloudClip: Content script initialized on ${window.location.href} (iframe: ${isIframe}, capture: ${captureEnabled})`);
    }

    /**
     * Handle copy events
     * @param {ClipboardEvent} event - Copy event
     */
    function handleCopy(event) {
        if (!captureEnabled) return;

        // Debounce rapid copies
        const now = Date.now();
        if (now - lastCopyTime < COPY_DEBOUNCE_MS) {
            return;
        }
        lastCopyTime = now;

        // Get clipboard content
        let content = '';

        // 1. Try to get selected text from window selection
        const selection = window.getSelection();
        if (selection && selection.toString().trim()) {
            content = selection.toString();
        } 
        // 2. Try to get text from active input/textarea
        else if (document.activeElement && 
                (document.activeElement.tagName === 'INPUT' || document.activeElement.tagName === 'TEXTAREA')) {
            const el = document.activeElement;
            // Check if there is a selection range
            if (typeof el.selectionStart === 'number' && el.selectionEnd > el.selectionStart) {
                content = el.value.substring(el.selectionStart, el.selectionEnd);
            }
        }
        // 3. Fallback to clipboard data (unreliable for copy, but kept as backup)
        else if (event.clipboardData) {
            content = event.clipboardData.getData('text/plain');
        }

        // Skip if empty or same as last copy
        if (!content || content.trim() === '' || content === lastCopiedContent) {
            return;
        }

        lastCopiedContent = content;

        // Send to background worker
        sendToBackground({
            type: 'CLIPBOARD_COPIED',
            payload: {
                content: content,
                url: window.location.href,
                timestamp: Date.now(),
                pageTitle: document.title,
            }
        });
    }

    /**
     * Handle messages from background
     * @param {Object} message - Message object
     * @param {Object} sender - Sender info
     * @param {Function} sendResponse - Response callback
     */
    function handleMessage(message, sender, sendResponse) {
        switch (message.type) {
            case 'DISABLE_CAPTURE':
                captureEnabled = false;
                console.log('CloudClip: Capture disabled');
                sendResponse({ success: true });
                break;

            case 'ENABLE_CAPTURE':
                captureEnabled = true;
                console.log('CloudClip: Capture enabled');
                sendResponse({ success: true });
                break;

            case 'GET_STATUS':
                sendResponse({
                    enabled: captureEnabled,
                    url: window.location.href
                });
                break;

            case 'PING':
                sendResponse({ pong: true });
                break;
        }

        return true;
    }

    /**
     * Send message to background worker
     * @param {Object} message - Message to send
     */
    function sendToBackground(message) {
        // Check if extension context is still valid
        if (!chrome.runtime?.id) {
            console.warn('CloudClip: Extension context invalid, disabling capture');
            captureEnabled = false;
            return;
        }

        console.log('CloudClip: Sending to background:', message.type, message.payload?.content?.substring(0, 50));
        console.log('CloudClip:DEBUG sendToBackground', {
            type: message.type,
            hasRuntime: !!chrome.runtime?.id
        });
        sendWithRetry(message, 3);
    }

    /**
     * Retry sendMessage to handle MV3 service worker wake-up
     * @param {Object} message
     * @param {number} attempts
     */
    function sendWithRetry(message, attempts) {
        try {
            chrome.runtime.sendMessage(message)
                .then(response => {
                    console.log('CloudClip: Background response:', response);
                    console.log('CloudClip:DEBUG send response', response);
                })
                .catch(err => {
                    const msg = err?.message || '';

                    // If extension context invalidated, this indicates extension reload — disable capture
                    if (msg.includes('Extension context invalidated')) {
                        console.warn('CloudClip: Extension context invalidated, disabling capture');
                        captureEnabled = false;
                        return;
                    }

                    // Common MV3 wake timing: receiving end not available yet — retry
                    if (msg.includes('Receiving end does not exist')) {
                        if (attempts > 0) {
                            console.warn('CloudClip: Service worker not responding, retrying...', attempts);
                            setTimeout(() => sendWithRetry(message, attempts - 1), 300);
                            return;
                        }
                        console.warn('CloudClip: Service worker still unavailable after retries');
                        return;
                    }

                    // Non-fatal: Chrome may report that "A listener indicated an asynchronous response..."
                    // when a listener returned true but failed to respond before the channel closed.
                    // Treat these as debug-level and don't disable capture.
                    if (msg.includes('asynchronous response') || msg.includes('message channel closed') || msg.includes('channel closed')) {
                        console.debug('CloudClip: Non-fatal messaging note:', msg);
                        return;
                    }

                    // Otherwise log as error
                    console.error('CloudClip: Could not send message:', err);
                    console.error('CloudClip:DEBUG send error', err);
                });
        } catch (err) {
            console.error('CloudClip: Sync error in sendToBackground:', err);
            captureEnabled = false;
            console.error('CloudClip:DEBUG sendToBackground exception', err);
        }
    }

    /**
     * Clean up when content script is unloaded
     */
    function cleanup() {
        document.removeEventListener('copy', handleCopy, true);
        captureEnabled = false;
    }

    // Handle page unload
    window.addEventListener('pagehide', cleanup);

    // Initialize
    initialize();
}
