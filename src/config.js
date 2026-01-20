/**
 * CloudClip Configuration
 * 
 * SETUP INSTRUCTIONS:
 * 1. Go to https://supabase.com and sign in
 * 2. Create a new project or use an existing one
 * 3. Go to Project Settings > API
 * 4. Copy your Project URL and paste it as SUPABASE_URL
 * 5. Copy the "anon public" key and paste it as SUPABASE_ANON_KEY
 * 
 * IMPORTANT: Never use the service_role key here - it should only be used server-side
 */

export const CONFIG = {
  // Supabase Configuration
  // Replace these with your actual Supabase project credentials
  SUPABASE_URL: 'https://ncislghaavunnaoogxak.supabase.co',
  SUPABASE_ANON_KEY: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im5jaXNsZ2hhYXZ1bm5hb29neGFrIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Njg5MDI0MjcsImV4cCI6MjA4NDQ3ODQyN30.ZcL3iTwynD-vDlapwilDQHbKEbOk4huAHiuHwMSqFvM',

  // Sync Settings
  SYNC: {
    DEBOUNCE_MS: 1000,           // Delay before uploading after copy
    MAX_ITEMS: 50,               // Maximum items to display in popup
    FETCH_LIMIT: 50,             // Items to fetch from server
    RATE_LIMIT_WINDOW_MS: 60000, // Rate limit window (1 minute)
    RATE_LIMIT_MAX_REQUESTS: 30, // Max requests per window
    RETRY_ATTEMPTS: 3,           // Number of retry attempts
    RETRY_BASE_DELAY_MS: 1000,   // Base delay for exponential backoff
  },

  // Storage Keys
  STORAGE_KEYS: {
    DEVICE_ID: 'cloudclip_device_id',
    DEVICE_NAME: 'cloudclip_device_name',
    AUTO_CAPTURE: 'cloudclip_auto_capture',
    ONBOARDING_COMPLETE: 'cloudclip_onboarding_complete',
    SESSION: 'cloudclip_session',
    LAST_SYNC: 'cloudclip_last_sync',
    CACHED_ITEMS: 'cloudclip_cached_items',
  },

  // Redaction Patterns
  REDACTION: {
    // US Social Security Numbers (XXX-XX-XXXX)
    SSN_PATTERN: /\b\d{3}[-\s]?\d{2}[-\s]?\d{4}\b/g,
    // Credit Card Numbers (13-19 digits with optional separators)
    CC_PATTERN: /\b(?:\d{4}[-\s]?){3,4}\d{1,4}\b/g,
    // Common password field patterns
    PASSWORD_PATTERNS: [
      /password\s*[:=]\s*\S+/gi,
      /pwd\s*[:=]\s*\S+/gi,
      /secret\s*[:=]\s*\S+/gi,
      /api[_-]?key\s*[:=]\s*\S+/gi,
      /token\s*[:=]\s*\S+/gi,
    ],
    REPLACEMENT: '[REDACTED]',
  },

  // UI Settings
  UI: {
    LONG_PRESS_DELAY_MS: 500,    // Long press duration for delete
    SEARCH_DEBOUNCE_MS: 300,     // Search input debounce
    TOAST_DURATION_MS: 3000,     // Toast notification duration
  },
};

// Validate configuration on load
export function validateConfig() {
  const errors = [];

  // Check if URL is missing or still a placeholder
  if (!CONFIG.SUPABASE_URL ||
    CONFIG.SUPABASE_URL === 'https://your-project-id.supabase.co' ||
    CONFIG.SUPABASE_URL.includes('your-project-id')) {
    errors.push('SUPABASE_URL not configured - please update src/config.js');
  }

  // Check if anon key is missing or still a placeholder
  if (!CONFIG.SUPABASE_ANON_KEY ||
    CONFIG.SUPABASE_ANON_KEY === 'your-anon-key-here' ||
    CONFIG.SUPABASE_ANON_KEY.includes('your-anon')) {
    errors.push('SUPABASE_ANON_KEY not configured - please update src/config.js');
  }

  return errors;
}
