CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  email TEXT UNIQUE NOT NULL,
  first_name TEXT,
  source TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  paid INTEGER DEFAULT 0,
  donation_amount INTEGER,
  last_email_type TEXT,
  scheduled_day INTEGER,
  ab_variant CHAR(1),
  engagement_score INTEGER DEFAULT 0,
  tags JSONB DEFAULT '[]',
  unsubscribed BOOLEAN DEFAULT false,
  unsubscribed_at TIMESTAMPTZ,
  bounce_count INTEGER DEFAULT 0,
  hard_bounced BOOLEAN DEFAULT false,
  last_opened_at TIMESTAMPTZ,
  last_clicked_at TIMESTAMPTZ,
  click_count INTEGER DEFAULT 0,
  total_emails_sent INTEGER DEFAULT 0,
  reserved BOOLEAN DEFAULT false,
  reserved_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS campaigns (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name TEXT,
  status TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  subject_a TEXT,
  subject_b TEXT,
  winner_variant CHAR(1),
  total_sent INTEGER DEFAULT 0,
  total_opened INTEGER DEFAULT 0,
  total_clicked INTEGER DEFAULT 0,
  total_donated INTEGER DEFAULT 0,
  revenue_usd INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS send_log (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID REFERENCES users(id),
  campaign_id UUID REFERENCES campaigns(id),
  sent_at TIMESTAMPTZ DEFAULT NOW(),
  email_type TEXT,
  variant CHAR(1),
  channel TEXT,
  status TEXT,
  error TEXT
);

CREATE TABLE IF NOT EXISTS analytics_events (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID REFERENCES users(id),
  campaign_id UUID REFERENCES campaigns(id),
  sent_at TIMESTAMPTZ,
  email_type TEXT,
  variant CHAR(1),
  channel TEXT,
  status TEXT,
  opened_at TIMESTAMPTZ,
  clicked_at TIMESTAMPTZ,
  error TEXT
);

CREATE TABLE IF NOT EXISTS suppression_list (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  email TEXT UNIQUE NOT NULL,
  reason TEXT,
  added_at TIMESTAMPTZ DEFAULT NOW(),
  source TEXT
);
