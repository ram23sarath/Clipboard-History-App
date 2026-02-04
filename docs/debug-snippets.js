/**
 * DEBUG SNIPPETS - Drop these into DevTools console to diagnose lifecycle issues
 * 
 * SERVICE WORKER (chrome://extensions → Inspect views: service worker):
 */

// --- SW Debug Snippet ---
// Paste in service worker DevTools console:
/*
console.log('=== SW LIFECYCLE DEBUG ===');
console.log('runtime.id:', chrome.runtime?.id);
console.log('SW state:', navigator?.serviceWorker?.controller?.state);
chrome.storage.local.get(null, d => console.log('storage:', d));
chrome.tabs.query({}, tabs => console.log('tabs:', tabs.length, tabs.map(t => t.url?.slice(0,50))));
*/

// --- CONTENT SCRIPT Debug Snippet ---
// Paste in any page's DevTools console:
/*
console.log('=== CONTENT LIFECYCLE DEBUG ===');
console.log('__cloudClipInitialized_v1:', window.__cloudClipInitialized_v1);
console.log('runtime.id:', chrome.runtime?.id);
chrome.runtime.sendMessage({ type: 'PING' }, r => console.log('SW response:', r));
*/

// --- FULL DIAGNOSTIC (run from any page) ---
/*
(async () => {
  console.log('=== FULL CLOUDCLIP DIAGNOSTIC ===');
  console.log('1. Extension context:', !!chrome.runtime?.id);
  console.log('2. Content guard:', window.__cloudClipInitialized_v1);
  try {
    const r = await chrome.runtime.sendMessage({ type: 'PING' });
    console.log('3. SW alive:', r?.pong === true);
  } catch (e) {
    console.log('3. SW dead/unreachable:', e.message);
  }
  try {
    const s = await chrome.storage.local.get(['cloudclip_auto_capture']);
    console.log('4. Auto-capture:', s.cloudclip_auto_capture !== false);
  } catch (e) {
    console.log('4. Storage error:', e.message);
  }
})();
*/
