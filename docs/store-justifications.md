# Chrome Web Store Permission Justifications

Use these justifications when submitting the extension to the Chrome Web Store.

## Required Permissions

### storage
**Justification:** Stores user preferences, authentication tokens, and cached clipboard items locally for offline access and faster loading.

## Optional Permissions (Requested After User Consent)

### clipboardRead
**Justification:** Required to capture text that users copy so it can be synced across their devices. Only activated after explicit user consent during onboarding.

### clipboardWrite
**Justification:** Enables users to restore previously copied text to their clipboard with a single click from the extension popup.

### Host Permissions (`<all_urls>`)
**Justification:** Required to detect copy events on any webpage the user visits. This permission is only requested after the user explicitly enables "automatic clipboard sync" in settings, and content scripts only listen for copy events without accessing page content.

---

## Single Sentence Summaries (for Web Store listing)

- **clipboardRead:** Required to capture copied text for syncing across devices.
- **clipboardWrite:** Enables one-click re-copy from clipboard history.
- **storage:** Stores user preferences and device settings locally.
- **Host access:** Detects when you copy text on any page after you enable auto-sync.

---

## Privacy Highlights for Store Listing

- ✅ Sensitive data (SSNs, credit cards, passwords) automatically redacted before upload
- ✅ No data collection until user explicitly enables clipboard sync
- ✅ Row-level security ensures users only access their own data
- ✅ "Delete my data" button for GDPR compliance
- ✅ Minimal permissions requested only when needed
- ✅ No analytics or tracking
- ✅ Open authentication (email/password via Supabase)
