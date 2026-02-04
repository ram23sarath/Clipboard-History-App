# Test Plan: Chrome Extension Lifecycle Robustness

## Test 1: Fresh System Boot + First Chrome Open

**Steps:**

1. Uninstall CloudClip extension completely
2. Close all Chrome windows
3. Reboot system (or restart Chrome with `--restore-last-session` disabled)
4. Open Chrome fresh
5. Run `npm run build`
6. Go to `chrome://extensions` → Load unpacked → select the `dist` folder
7. Open any webpage (e.g., `https://example.com`)
8. Select text and press Ctrl+C
9. Click CloudClip popup

**Expected Logs (Service Worker):**

```
CloudClip:SW_BOOT { time: ..., runtimeId: ... }
CloudClip: Initializing service worker...
CloudClip:DEBUG init complete
```

**Expected Logs (Content Script - page console):**

```
CloudClip:BOOT content script loaded { href: ..., isTop: true }
CloudClip:DEBUG captureEnabled { enabled: true }
CloudClip: Sending to background: CLIPBOARD_COPIED
```

**Expected Result:** Copied text appears in popup.

---

## Test 2: Close and Reopen Chrome (Window Restore)

**Steps:**

1. With extension installed, copy some text on a page
2. Close Chrome completely (all windows)
3. Reopen Chrome (window restore enabled - default)
4. Wait for tabs to restore
5. On restored tab, select new text and Ctrl+C
6. Open popup

**Expected Logs (Service Worker after reopen):**

```
CloudClip:SW_BOOT { time: ..., runtimeId: ... }
CloudClip:DEBUG onStartup
```

**Expected Logs (Content Script on restored tab):**

```
CloudClip:BOOT content script loaded { href: ... }
```

**Expected Result:** New copy works immediately. No "Receiving end does not exist" errors.

---

## Test 3: Extension Update (Version Bump)

**Steps:**

1. Bump `version` in `manifest.json` (e.g., `1.0.2` → `1.0.3`)
2. Go to `chrome://extensions`
3. Click "Update" or reload the extension
4. Open a new tab to `https://example.com`
5. Copy text

**Expected Logs (Service Worker):**

```
CloudClip: Extension installed/updated: update
CloudClip:SW_BOOT ...
```

**Expected Logs (Content Script):**

```
CloudClip:BOOT content script loaded
```

**Expected Result:** Copy capture works on new tabs. Old tabs may need refresh (expected MV3 behavior).

---

## Test 4: Tab Restore and Navigations

**Steps:**

1. Open 5 tabs to different sites
2. Copy text on Tab 1 → verify popup shows it
3. Navigate Tab 1 to a different URL (e.g., click a link)
4. Copy text on the new page
5. Use back button
6. Copy text again

**Expected Logs:**

- Each navigation triggers fresh `CloudClip:BOOT` log
- No `CloudClip:GUARD duplicate injection blocked` on navigations (guard resets on `pagehide`)

**Expected Result:** Copy works after each navigation without duplicates.

---

## Test 5: Multiple Frames / all_frames Behavior

**Steps:**

1. Open a page with iframes (e.g., `https://www.w3schools.com/html/html_iframe.asp`)
2. In main frame: select text, Ctrl+C
3. Click into an iframe, select text inside iframe, Ctrl+C
4. Check popup

**Expected Logs (Page console - may need to select iframe context):**

```
CloudClip:BOOT content script loaded { href: ..., isTop: true }
CloudClip:BOOT content script loaded { href: ..., isTop: false }
```

**Expected Result:** Both copies appear in popup. Each frame has its own content script instance.

---

## Test 6: Disable/Enable Auto-Capture Toggle

**Steps:**

1. Open popup → disable auto-capture toggle
2. Copy text on page
3. Check popup - should NOT appear
4. Re-enable auto-capture in popup
5. Copy text again

**Expected Logs (Content Script):**

```
CloudClip: Auto-capture changed to: false
CloudClip: Auto-capture changed to: true
```

**Expected Result:** Toggle works in real-time via `storage.onChanged`.

---

## Test 7: Service Worker Termination Recovery

**Steps:**

1. Copy text → verify it works
2. Go to `chrome://serviceworker-internals`
3. Find CloudClip worker and click "Stop"
4. Immediately copy new text on a page

**Expected Logs:**

```
CloudClip: Service worker not responding, retrying... 3
CloudClip:SW_BOOT (on wake)
```

**Expected Result:** Copy succeeds after retry (service worker wakes up).

---

## Test 8: Extension Context Invalidation (Reload)

**Steps:**

1. Have a page open with content script running
2. Go to `chrome://extensions` → Reload CloudClip extension
3. Go back to the page, copy text

**Expected Logs (old content script):**

```
CloudClip: Extension context invalidated, disabling capture
```

**Expected Result:** Old content script gracefully stops. Refresh page to get new content script.
