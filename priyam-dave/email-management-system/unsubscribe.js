const express = require("express");
const jwt = require("jsonwebtoken");
const { jwtSecret } = require("./config");
const db = require("./db");

const router = express.Router();

async function unsubscribeByToken(token) {
  const { email } = jwt.verify(token, jwtSecret);
  await db.query(`UPDATE users SET unsubscribed = true, unsubscribed_at = NOW() WHERE email = $1`, [email]);
  await db.query(
    `INSERT INTO suppression_list (email, reason, source) VALUES ($1, 'unsubscribe', 'user_request')
     ON CONFLICT (email) DO UPDATE SET reason = 'unsubscribe', added_at = NOW()`, [email]);
}

// Footer link and the List-Unsubscribe header URL opened in a browser.
router.get("/unsubscribe", async (req, res) => {
  try {
    await unsubscribeByToken(req.query.token);
    res.send("<h1>You have been unsubscribed.</h1>");
  } catch (err) {
    res.status(400).send("<h1>Invalid unsubscribe link.</h1>");
  }
});

// RFC 8058 one-click: the mailbox provider POSTs "List-Unsubscribe=One-Click"
// to the header URL. Gmail and Yahoo require this for bulk senders.
router.post("/unsubscribe", async (req, res) => {
  try {
    await unsubscribeByToken(req.query.token);
    res.sendStatus(200);
  } catch (err) {
    res.sendStatus(400);
  }
});

module.exports = router;
