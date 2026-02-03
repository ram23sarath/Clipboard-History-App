# Minimal Clipboard Capture Example

A stripped-down Chrome extension (MV3) that captures copy events and uploads to Supabase.

## Setup

1. Replace credentials in `background.js`:

   ```js
   const SUPABASE_URL = "https://YOUR_PROJECT_REF.supabase.co";
   const SUPABASE_ANON_KEY = "YOUR_ANON_KEY_HERE";
   ```

2. Create the Supabase table:

   ```sql
   CREATE TABLE clipboard_items (
       id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
       user_id UUID REFERENCES auth.users(id) NOT NULL,
       content TEXT NOT NULL,
       origin TEXT,
       page_title TEXT,
       created_at TIMESTAMPTZ DEFAULT NOW()
   );

   -- Enable RLS
   ALTER TABLE clipboard_items ENABLE ROW LEVEL SECURITY;

   -- Users can only see their own items
   CREATE POLICY "Users can view own items"
       ON clipboard_items FOR SELECT
       USING (auth.uid() = user_id);

   -- Users can insert their own items
   CREATE POLICY "Users can insert own items"
       ON clipboard_items FOR INSERT
       WITH CHECK (auth.uid() = user_id);
   ```

3. Load in Chrome:
   - Go to `chrome://extensions`
   - Enable "Developer mode"
   - Click "Load unpacked"
   - Select this folder

## Security Notes

### Why the anon key is safe in client code:

The Supabase `anon` key is designed to be public. It's similar to a Firebase API key.

Security is enforced by:

1. **Row Level Security (RLS)** - Database policies restrict what each user can do
2. **JWT Tokens** - Users must authenticate to get a valid JWT
3. **The `auth.uid()` function** - RLS policies use this to scope data to the current user

### What NOT to do:

- Never include the `service_role` key in client code
- Never disable RLS on tables with user data
- Always use `auth.uid()` in your RLS policies

## Debugging

### Content script not capturing?

```js
// Run in page console:
console.log("Injected:", window.__clipboardCaptureInjected);
```

### Messages not reaching background?

```js
// Run in page console:
chrome.runtime
  .sendMessage({ type: "TEST" })
  .then(console.log)
  .catch(console.error);
```

### Check background service worker logs:

1. Go to `chrome://extensions`
2. Find your extension
3. Click "service worker" link to open DevTools
