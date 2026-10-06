const express = require("express");
const path = require("path");
const db = require("./db");
const { pgConnectionString } = require("./config");
const { loadTemplate, sendCustomEmail, previewTemplate, listTemplates, createTemplate, deleteTemplate } = require("./mailer");
const { triggerPhaseBManually } = require("./phaseB");
const jobQueue = require("./queue");

// Read + trigger layer for the admin dashboard. Every route here is mounted
// behind requireAdmin in server.js, so no auth logic lives in this file.
//
// The dashboard is static (public/admin) and calls these /admin/api/* JSON
// endpoints. Nothing here changes the email lifecycle -- it only reads the DB
// and re-exposes the existing Phase B trigger.
const router = express.Router();

// Every EMS table lives in Postgres. If the operator hasn't configured a
// connection string (common on a fresh clone), fail loud but readable instead
// of throwing a raw pg connection error on every request.
function requireDb(req, res, next) {
  if (!pgConnectionString) {
    return res.status(503).json({ error: "database_not_configured" });
  }
  next();
}

// The five email templates a human is allowed to fire manually (Phase B).
// Mirrors the whitelist that used to live in server.js.
const MANUAL_PHASE_B_TYPES = [
  "follow_kickstarter",
  "launch_instructions",
  "vip_private_link",
  "we_are_live",
  "still_live"
];

async function queueTemplateForAudience(emailType, id) {
  const templates = listTemplates().map((template) => template.name);
  if (!templates.includes(emailType)) throw new Error("Unknown email template");

  const audience = id
    ? await db.query(
        "SELECT id FROM users WHERE id = $1 AND unsubscribed = false AND hard_bounced = false",
        [id]
      )
    : await db.query(
        "SELECT id FROM users WHERE unsubscribed = false AND hard_bounced = false"
      );
  if (id && audience.rowCount === 0) throw new Error("contact_not_found_or_suppressed");
  for (const row of audience.rows) {
    jobQueue.push({ userId: row.id, emailType, channel: "gmail" });
  }
  return audience.rowCount;
}

// Every template file the mailer knows how to render, in rough lifecycle order.
// Used by the Emails tab; the mailer owns the authoritative filename map.
const TEMPLATE_ORDER = [
  { name: "welcome", phase: "A" },
  { name: "resend", phase: "A" },
  { name: "reengage", phase: "A" },
  { name: "final_nudge", phase: "A" },
  { name: "last_call", phase: "A" },
  { name: "reserved_thankyou", phase: "conversion" },
  { name: "follow_kickstarter", phase: "B" },
  { name: "launch_instructions", phase: "B" },
  { name: "vip_private_link", phase: "B" },
  { name: "we_are_live", phase: "B" },
  { name: "still_live", phase: "B" },
  { name: "unsubscribe_confirmation", phase: "suppression" },
  { name: "test", phase: "test" }
];
// ---- Serve the static dashboard ---------------------------------------------
// GET /admin -> index.html; GET /admin/app.js etc. served from public/admin.
router.use(express.static(path.join(__dirname, "public", "admin")));

