const cron = require("node-cron");
const db = require("./db");
const jobQueue = require("./queue");
const { getWarmupLimit, getDailyCounts } = require("./mailer");
const { runPhaseBTick } = require("./phaseB");

// GLOBAL RULE: every candidate query below excludes unsubscribed and
// hard-bounced contacts. This is enforced here AND again at send-time
// in queue.js as a second safety net.
const SAFE_FILTER = `unsubscribed = false AND hard_bounced = false`;

function startScheduler() {
  cron.schedule("*/10 * * * *", async () => {
    console.log("[SCHEDULER] Tick");

    const warmupLimit = getWarmupLimit();
    const counts = await getDailyCounts();
    let remaining = warmupLimit - (counts.gmail + counts.brevo);
    if (remaining <= 0) {
      console.log("[SCHEDULER] No remaining capacity");
    } else {
      // ---- Email 1: WELCOME / MAIN $1 ASK (sent immediately, whole list) ----
      const welcomeRes = await db.query(
        `SELECT * FROM users
         WHERE (last_email_type IS NULL OR last_email_type = '')
           AND scheduled_day IS NOT NULL
           AND ${SAFE_FILTER}
         ORDER BY created_at ASC
         LIMIT $1`,
        [remaining]
      );
      for (const user of welcomeRes.rows) {
        jobQueue.push({ userId: user.id, emailType: "welcome", channel: "gmail" });
        await db.query(`UPDATE users SET last_email_type = 'welcome' WHERE id = $1`, [user.id]);
      }

      remaining = warmupLimit - (await getDailyCounts()).gmail;
      if (remaining > 0) {
        // ---- Nudge (~2-3 days later): branches on CLICKS, not opens ----
        const nudgeRes = await db.query(
          `SELECT * FROM users
           WHERE last_email_type = 'welcome'
             AND reserved = false
             AND created_at + INTERVAL '2 days' < NOW()
             AND ${SAFE_FILTER}
           LIMIT $1`,
          [remaining]
        );
        for (const user of nudgeRes.rows) {
          if (user.click_count > 0) {
            // Clicked but didn't reserve -> Email 5
            jobQueue.push({ userId: user.id, emailType: "reengage", channel: "gmail" });
            await db.query(`UPDATE users SET last_email_type = 'nudge_reengage' WHERE id = $1`, [user.id]);
          } else {
            // Didn't open / click -> Email 2, fresh subject
            jobQueue.push({ userId: user.id, emailType: "resend", channel: "gmail" });
            await db.query(`UPDATE users SET last_email_type = 'nudge_resend' WHERE id = $1`, [user.id]);
          }
        }
      }

      remaining = warmupLimit - (await getDailyCounts()).gmail;
      if (remaining > 0) {
        // ---- Final attempt (~3-4 days after nudge): branches on click_count ----
        const finalRes = await db.query(
          `SELECT * FROM users
           WHERE last_email_type IN ('nudge_reengage', 'nudge_resend')
             AND reserved = false
             AND created_at + INTERVAL '5 days' < NOW()
             AND ${SAFE_FILTER}
           LIMIT $1`,
          [remaining]
        );
        for (const user of finalRes.rows) {
          if (user.click_count > 0) {
            // Engaged (clicked), never reserved -> Email 6
            jobQueue.push({ userId: user.id, emailType: "final_nudge", channel: "gmail" });
            await db.query(`UPDATE users SET last_email_type = 'final_nudge' WHERE id = $1`, [user.id]);
          } else {
            // Cold -- never clicked -> Email 3 (nurture only, dropped from reserve asks,
            // but NOT dropped from the contact list -- still gets Phase B)
            jobQueue.push({ userId: user.id, emailType: "last_call", channel: "gmail" });
            await db.query(`UPDATE users SET last_email_type = 'last_call' WHERE id = $1`, [user.id]);
          }
        }
      }
      // After this point: HOLD. No more Phase A sends until Phase B triggers.
    }

    // ---- Phase B: launch-week emails, checked every tick, sent once per calendar target ----
    try {
      await runPhaseBTick();
    } catch (err) {
      console.error("[PHASE B] tick error:", err);
    }
  });
}

module.exports = { startScheduler };
