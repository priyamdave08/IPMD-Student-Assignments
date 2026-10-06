-- Run this in Neon's SQL editor against your EXISTING database.
-- It only adds columns -- it will not touch or delete any data you already have.

ALTER TABLE users ADD COLUMN IF NOT EXISTS click_count INTEGER DEFAULT 0;
ALTER TABLE users ADD COLUMN IF NOT EXISTS hard_bounced BOOLEAN DEFAULT false;
ALTER TABLE users ADD COLUMN IF NOT EXISTS reserved BOOLEAN DEFAULT false;
ALTER TABLE users ADD COLUMN IF NOT EXISTS reserved_at TIMESTAMPTZ;