// ---- Metrics ----------------------------------------------------------------
router.get("/api/metrics", requireDb, async (req, res) => {
  try {
    const totals = await db.query(`
      SELECT
        COUNT(*)::int                                            AS contacts,
        COUNT(*) FILTER (WHERE reserved)::int                    AS reserved,
        COUNT(*) FILTER (WHERE unsubscribed)::int                AS unsubscribed,
        COUNT(*) FILTER (WHERE hard_bounced)::int                AS hard_bounced,
        COALESCE(SUM(donation_amount), 0)::int                   AS revenue_cents,
        COALESCE(SUM(total_emails_sent), 0)::int                 AS emails_sent,
        COUNT(*) FILTER (WHERE last_opened_at IS NOT NULL)::int  AS ever_opened,
        COUNT(*) FILTER (WHERE click_count > 0)::int             AS ever_clicked
      FROM users
    `);

    const suppressed = await db.query("SELECT COUNT(*)::int AS c FROM suppression_list");

    // Phase A funnel: bucket contacts by where they are in the reserve-ask flow.
    const funnel = await db.query(`
      SELECT
        COUNT(*) FILTER (WHERE last_email_type IS NULL OR last_email_type = '')::int AS not_started,
        COUNT(*) FILTER (WHERE last_email_type = 'welcome')::int                      AS welcomed,
        COUNT(*) FILTER (WHERE last_email_type IN ('nudge_reengage','nudge_resend','reengage','resend'))::int AS nudged,
        COUNT(*) FILTER (WHERE last_email_type IN ('final_nudge','last_call'))::int    AS final_ask,
        COUNT(*) FILTER (WHERE reserved)::int                                          AS reserved
      FROM users
    `);

    const t = totals.rows[0];
    const openRate = t.contacts ? Math.round((t.ever_opened / t.contacts) * 100) : 0;
    const clickRate = t.contacts ? Math.round((t.ever_clicked / t.contacts) * 100) : 0;

    res.json({
      contacts: t.contacts,
      reserved: t.reserved,
      unsubscribed: t.unsubscribed,
      hard_bounced: t.hard_bounced,
      suppressed: suppressed.rows[0].c,
      revenue_usd: t.revenue_cents / 100,
      emails_sent: t.emails_sent,
      open_rate: openRate,
      click_rate: clickRate,
      funnel: funnel.rows[0]
    });
  } catch (err) {
    console.error("[admin/metrics]", err);
    res.status(500).json({ error: "internal_error" });
  }
});

// ---- Contacts list ----------------------------------------------------------
router.get("/api/contacts", requireDb, async (req, res) => {
  const { q, stage, limit } = req.query;
  const cap = Math.min(parseInt(limit, 10) || 100, 500);

  const where = [];
  const params = [];

  if (q) {
    params.push(`%${q}%`);
    where.push(`(email ILIKE $${params.length} OR first_name ILIKE $${params.length})`);
  }
  if (stage === "reserved") where.push("reserved = true");
  else if (stage === "unsubscribed") where.push("unsubscribed = true");
  else if (stage === "not_started") where.push("(last_email_type IS NULL OR last_email_type = '')");
  else if (stage === "welcomed") where.push("last_email_type = 'welcome'");
  else if (stage === "nudged") where.push("last_email_type IN ('nudge_reengage','nudge_resend','reengage','resend')");
  else if (stage === "final_ask") where.push("last_email_type IN ('final_nudge','last_call')");

  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
  params.push(cap);

  try {
    const rows = await db.query(
      `SELECT id, email, first_name, source, created_at, reserved, reserved_at,
              donation_amount, last_email_type, engagement_score, click_count,
              total_emails_sent, last_opened_at, last_clicked_at, unsubscribed,
              hard_bounced, tags
       FROM users
       ${whereSql}
       ORDER BY created_at DESC
       LIMIT $${params.length}`,
      params
    );
    res.json({ contacts: rows.rows });
  } catch (err) {
    console.error("[admin/contacts]", err);
    res.status(500).json({ error: "internal_error" });
  }
});

// ---- Single contact + email timeline ----------------------------------------
router.get("/api/contacts/:id", requireDb, async (req, res) => {
  try {
    const userRes = await db.query("SELECT * FROM users WHERE id = $1", [req.params.id]);
    if (userRes.rowCount === 0) return res.status(404).json({ error: "not_found" });

    const sends = await db.query(
      `SELECT sent_at, email_type, variant, channel, status, error
       FROM send_log WHERE user_id = $1 ORDER BY sent_at DESC`,
      [req.params.id]
    );
    const events = await db.query(
      `SELECT sent_at, email_type, status, opened_at, clicked_at
       FROM analytics_events WHERE user_id = $1 ORDER BY sent_at DESC`,
      [req.params.id]
    );

    res.json({ contact: userRes.rows[0], send_log: sends.rows, events: events.rows });
  } catch (err) {
    console.error("[admin/contact-detail]", err);
    res.status(500).json({ error: "internal_error" });
  }
});

// Update the name used for future email personalization.
router.patch("/api/contacts/:id", requireDb, async (req, res) => {
  const firstName = typeof req.body?.first_name === "string" ? req.body.first_name.trim() : "";
  if (firstName.length > 120) return res.status(400).json({ error: "name_too_long" });
  try {
    const result = await db.query(
      "UPDATE users SET first_name = $1 WHERE id = $2 RETURNING id, email, first_name",
      [firstName || null, req.params.id]
    );
    if (result.rowCount === 0) return res.status(404).json({ error: "not_found" });
    res.json({ contact: result.rows[0] });
  } catch (err) {
    console.error("[admin/contact-update]", err);
    res.status(500).json({ error: "internal_error" });
  }
});

