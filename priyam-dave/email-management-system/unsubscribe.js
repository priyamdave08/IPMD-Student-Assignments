const express = require("express");
const jwt = require("jsonwebtoken");
const { jwtSecret } = require("./config");
const db = require("./db");

const router = express.Router();

router.get("/unsubscribe", async (req, res) => {
  try {
    const token = req.query.token;
    const payload = jwt.verify(token, jwtSecret);
    const { email } = payload;
    await db.query(`UPDATE users SET unsubscribed = true, unsubscribed_at = NOW() WHERE email = $1`, [email]);
    await db.query(
      `INSERT INTO suppression_list (email, reason, source) VALUES ($1, 'unsubscribe', 'user_request')
       ON CONFLICT (email) DO UPDATE SET reason = 'unsubscribe', added_at = NOW()`, [email]);
    res.send("<h1>You have been unsubscribed.</h1>");
  } catch (err) {
    res.status(400).send("<h1>Invalid unsubscribe link.</h1>");
  }
});

module.exports = router;
