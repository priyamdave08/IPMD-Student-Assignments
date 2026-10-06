const Queue = require("better-queue");
const SqliteStore = require("better-queue-sqlite");
const { sendEmailWithTracking } = require("./mailer");
const db = require("./db");

const jobQueue = new Queue(
  async (job, cb) => {
    try {
      const { userId, emailType, channel } = job;

      const userRes = await db.query("SELECT * FROM users WHERE id = $1", [userId]);
      if (userRes.rowCount === 0) return cb(null);

      const user = userRes.rows[0];

      // GLOBAL RULE, enforced again here as a second safety net right
      // before send: skip anyone unsubscribed, suppressed, or hard-bounced.
      const supRes = await db.query(
        "SELECT 1 FROM suppression_list WHERE email = $1",
        [user.email]
      );
      if (supRes.rowCount > 0 || user.unsubscribed || user.hard_bounced) {
        return cb(null);
      }

      await sendEmailWithTracking(user, emailType, channel);
      cb(null);
    } catch (err) {
      console.error("Queue job error:", err);
      cb(err);
    }
  },
  {
    store: new SqliteStore({ path: "jobs.sqlite" }),
    concurrent: 5
  }
);

let paused = false;

function pauseQueue() {
  jobQueue.pause();
  paused = true;
}

function resumeQueue() {
  jobQueue.resume();
  paused = false;
}

function queueStatus() {
  return { paused };
}

jobQueue.pauseQueue = pauseQueue;
jobQueue.resumeQueue = resumeQueue;
jobQueue.queueStatus = queueStatus;

module.exports = jobQueue;