router.delete("/api/contacts/:id", requireDb, async (req, res) => {
  const client = await db.pool.connect();
  try {
    await client.query("BEGIN");
    const userRes = await client.query("SELECT email FROM users WHERE id = $1 FOR UPDATE", [req.params.id]);
    if (userRes.rowCount === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "not_found" });
    }
    await client.query("DELETE FROM send_log WHERE user_id = $1", [req.params.id]);
    await client.query("DELETE FROM users WHERE id = $1", [req.params.id]);
    await client.query(
      `INSERT INTO suppression_list (email, reason, source) VALUES ($1, 'admin_delete', 'admin')
       ON CONFLICT (email) DO UPDATE SET reason = 'admin_delete', added_at = NOW(), source = 'admin'`,
      [email]
    );
    await client.query("COMMIT");
    res.json({ status: "deleted" });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("[admin/contact-delete]", err);
    res.status(500).json({ error: "internal_error" });
  } finally {
    client.release();
  }
});

// ---- Recent send log --------------------------------------------------------
router.get("/api/send-log", requireDb, async (req, res) => {
  const cap = Math.min(parseInt(req.query.limit, 10) || 50, 200);
  try {
    const rows = await db.query(
      `SELECT s.sent_at, s.email_type, s.channel, s.status, s.error, u.email
       FROM send_log s LEFT JOIN users u ON u.id = s.user_id
       ORDER BY s.sent_at DESC LIMIT $1`,
      [cap]
    );
    res.json({ sends: rows.rows });
  } catch (err) {
    console.error("[admin/send-log]", err);
    res.status(500).json({ error: "internal_error" });
  }
});

// ---- Suppression list -------------------------------------------------------
router.get("/api/suppression", requireDb, async (req, res) => {
  try {
    const rows = await db.query(
      "SELECT email, reason, source, added_at FROM suppression_list ORDER BY added_at DESC LIMIT 200"
    );
    res.json({ suppressed: rows.rows });
  } catch (err) {
    console.error("[admin/suppression]", err);
    res.status(500).json({ error: "internal_error" });
  }
});

// ---- Templates --------------------------------------------------------------
router.get("/api/templates", (req, res) => {
  res.json({ templates: listTemplates(), manual_phase_b: MANUAL_PHASE_B_TYPES });
});

