-- Add is_active field to users table for account activation
ALTER TABLE users ADD COLUMN is_active INTEGER DEFAULT 1;

-- Set all existing users to active (1 = active, 0 = inactive)
UPDATE users SET is_active = 1 WHERE is_active IS NULL;

-- Create index for faster lookups
CREATE INDEX IF NOT EXISTS idx_users_is_active ON users(is_active);
