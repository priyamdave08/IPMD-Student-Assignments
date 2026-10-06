const db = require("./db");
const jobQueue = require("./queue");
const schedule = require("./phaseb-schedule");

// GLOBAL RULE still applies (unsubscribed / hard-bounced are always skipped),
// but Phase B is NEVER filtered by engagement_score, last_email_type, or
// whether someone was marked "cold" in Phase A -- everyone still gets these.
const SAFE_FILTER = `unsubscribed = false AND hard_bounced = false`;

async function alreadySent(emailType) {
  const res = await db.query(
    `SELECT 1 FROM campaigns WHERE name = $1 AND status = 'sent' LIMIT 1`,
    [emailType]
  );
  return res.rowCount > 0;
}

async function markSent(emailType) {
  await db.query(
    `INSERT INTO campaigns (name, status, created_at) VALUES ($1, 'sent', NOW())`,
    [emailType]
  );
}

async function getAudience(audienceType) {
  if (audienceType === "reservers") {
    const res = await db.query(`SELECT * FROM users WHERE reserved = true AND ${SAFE_FILTER}`);
    return res.rows;
  }
  if (audienceType === "non_openers_of_we_are_live") {
    const res = await db.query(
      `SELECT u.* FROM users u
       WHERE u.unsubscribed = false AND u.hard_bounced = false
         AND EXISTS (SELECT 1 FROM send_log s WHERE s.user_id = u.id AND s.email_type = 'we_are_live')
         AND NOT EXISTS (
           SELECT 1 FROM analytics_events a
           WHERE a.user_id = u.id AND a.email_type = 'we_are_live' AND a.opened_at IS NOT NULL
         )`
    );
    return res.rows;
  }
  // "everyone"
  const res = await db.query(`SELECT * FROM users WHERE ${SAFE_FILTER}`);
  return res.rows;
}

// Called once per scheduler tick (every 10 min). Sends a Phase B email exactly
// once the first time "now" passes its targetDate, then marks it sent so it
// never fires again -- safe even if the server restarts mid-launch-week.
async function runPhaseBTick() {
  const now = new Date();
  for (const entry of schedule) {
    const target = new Date(entry.targetDate);
    if (now < target) continue;
    if (await alreadySent(entry.emailType)) continue;

    console.log(`[PHASE B] Triggering ${entry.emailType} (${entry.label})`);
    const audience = await getAudience(entry.audience);
    for (const user of audience) {
      jobQueue.push({ userId: user.id, emailType: entry.emailType, channel: "gmail" });
    }
    await markSent(entry.emailType);
    console.log(`[PHASE B] Queued ${audience.length} sends for ${entry.emailType}`);
  }
}

// Manual override -- lets the admin force-send a Phase B email early via
// POST /admin/campaign-email, e.g. if a date needs to move at the last minute.
async function triggerPhaseBManually(emailType) {
  const entry = schedule.find((e) => e.emailType === emailType);
  if (!entry) throw new Error("Unknown Phase B email type: " + emailType);
  const audience = await getAudience(entry.audience);
  for (const user of audience) {
    jobQueue.push({ userId: user.id, emailType: entry.emailType, channel: "gmail" });
  }
  if (!(await alreadySent(entry.emailType))) await markSent(entry.emailType);
  return audience.length;
}

module.exports = { runPhaseBTick, triggerPhaseBManually };
