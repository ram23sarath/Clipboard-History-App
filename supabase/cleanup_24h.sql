-- =============================================================================
-- AUTOMATIC CLEANUP: DELETE ITEMS OLDER THAN 24 HOURS
-- =============================================================================
-- Run this SQL in your Supabase SQL Editor to enable 24-hour retention policy.

-- 1. Create the cleanup function
CREATE OR REPLACE FUNCTION delete_expired_items()
RETURNS TRIGGER AS $$
BEGIN
    -- Delete items created more than 24 hours ago
    DELETE FROM clipboard_items
    WHERE created_at < NOW() - INTERVAL '24 hours';
    
    RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- 2. Create a trigger to run this function automatically
-- This ensures that whenever a new item is added, we also clean up old ones
DROP TRIGGER IF EXISTS trigger_delete_expired_items ON clipboard_items;

CREATE TRIGGER trigger_delete_expired_items
    AFTER INSERT ON clipboard_items
    FOR EACH STATEMENT
    EXECUTE FUNCTION delete_expired_items();

-- 3. (Optional) Run cleanup immediately for existing data
DELETE FROM clipboard_items
WHERE created_at < NOW() - INTERVAL '24 hours';
