// Seed demo data for the EMS admin dashboard.
//
//   npm run seed
//
// Inserts ~40 sample contacts spread across every lifecycle stage (welcome →
// nudge → final/last-call → reserved), plus matching send_log + analytics_events
// (opens/clicks) and a couple suppression rows, so the dashboard looks alive on
// a fresh database.
//
// Idempotent: every row it creates is tagged source='demo' and cleared before
// re-inserting, so running it repeatedly is safe. It never touches real contacts.

const db = require("./../db");
const { pgConnectionString } = require("./../config");

const FIRST_NAMES = [
  "Maya", "Leo", "Aisha", "Noah", "Priya", "Diego", "Hana", "Omar", "Zoe", "Kai",
  "Sofia", "Ravi", "Elena", "Marcus", "Yuki", "Amara", "Theo", "Nadia", "Finn", "Lucia"
];

// Each archetype describes a lifecycle position and how engaged the contact is.
// `count` sets how many of the ~40 land in each bucket.
const ARCHETYPES = [
  { stage: "not_started", last_email_type: null, sends: [], reserved: false, count: 6 },
  { stage: "welcomed", last_email_type: "welcome", sends: ["welcome"], opens: 1, reserved: false, count: 8 },
  { stage: "nudged", last_email_type: "nudge_reengage", sends: ["welcome", "reengage"], opens: 2, clicks: 1, reserved: false, count: 8 },
  { stage: "final", last_email_type: "last_call", sends: ["welcome", "reengage", "last_call"], opens: 2, clicks: 1, reserved: false, count: 6 },
  { stage: "final_cold", last_email_type: "final_nudge", sends: ["welcome", "resend", "final_nudge"], opens: 0, reserved: false, count: 4 },
  { stage: "reserved", last_email_type: "reserved_thankyou", sends: ["welcome", "reengage", "reserved_thankyou"], opens: 3, clicks: 2, reserved: true, count: 8 }
];

function daysAgo(n) {
  return new Date(Date.now() - n * 24 * 60 * 60 * 1000);
}
function pick(arr, i) {
  return arr[i % arr.length];
}

async function seed() {
  if (!pgConnectionString) {
    console.error("PG_CONNECTION_STRING is not set. Configure email-system/.env first.");
    process.exit(1);
  }

  console.log("Clearing previous demo data…");
  // Children first (FK), then users, then demo suppression rows.
  await db.query("DELETE FROM send_log WHERE user_id IN (SELECT id FROM users WHERE source = 'demo')");
  await db.query("DELETE FROM analytics_events WHERE user_id IN (SELECT id FROM users WHERE source = 'demo')");
  await db.query("DELETE FROM users WHERE source = 'demo'");
  await db.query("DELETE FROM suppression_list WHERE source = 'demo'");

  let created = 0;
  let idx = 0;

  for (const arc of ARCHETYPES) {
    for (let i = 0; i < arc.count; i++) {
      const first = pick(FIRST_NAMES, idx);
      const email = `${first.toLowerCase()}.${arc.stage}${i}@demo.ipmd`;
      const createdAt = daysAgo(14 - (idx % 14));
      const abVariant = idx % 2 === 0 ? "A" : "B";
      const engagement = (arc.reserved ? 50 : 0) + (arc.opens || 0) * 5 + (arc.clicks || 0) * 10;
      const donation = arc.reserved ? 100 : null; // cents ($1 reservation)
      const lastOpened = arc.opens ? daysAgo((idx % 5) + 1) : null;
      const lastClicked = arc.clicks ? daysAgo(idx % 4) : null;

      const userRes = await db.query(
        `INSERT INTO users
           (email, first_name, source, created_at, paid, donation_amount, last_email_type,
            scheduled_day, ab_variant, engagement_score, tags, click_count, total_emails_sent,
            last_opened_at, last_clicked_at, reserved, reserved_at)
         VALUES ($1,$2,'demo',$3,$4,$5,$6,1,$7,$8,$9,$10,$11,$12,$13,$14,$15)
         RETURNING id`,
        [
          email,
          first,
          createdAt,
          arc.reserved ? 1 : 0,
          donation,
          arc.last_email_type,
          abVariant,
          engagement,
          arc.reserved ? '["vip"]' : "[]",
          arc.clicks || 0,
          arc.sends.length,
          lastOpened,
          lastClicked,
          arc.reserved,
          arc.reserved ? daysAgo(idx % 3) : null
        ]
      );
      const userId = userRes.rows[0].id;

      // send_log + analytics_events for each email this contact received.
      for (let s = 0; s < arc.sends.length; s++) {
        const type = arc.sends[s];
        const sentAt = daysAgo(arc.sends.length - s + 1);
        await db.query(
          `INSERT INTO send_log (user_id, sent_at, email_type, variant, channel, status)
           VALUES ($1,$2,$3,$4,'gmail','sent')`,
          [userId, sentAt, type, abVariant]
        );
        const opened = s < (arc.opens || 0);
        const clicked = s < (arc.clicks || 0);
        await db.query(
          `INSERT INTO analytics_events (user_id, sent_at, email_type, variant, channel, status, opened_at, clicked_at)
           VALUES ($1,$2,$3,$4,'gmail','sent',$5,$6)`,
          [userId, sentAt, type, abVariant, opened ? sentAt : null, clicked ? sentAt : null]
        );
      }

      // A reserved contact logged a 'reserved' conversion event.
      if (arc.reserved) {
        await db.query(
          `INSERT INTO analytics_events (user_id, sent_at, email_type, status)
           VALUES ($1,$2,'reserved','reserved')`,
          [userId, daysAgo(idx % 3)]
        );
      }

      created++;
      idx++;
    }
  }

  // A couple of suppressed addresses so that tab isn't empty.
  await db.query(
    `INSERT INTO suppression_list (email, reason, source) VALUES
       ('bounced.hard@demo.ipmd','hard_bounce','demo'),
       ('complained@demo.ipmd','spam_complaint','demo')
     ON CONFLICT (email) DO NOTHING`
  );

  console.log(`Seeded ${created} demo contacts + email history + 2 suppression rows.`);
  await db.pool.end();
}

seed().catch((err) => {
  console.error("Seed failed:", err);
  process.exit(1);
});
