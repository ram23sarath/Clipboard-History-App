# CloudClip - Cloud-Synced Clipboard

A production-ready Chrome extension that syncs your clipboard across devices using Supabase for authentication and secure cloud storage.

## Features

- 🔄 **Real-time Sync**: Clipboard items sync instantly across all your devices
- 🔒 **Privacy First**: Automatic redaction of sensitive data (SSNs, credit cards, passwords)
- 🌙 **Dark Mode**: Modern, sleek dark-themed interface
- 📱 **Per-Device Naming**: Identify which device each clipboard item came from
- 🔐 **Secure Authentication**: Email/password auth with short-lived session tokens
- ⚡ **Smart Debouncing**: 1-second debounce prevents duplicate uploads
- 🛡️ **Rate Limiting**: Built-in protection against API abuse

## Setup Instructions

### 1. Create a Supabase Project

1. Go to [supabase.com](https://supabase.com) and create a new project
2. Wait for the project to be provisioned

### 2. Set Up the Database

1. Go to SQL Editor in your Supabase dashboard
2. Copy the contents of `supabase/schema.sql`
3. Paste and run the SQL to create tables and policies
4. Go to Database > Replication and add `clipboard_items` to the Realtime publication

### 3. Configure the Extension

1. Go to Project Settings > API in Supabase
2. Copy your Project URL and anon public key
3. Open `src/config.js` and replace:
   - `SUPABASE_URL` with your project URL
   - `SUPABASE_ANON_KEY` with your anon key

### 4. Add Icons

Create PNG icons in the `icons/` folder:
- `icon16.png` (16x16 pixels)
- `icon32.png` (32x32 pixels)
- `icon48.png` (48x48 pixels)
- `icon128.png` (128x128 pixels)

### 5. Load the Extension

1. Open Chrome and go to `chrome://extensions`
2. Enable "Developer mode" (toggle in top-right)
3. Click "Load unpacked"
4. Select the `Chrome Extension` folder

## Development

### Install Dependencies

```bash
npm install
```

### Run Tests

```bash
npm test
```

### Build for Production

```bash
npm run build:prod
```

### Watch Mode

```bash
npm run watch
```

## Project Structure

```
Chrome Extension/
├── manifest.json          # Extension manifest (Manifest V3)
├── package.json           # Node.js dependencies
├── src/
│   ├── config.js          # Supabase configuration
│   ├── lib/
│   │   ├── supabase-client.js  # Supabase client init
│   │   ├── auth.js             # Authentication module
│   │   ├── device.js           # Device management
│   │   ├── redaction.js        # Sensitive data redaction
│   │   └── sync.js             # Sync logic with debounce/retry
│   ├── background/
│   │   └── background.js       # Service worker
│   ├── content/
│   │   └── content.js          # Copy event listener
│   ├── offscreen/
│   │   ├── offscreen.html
│   │   └── offscreen.js        # Clipboard write operations
│   └── popup/
│       ├── popup.html          # Popup UI structure
│       ├── popup.css           # Dark mode styling
│       └── popup.js            # Popup logic
├── supabase/
│   └── schema.sql         # Database schema + RLS policies
├── docs/
│   ├── privacy-policy.html     # Privacy policy for Web Store
│   └── store-justifications.md # Permission explanations
├── scripts/
│   └── build.js           # Build helper script
├── tests/
│   ├── sync.test.js       # Sync logic tests
│   └── redaction.test.js  # Redaction tests
└── icons/                 # Extension icons (add your own)
```

## Permissions

| Permission | Purpose |
|------------|---------|
| `storage` | Store preferences and cached items locally |
| `clipboardRead` | Capture copied text (optional, after consent) |
| `clipboardWrite` | Enable one-click re-copy (optional) |
| `<all_urls>` | Detect copy events on pages (optional, after consent) |

## Security Features

1. **Row-Level Security (RLS)**: Users can only access their own data
2. **No Service Role Key**: Only the anon key is used client-side
3. **Client-Side Redaction**: Sensitive patterns removed before upload
4. **HTTPS Only**: All data transmitted over encrypted connections
5. **Session Tokens**: Short-lived tokens with automatic refresh

## Chrome Web Store Submission

1. Run `npm run build:prod` to create a production build
2. Create a ZIP file of the `dist/` folder
3. Upload to the [Chrome Web Store Developer Dashboard](https://chrome.google.com/webstore/devconsole)
4. Fill in permission justifications from `docs/store-justifications.md`
5. Link to the privacy policy URL

## License

MIT License - See LICENSE file for details.
