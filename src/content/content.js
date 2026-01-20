/**
 * CloudClip Content Script
 * Listens for copy events and sends clipboard content to background worker
 */

// Prevent multiple injections
if (window.cloudClipInjected) {
    console.debug('CloudClip: Content script already injected');
} else {
    window.cloudClipInjected = true;

    /**
     * State tracking
     */
    let captureEnabled = true;
    let lastCopiedContent = '';
    let lastCopyTime = 0;
    const COPY_DEBOUNCE_MS = 500;

    /**
     * Initialize content script
     */
    function initialize() {
        // Add copy event listener
        document.addEventListener('copy', handleCopy, true);

        // Listen for messages from background
        chrome.runtime.onMessage.addListener(handleMessage);

        console.log('CloudClip: Content script initialized on', window.location.href);
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

        // Try to get selected text first
        const selection = window.getSelection();
        if (selection && selection.toString().trim()) {
            content = selection.toString();
        } else if (event.clipboardData) {
            // Fallback to clipboard data
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
        chrome.runtime.sendMessage(message).catch(err => {
            // Extension might have been reloaded
            console.debug('CloudClip: Could not send message:', err);
        });
    }

    /**
     * Clean up when content script is unloaded
     */
    function cleanup() {
        document.removeEventListener('copy', handleCopy, true);
        captureEnabled = false;
    }

    // Handle page unload
    window.addEventListener('unload', cleanup);

    // Initialize
    initialize();
}
