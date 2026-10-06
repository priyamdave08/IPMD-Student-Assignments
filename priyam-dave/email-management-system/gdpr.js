const express = require("express");
const db = require("./db");

const router = express.Router();

router.delete("/api/gdpr/delete", async (req, res) => {
  const { email } = req.query;
  if (!email) return res.status(400).json({ error: "email required" });
  try {
    const userRes = await db.query("SELECT id FROM users WHERE email = $1", [email]);
    if (userRes.rowCount === 0) return res.json({ status: "not_found" });
    const userId = userRes.rows[0].id;
    await db.query("DELETE FROM analytics_events WHERE user_id = $1", [userId]);
    await db.query("DELETE FROM send_log WHERE user_id = $1", [userId]);
    await db.query("DELETE FROM users WHERE id = $1", [userId]);
    await db.query(
      `INSERT INTO suppression_list (email, reason, source) VALUES ($1, 'gdpr_delete', 'admin')
       ON CONFLICT (email) DO UPDATE SET reason = 'gdpr_delete', added_at = NOW()`, [email]);
    res.json({ status: "deleted" });
  } catch (err) {
    res.status(500).json({ error: "internal_error" });
  }
});

module.exports = router;
