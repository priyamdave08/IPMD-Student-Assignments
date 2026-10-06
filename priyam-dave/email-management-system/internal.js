const express = require("express");
const db = require("./db");
const { internalServiceToken } = require("./config");

const router = express.Router();

// Server-to-server auth: only the Flask backend (which owns the single Stripe
// webhook) is allowed to call /internal/*. It presents the shared
// INTERNAL_SERVICE_TOKEN that both services read from the environment. This is
// deliberately the same header/token convention Flask already uses for its own
// internal endpoints (X-Internal-Service-Token).
function requireInternalToken(req, res, next) {
  const supplied = req.headers["x-internal-service-token"];
  if (!internalServiceToken || !supplied || supplied !== internalServiceToken) {
    return res.status(401).json({ error: "unauthorized" });
  }
  next();
}

// Called by Flask AFTER a $1 reservation is confirmed (real Stripe webhook or
// local mock-payment). Flask owns the reservation record in SQL Server; this
// endpoint only mirrors the conversion into the EMS lifecycle DB.
//
// A reserve is a $1, refundable promise -- NOT the same as actually backing on
// Kickstarter later. "reserved"/"reserved_at" track this specific $1 commitment;
// "paid"/"donation_amount" are kept in sync for backward-compatible reporting.
//
// Idempotent: Stripe retries and replays must not re-send reserved_thankyou, so
// an already-reserved user is acknowledged without a second send.
router.post("/internal/reserved", requireInternalToken, async (req, res) => {
  const { email, first_name, amount_cents } = req.body || {};
  if (!email) {
    return res.status(400).json({ error: "email required" });
  }
  const amount = Number.isFinite(amount_cents) ? amount_cents : null;

  try {
    const userRes = await db.query(
      "SELECT id, tags, reserved FROM users WHERE email = $1",
      [email]
    );

    if (userRes.rowCount === 0) {
      // Cold reserver who was never on the EMS list (e.g. direct landing-page
      // traffic): create them already-reserved as a VIP so they still receive
      // Phase B launch emails.
      await db.query(
        `INSERT INTO users (email, first_name, paid, donation_amount, source, tags,
                            reserved, reserved_at, last_email_type)
         VALUES ($1, $2, 1, $3, 'reservation', '["vip"]', true, NOW(), 'reserved_thankyou')`,
        [email, first_name || null, amount]
      );
    } else {
      const user = userRes.rows[0];
      if (user.reserved) {
        // Already converted -- idempotent replay, do not re-send.
        return res.json({ status: "already_reserved" });
      }
      const tags = user.tags || [];
      if (!tags.includes("vip")) tags.push("vip");

      await db.query(
        `UPDATE users
         SET paid = 1,
             donation_amount = $2,
             reserved = true,
             reserved_at = NOW(),
             last_email_type = 'reserved_thankyou',
             engagement_score = engagement_score + 50,
             tags = $3
         WHERE email = $1`,
        [email, amount, JSON.stringify(tags)]
      );
    }

    await db.query(
      `INSERT INTO analytics_events (user_id, sent_at, email_type, status)
       SELECT id, NOW(), 'reserved', 'reserved'
       FROM users WHERE email = $1`,
      [email]
    );

    // Reserving exits the reserve-ask flow immediately and permanently -- this
    // fires off-schedule, not from the cron.
    const userRes2 = await db.query("SELECT * FROM users WHERE email = $1", [email]);
    const user = userRes2.rows[0];
    const { sendEmailWithTracking } = require("./mailer");
    await sendEmailWithTracking(user, "reserved_thankyou", "gmail");

    res.json({ status: "ok" });
  } catch (err) {
    console.error("[/internal/reserved] error:", err);
    res.status(500).json({ error: "internal_error" });
  }
});

module.exports = router;