router.post("/api/templates", (req, res) => {
  try {
    createTemplate(String(req.body?.name || "").trim(), req.body?.mjml);
    res.status(201).json({ status: "created" });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Compile an unsaved draft for the admin preview. This never writes to disk.
router.post("/api/templates/preview", (req, res) => {
  try {
    const html = previewTemplate(req.body?.mjml)
      .replace(/\{\{first_name\}\}/g, "Daniel")
      .replace(/\{\{RESERVE_LINK\}\}/g, "#");
    res.type("html").send(html);
  } catch (err) {
    const message = String(err.message).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
    res.status(400).type("html").send(`<p style="font-family:sans-serif;color:#b91c1c;padding:24px">Could not preview draft: ${message}</p>`);
  }
});

router.delete("/api/templates/:name", (req, res) => {
  try {
    deleteTemplate(req.params.name);
    res.json({ status: "deleted" });
  } catch (err) {
    res.status(err.message === "Template not found" ? 404 : 409).json({ error: err.message });
  }
});

// Render one MJML template to HTML for preview. Reuses the mailer's loadTemplate
// so the preview matches what actually ships (minus per-user tracking injection).
router.get("/api/templates/:name", (req, res) => {
  try {
    // Fill in sample merge values so the preview reads naturally instead of
    // showing raw {{first_name}} / {{RESERVE_LINK}} tokens.
    const html = loadTemplate(req.params.name)
      .replace(/\{\{first_name\}\}/g, "[Name]")
      .replace(/\{\{RESERVE_LINK\}\}/g, "#");
    res.type("html").send(html);
  } catch (err) {
    res.status(404).type("html").send(
      `<p style="font-family:sans-serif;color:#b91c1c;padding:24px">Could not render template "${req.params.name}": ${err.message}</p>`
    );
  }
});

// Send a one-off message without adding it to the campaign template registry.
router.post("/custom-email", requireDb, async (req, res) => {
  const email = typeof req.body?.email === "string" ? req.body.email.trim().toLowerCase() : "";
  const subject = typeof req.body?.subject === "string" ? req.body.subject.trim() : "";
  const body = typeof req.body?.body === "string" ? req.body.body.trim() : "";
  if (!/^\S+@\S+\.\S+$/.test(email)) return res.status(400).json({ error: "valid_email_required" });
  if (!subject || subject.length > 200) return res.status(400).json({ error: "subject_required" });
  if (!body || body.length > 20000) return res.status(400).json({ error: "body_required" });
  try {
    const result = await db.query(
      "SELECT id, email, unsubscribed, hard_bounced FROM users WHERE LOWER(email) = $1",
      [email]
    );
    if (result.rowCount === 0) return res.status(404).json({ error: "contact_not_found" });
    const contact = result.rows[0];
    if (contact.unsubscribed || contact.hard_bounced) {
      return res.status(409).json({ error: "contact_suppressed" });
    }
    await sendCustomEmail(contact, subject, body);
    res.json({ status: "sent", email: contact.email });
  } catch (err) {
    console.error("[admin/custom-email]", err);
    res.status(500).json({ error: "send_failed" });
  }
});

// ---- Repeatable test send ---------------------------------------------------
// Queues the "test" template for internal QA before a real campaign. Unlike the
// Phase B trigger this has NO one-shot guard -- it can be fired repeatedly, and
// it never touches a contact's lifecycle state (last_email_type / reserved stay
// put; only total_emails_sent ticks up).
//
// Body: { id } -> send to that single contact; omit it -> send to every
// contact. Either way the usual unsubscribed / hard-bounced contacts are
// skipped, so a suppressed target simply yields count 0.
router.post("/send-test", requireDb, async (req, res) => {
  const { id } = req.body || {};
  try {
    const audience = id
      ? await db.query(
          "SELECT id FROM users WHERE id = $1 AND unsubscribed = false AND hard_bounced = false",
          [id]
        )
      : await db.query(
          "SELECT id FROM users WHERE unsubscribed = false AND hard_bounced = false"
        );

    if (id && audience.rowCount === 0) {
      return res.status(404).json({ error: "contact_not_found_or_suppressed" });
    }
    for (const row of audience.rows) {
      jobQueue.push({ userId: row.id, emailType: "test", channel: "gmail" });
    }
    res.json({ status: "queued", count: audience.rowCount });
  } catch (err) {
    console.error("[admin/send-test]", err);
    res.status(500).json({ error: "internal_error" });
  }
});

router.post("/send-template", requireDb, async (req, res) => {
  const { id, email_type } = req.body || {};
  try {
    const count = await queueTemplateForAudience(email_type, id);
    res.json({ status: "queued", count, email_type });
  } catch (err) {
    const status = err.message === "contact_not_found_or_suppressed" ? 404 : 400;
    res.status(status).json({ error: err.message });
  }
});

router.get("/api/queue", (req, res) => {
  res.json(jobQueue.queueStatus());
});

router.post("/api/queue/pause", (req, res) => {
  jobQueue.pauseQueue();
  res.json({ status: "paused", ...jobQueue.queueStatus() });
});

router.post("/api/queue/resume", (req, res) => {
  jobQueue.resumeQueue();
  res.json({ status: "resumed", ...jobQueue.queueStatus() });
});

// ---- Manual Phase B trigger (moved here from server.js) ---------------------
router.post("/campaign-email", requireDb, async (req, res) => {
  const { email_type } = req.body;
  const available = listTemplates().map((template) => template.name);
  if (!available.includes(email_type)) {
    return res.status(400).json({ error: "invalid_email_type" });
  }
  try {
    const count = MANUAL_PHASE_B_TYPES.includes(email_type)
      ? await triggerPhaseBManually(email_type)
      : await queueTemplateForAudience(email_type);
    res.json({ status: "queued", count });
  } catch (err) {
    console.error("[admin/campaign-email]", err);
    res.status(500).json({ error: "internal_error" });
  }
});

module.exports = router;
