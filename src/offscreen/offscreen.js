/**
 * CloudClip Offscreen Document Script
 * Handles clipboard operations that cannot be done in service worker
 */

// Listen for messages from the service worker
chrome.runtime.onMessage.addListener((message) => {
    if (message.target !== 'offscreen') return;

    if (message.type === 'OFFSCREEN_COPY') {
        handleCopy(message.text);
    }
});

/**
 * Copy text to clipboard
 * @param {string} text - Text to copy
 */
async function handleCopy(text) {
    const textarea = document.getElementById('clipboard-area');
    textarea.value = text;
    textarea.select();

    try {
        // Try modern API first
        await navigator.clipboard.writeText(text);
    } catch (err) {
        // Fallback to execCommand
        document.execCommand('copy');
    }

    // Clear the textarea
    textarea.value = '';
}
