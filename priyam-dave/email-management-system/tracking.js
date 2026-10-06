const express = require("express");
const db = require("./db");
const jwt = require("jsonwebtoken");
const { jwtSecret, publicAppUrl } = require("./config");

const router = express.Router();

// Where the reserve CTA sends people: the landing-page reservation flow. The
// ?ref token lets the app attribute the click back to the email/contact.
function reserveDestination(token) {
  const base = publicAppUrl || "https://your-domain.com";
  const suffix = token ? `?ref=${encodeURIComponent(token)}` : "";
  return `${base}/emotion-sphere${suffix}`;
}

router.get("/track/open/:token", async (req, res) => {
  try {
    const payload = jwt.verify(req.params.token, jwtSecret);
    const { userId, emailType } = payload;

    await db.query(
      `UPDATE users SET last_opened_at = NOW(), engagement_score = engagement_score + 10
       WHERE id = $1`,
      [userId]
    );

    await db.query(
      `INSERT INTO analytics_events (user_id, sent_at, email_type, status, opened_at)
       VALUES ($1, NOW(), $2, 'opened', NOW())`,
      [userId, emailType]
    );

    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR4nGNgYAAAAAMAASsJTYQAAAAASUVORK5CYII=",
      "base64"
    );
    res.setHeader("Content-Type", "image/png");
    res.send(png);
  } catch (err) {
    res.status(200).end();
  }
});

router.get("/track/click/:token", async (req, res) => {
  try {
    const payload = jwt.verify(req.params.token, jwtSecret);
    const { userId, emailType } = payload;
    const url = req.query.url;

    // click_count is the metric the new lifecycle branches on (not opens)
    await db.query(
      `UPDATE users SET last_clicked_at = NOW(), click_count = click_count + 1,
       engagement_score = engagement_score + 20 WHERE id = $1`,
      [userId]
    );

    await db.query(
      `INSERT INTO analytics_events (user_id, sent_at, email_type, status, clicked_at)
       VALUES ($1, NOW(), $2, 'clicked', NOW())`,
      [userId, emailType]
    );

    res.redirect(url || "https://your-kickstarter-link.com");
  } catch (err) {
    res.redirect("https://your-kickstarter-link.com");
  }
});

// Tracks intent to reserve (counts as a click), then forwards to the
// landing-page reservation flow (/emotion-sphere). Actual "reserved" status is
// set only after payment completes -- via the Flask Stripe webhook, which then
// calls /internal/reserved here. Clicking this alone doesn't reserve anything,
// it just measures interest.
router.get("/reserve-click/:token", async (req, res) => {
  try {
    const payload = jwt.verify(req.params.token, jwtSecret);
    const { userId, emailType } = payload;

    await db.query(
      `UPDATE users SET last_clicked_at = NOW(), click_count = click_count + 1,
       engagement_score = engagement_score + 20 WHERE id = $1`,
      [userId]
    );
    await db.query(
      `INSERT INTO analytics_events (user_id, sent_at, email_type, status, clicked_at)
       VALUES ($1, NOW(), $2, 'clicked', NOW())`,
      [userId, emailType]
    );

    res.redirect(reserveDestination(req.params.token));
  } catch (err) {
    res.redirect(reserveDestination(null));
  }
});

module.exports = router;
