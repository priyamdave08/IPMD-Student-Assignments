require("dotenv").config();

module.exports = {
  pgConnectionString: process.env.PG_CONNECTION_STRING,
  gmailUser: process.env.GMAIL_USER,
  gmailPass: process.env.GMAIL_APP_PASSWORD,
  warmupStartDate: process.env.WARMUP_START_DATE,
  dailyCapGmail: 2000,
  jwtSecret: process.env.JWT_SECRET,
  adminUsername: process.env.ADMIN_USERNAME,
  adminPasswordHash: process.env.ADMIN_PASSWORD_HASH,
  // Base URL EMS uses for its own tracking pixels / unsubscribe links.
  publicBaseUrl: process.env.PUBLIC_BASE_URL,
  // Landing-page base URL. Reserve CTAs in every email drive here (the real
  // /emotion-sphere reservation flow), NOT a bare Stripe payment link.
  publicAppUrl: process.env.PUBLIC_APP_URL,
  // Shared secret for server-to-server calls from the Flask backend.
  internalServiceToken: process.env.INTERNAL_SERVICE_TOKEN
};
