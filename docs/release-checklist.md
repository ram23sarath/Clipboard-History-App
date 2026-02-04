# Release Checklist & Rollback Plan

## Pre-Release Checklist

- [ ] **Version bump**: Update `version` in `manifest.json`
- [ ] **Build**: Run `npm run build` and verify output
- [ ] **Verify paths**: Ensure these exist in build output:
  - `src/background/background.js` (service worker path must match manifest)
  - `src/content/content.js` (content script path must match manifest)
  - `src/popup/popup.html`
  - `src/offscreen/offscreen.html`
  - All icon files: `icons/icon16.png`, `icon32.png`, `icon48.png`, `icon128.png`
- [ ] **Load unpacked**: Test in Chrome with `chrome://extensions` → Load unpacked
- [ ] **Fresh install test**: Remove extension, reinstall, verify copy capture works
- [ ] **Restart test**: Close Chrome completely, reopen, verify extension works
- [ ] **Console clean**: Check service worker and content script consoles for errors
- [ ] **Package**: Create `.zip` excluding `node_modules/`, `.git/`, `tests/`

## Rollback Plan

If the new version fails after deployment:

1. **Immediate rollback** (within minutes):

   ```powershell
   git checkout HEAD~1 -- src/background/background.js src/content/content.js manifest.json
   npm run build
   ```

   Then reload unpacked extension.

2. **Version rollback** (if published to Chrome Web Store):
   - Log into Chrome Web Store Developer Dashboard
   - Upload previous `.zip` as new version (bump version number)
   - Submit for review

3. **Emergency disable** (user-side):
   - Users can disable auto-capture in popup to stop content script activity
   - Storage key: `cloudclip_auto_capture: false`

## Known-Good Commit

Before deploying, tag the last working commit:

```powershell
git tag -a v1.0.2-stable -m "Last known working version before refactor"
git push origin v1.0.2-stable
```

## Post-Deploy Verification

- [ ] Extension icon appears in toolbar
- [ ] Popup opens without errors
- [ ] Copy text on any page → appears in popup
- [ ] Close Chrome → Reopen → Copy still works
- [ ] Check `chrome://extensions` → No errors on extension card
