-- CloudClip Supabase Schema
-- Run this SQL in your Supabase SQL Editor to set up the database

-- =============================================================================
-- SETUP INSTRUCTIONS
-- =============================================================================
-- 1. Go to https://supabase.com and create a new project
-- 2. Once created, go to Project Settings > API
-- 3. Copy your Project URL and anon/public key
-- 4. Paste them in src/config.js
-- 5. Go to SQL Editor and run this entire file
-- 6. Enable Row Level Security from Authentication > Policies (if not auto-enabled)
-- =============================================================================

-- Enable UUID extension if not already enabled
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- =============================================================================
-- TABLES
-- =============================================================================

-- Clipboard items table
CREATE TABLE IF NOT EXISTS clipboard_items (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    content TEXT NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    device_id TEXT NOT NULL,
    device_name TEXT,
    origin TEXT DEFAULT 'extension',
    content_hash TEXT,
    is_deleted BOOLEAN DEFAULT FALSE,
    deleted_at TIMESTAMPTZ
);

-- User devices table for tracking connected devices
CREATE TABLE IF NOT EXISTS user_devices (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    device_id TEXT NOT NULL,
    device_name TEXT NOT NULL DEFAULT 'Unknown Device',
    created_at TIMESTAMPTZ DEFAULT NOW(),
    last_seen_at TIMESTAMPTZ DEFAULT NOW(),
    is_active BOOLEAN DEFAULT TRUE,
    UNIQUE(user_id, device_id)
);

-- User preferences table
CREATE TABLE IF NOT EXISTS user_preferences (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE UNIQUE,
    auto_capture_enabled BOOLEAN DEFAULT FALSE,
    max_items INTEGER DEFAULT 50,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- =============================================================================
-- INDEXES
-- =============================================================================

-- Index for faster queries by user and creation time
CREATE INDEX IF NOT EXISTS idx_clipboard_items_user_created 
    ON clipboard_items(user_id, created_at DESC);

-- Index for content hash to prevent duplicates
CREATE INDEX IF NOT EXISTS idx_clipboard_items_hash 
    ON clipboard_items(user_id, content_hash);

-- Index for device lookup
CREATE INDEX IF NOT EXISTS idx_user_devices_user 
    ON user_devices(user_id);

-- =============================================================================
-- ROW LEVEL SECURITY (RLS) POLICIES
-- =============================================================================

-- Enable RLS on all tables
ALTER TABLE clipboard_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_devices ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_preferences ENABLE ROW LEVEL SECURITY;

-- Clipboard items policies
-- Users can only see their own items
CREATE POLICY "Users can view own clipboard items"
    ON clipboard_items FOR SELECT
    USING (auth.uid() = user_id);

-- Users can insert their own items
CREATE POLICY "Users can insert own clipboard items"
    ON clipboard_items FOR INSERT
    WITH CHECK (auth.uid() = user_id);

-- Users can update their own items (for soft delete)
CREATE POLICY "Users can update own clipboard items"
    ON clipboard_items FOR UPDATE
    USING (auth.uid() = user_id);

-- Users can delete their own items
CREATE POLICY "Users can delete own clipboard items"
    ON clipboard_items FOR DELETE
    USING (auth.uid() = user_id);

-- User devices policies
CREATE POLICY "Users can view own devices"
    ON user_devices FOR SELECT
    USING (auth.uid() = user_id);

CREATE POLICY "Users can insert own devices"
    ON user_devices FOR INSERT
    WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update own devices"
    ON user_devices FOR UPDATE
    USING (auth.uid() = user_id);

CREATE POLICY "Users can delete own devices"
    ON user_devices FOR DELETE
    USING (auth.uid() = user_id);

-- User preferences policies
CREATE POLICY "Users can view own preferences"
    ON user_preferences FOR SELECT
    USING (auth.uid() = user_id);

CREATE POLICY "Users can insert own preferences"
    ON user_preferences FOR INSERT
    WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update own preferences"
    ON user_preferences FOR UPDATE
    USING (auth.uid() = user_id);

-- =============================================================================
-- FUNCTIONS
-- =============================================================================

-- Function to update last_seen timestamp for devices
CREATE OR REPLACE FUNCTION update_device_last_seen()
RETURNS TRIGGER AS $$
BEGIN
    UPDATE user_devices 
    SET last_seen_at = NOW()
    WHERE user_id = NEW.user_id AND device_id = NEW.device_id;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Trigger to update device last seen when clipboard item is inserted
CREATE TRIGGER on_clipboard_insert_update_device
    AFTER INSERT ON clipboard_items
    FOR EACH ROW
    EXECUTE FUNCTION update_device_last_seen();

-- Function to clean up old items (keep last 100 per user)
CREATE OR REPLACE FUNCTION cleanup_old_clipboard_items()
RETURNS void AS $$
BEGIN
    DELETE FROM clipboard_items
    WHERE id IN (
        SELECT id FROM (
            SELECT id, 
                   ROW_NUMBER() OVER (PARTITION BY user_id ORDER BY created_at DESC) as rn
            FROM clipboard_items
            WHERE is_deleted = FALSE
        ) ranked
        WHERE rn > 100
    );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- =============================================================================
-- REALTIME SETUP
-- =============================================================================

-- Enable realtime for clipboard_items table
-- Go to Database > Replication in Supabase Dashboard
-- Or run this if you have supabase_realtime role:
-- ALTER PUBLICATION supabase_realtime ADD TABLE clipboard_items;

-- Note: You may need to enable this manually in the Supabase Dashboard:
-- 1. Go to Database > Replication
-- 2. Find the "supabase_realtime" publication
-- 3. Add the "clipboard_items" table

-- =============================================================================
-- SAMPLE DATA (Optional - for testing)
-- =============================================================================

-- Uncomment to insert test data after signing up a user:
-- INSERT INTO clipboard_items (user_id, content, device_id, device_name)
-- VALUES 
--     (auth.uid(), 'Test clipboard item 1', 'test-device-1', 'Test Device'),
--     (auth.uid(), 'Test clipboard item 2', 'test-device-1', 'Test Device');
