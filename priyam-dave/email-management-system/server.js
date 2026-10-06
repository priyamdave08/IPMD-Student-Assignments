const express = require("express");
const bodyParser = require("body-parser");
const multer = require("multer");
const bcrypt = require("bcryptjs");
const { parse } = require("csv-parse");
const fs = require("fs");
const db = require("./db");
const trackingRouter = require("./tracking");
const unsubscribeRouter = require("./unsubscribe");
const gdprRouter = require("./gdpr");
const internalRouter = require("./internal");
const adminRouter = require("./admin");
const { startScheduler } = require("./scheduler");
const { adminUsername, adminPasswordHash } = require("./config");

const upload = multer({ dest: "uploads/" });
const app = express();

app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// Server-to-server reservation notifications from the Flask backend, which
// owns the single Stripe webhook. Token-authenticated inside the router.
app.use(internalRouter);

// Basic Auth gate for every /admin/* route. Without this, anyone who finds
// the URL could blast every donor on the list.
function requireAdmin(req, res, next) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith("Basic ")) {
    res.setHeader("WWW-Authenticate", 'Basic realm="admin"');
    return res.status(401).json({ error: "auth_required" });
  }
  const decoded = Buffer.from(header.slice(6), "base64").toString("utf8");
  const [user, pass] = decoded.split(":");
  if (user !== adminUsername || !adminPasswordHash) {
    return res.status(401).json({ error: "invalid_credentials" });
  }
  if (!bcrypt.compareSync(pass || "", adminPasswordHash)) {
    return res.status(401).json({ error: "invalid_credentials" });
  }
  next();
}

app.post("/signup", async (req, res) => {
  const { email, first_name, source } = req.body;
  if (!email) return res.status(400).json({ error: "email required" });

  try {
    const supRes = await db.query(
      "SELECT 1 FROM suppression_list WHERE email = $1",
      [email]
    );
    if (supRes.rowCount > 0) {
      return res.json({ status: "suppressed" });
    }

    const abVariant = Math.random() < 0.5 ? "A" : "B";

    await db.query(
      `INSERT INTO users (email, first_name, source, created_at, paid, last_email_type, scheduled_day, ab_variant)
       VALUES ($1, $2, $3, NOW(), 0, NULL, 1, $4)
       ON CONFLICT (email) DO UPDATE SET first_name = EXCLUDED.first_name`,
      [email, first_name || null, source || "signup", abVariant]
    );

    res.json({ status: "ok" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "internal_error" });
  }
});

app.post("/upload-csv", upload.single("file"), async (req, res) => {
  const filePath = req.file.path;
  const contacts = [];

  fs.createReadStream(filePath)
    .pipe(parse({ columns: true, trim: true }))
    .on("data", (row) => {
      // Case-insensitive header lookup so "Email"/"First Name"/"first_name"
      // etc. all resolve, regardless of how the operator labelled the columns.
      const cell = {};
      for (const key of Object.keys(row)) cell[key.trim().toLowerCase()] = row[key];
      const email = cell["email"];
      const firstNameRaw = cell["first_name"] || cell["first name"] || cell["firstname"];
      const first_name = firstNameRaw && String(firstNameRaw).trim() ? String(firstNameRaw).trim() : null;
      if (email) contacts.push({ email, first_name });
    })
    .on("end", async () => {
      try {
        const existingRes = await db.query("SELECT COUNT(*) AS cnt FROM users");
        let existingCount = parseInt(existingRes.rows[0].cnt, 10);

        for (let i = 0; i < contacts.length; i++) {
          const { email, first_name } = contacts[i];
          const globalIndex = existingCount + i;
          let scheduledDay = 1;
          if (globalIndex >= 2000 && globalIndex < 4000) scheduledDay = 2;
          else if (globalIndex >= 4000) scheduledDay = 3;

          await db.query(
            `INSERT INTO users (email, first_name, created_at, paid, last_email_type, scheduled_day, source)
             VALUES ($1, $2, NOW(), 0, NULL, $3, 'csv')
             ON CONFLICT (email) DO UPDATE SET
               scheduled_day = EXCLUDED.scheduled_day,
               -- Keep an existing name if the new row doesn't supply one.
               first_name = COALESCE(EXCLUDED.first_name, users.first_name)`,
            [email, first_name, scheduledDay]
          );
        }

        fs.unlinkSync(filePath);
        res.json({ status: "ok", imported: contacts.length });
      } catch (err) {
        console.error(err);
        res.status(500).json({ error: "internal_error" });
      }
    });
});

// Admin dashboard (static UI at /admin) + read APIs (/admin/api/*) + the manual
// Phase B trigger (POST /admin/campaign-email). All gated by Basic Auth here so
// the router itself stays auth-free. The browser prompts once and caches creds.
app.use("/admin", requireAdmin, adminRouter);

app.use(trackingRouter);
app.use(unsubscribeRouter);
app.use(gdprRouter);

app.get("/health", (req, res) => res.json({ status: "ok" }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("Server running on port", PORT);
  startScheduler();
});
