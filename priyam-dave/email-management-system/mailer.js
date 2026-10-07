const nodemailer = require("nodemailer");
const fs = require("fs");
const path = require("path");
const mjml2html = require("mjml");
const db = require("./db");
const { gmailUser, gmailPass, jwtSecret } = require("./config");
const jwt = require("jsonwebtoken");

const EMAIL_DIR = path.join(__dirname, "email");
const BUILTIN_TEMPLATES = [
  { name: "welcome", phase: "A" }, { name: "resend", phase: "A" },
  { name: "reengage", phase: "A" }, { name: "final_nudge", phase: "A" },
  { name: "last_call", phase: "A" }, { name: "reserved_thankyou", phase: "conversion" },
  { name: "follow_kickstarter", phase: "B" }, { name: "launch_instructions", phase: "B" },
  { name: "vip_private_link", phase: "B" }, { name: "we_are_live", phase: "B" },
  { name: "still_live", phase: "B" }, { name: "test", phase: "test" }
];

const gmailTransporter = nodemailer.createTransport({
  service: "gmail",
  auth: { user: gmailUser, pass: gmailPass }
});

function getTodayRange() {
  const d = new Date();
  const start = new Date(d.toISOString().slice(0, 10) + "T00:00:00Z");
  const end = new Date(d.toISOString().slice(0, 10) + "T23:59:59Z");
  return { start, end };
}

// Kept as {gmail, brevo} shape for compatibility with scheduler.js's warmup
// math -- brevo is unused now (no Brevo credentials), always reports 0.
async function getDailyCounts() {
  const { start, end } = getTodayRange();
  const res = await db.query(
    "SELECT channel, COUNT(*) AS cnt FROM send_log WHERE sent_at BETWEEN $1 AND $2 GROUP BY channel",
    [start, end]
  );
  const counts = { gmail: 0, brevo: 0 };
  res.rows.forEach((r) => { counts[r.channel] = parseInt(r.cnt, 10); });
  return counts;
}

function getWarmupLimit() {
  const start = new Date(process.env.WARMUP_START_DATE || new Date());
  const now = new Date();
  const diffDays = Math.floor((now - start) / (1000 * 60 * 60 * 24)) + 1;
  const schedule = { 1: 50, 2: 100, 3: 200, 4: 300, 5: 500, 6: 700, 7: 1000, 8: 1500, 9: 2000 };
  return schedule[diffDays] || 2000;
}

function compileTemplate(mjml) {
  const compiled = mjml2html(mjml);
  if (compiled.errors && compiled.errors.length > 0) {
    throw new Error(compiled.errors.map((error) => error.message || String(error)).join("; "));
  }
  return compiled.html;
}

function loadTemplate(emailType) {
  if (!/^[a-z][a-z0-9_-]{1,63}$/.test(emailType || "")) throw new Error("Unknown emailType: " + emailType);
  const templatePath = path.join(EMAIL_DIR, `${emailType}.mjml`);
  if (!fs.existsSync(templatePath)) throw new Error("Unknown emailType: " + emailType);

  const mjml = fs.readFileSync(templatePath, "utf8");
  return compileTemplate(mjml);
}

function previewTemplate(mjml) {
  if (!mjml || !/<mjml[\s>]/i.test(mjml)) throw new Error("MJML source must contain an <mjml> root");
  return compileTemplate(mjml);
}

function listTemplates() {
  const builtins = new Map(BUILTIN_TEMPLATES.map((template) => [template.name, template]));
  return fs.readdirSync(EMAIL_DIR)
    .filter((file) => /^[a-z][a-z0-9_-]{1,63}\.mjml$/.test(file))
    .map((file) => file.slice(0, -5))
    .map((name) => builtins.get(name) || { name, phase: "custom" });
}

function createTemplate(name, mjml) {
  if (!/^[a-z][a-z0-9_-]{1,63}$/.test(name || "") || BUILTIN_TEMPLATES.some((template) => template.name === name)) {
    throw new Error("Invalid or protected template name");
  }
  if (!mjml || !/<mjml[\s>]/i.test(mjml)) throw new Error("MJML source must contain an <mjml> root");
  const compiled = mjml2html(mjml);
  if (compiled.errors && compiled.errors.length > 0) {
    throw new Error(compiled.errors.map((error) => error.message || String(error)).join("; "));
  }
  const templatePath = path.join(EMAIL_DIR, `${name}.mjml`);
  if (fs.existsSync(templatePath)) throw new Error("Template already exists");
  fs.writeFileSync(templatePath, mjml, "utf8");
}

function deleteTemplate(name) {
  if (BUILTIN_TEMPLATES.some((template) => template.name === name)) {
    throw new Error("Built-in lifecycle templates cannot be deleted");
  }
  if (!/^[a-z][a-z0-9_-]{1,63}$/.test(name || "")) throw new Error("Invalid template name");
  const templatePath = path.join(EMAIL_DIR, `${name}.mjml`);
  if (!fs.existsSync(templatePath)) throw new Error("Template not found");
  fs.unlinkSync(templatePath);
}

// The name used in "Hi {{first_name}},". Prefer the contact's stored first
// name; when we don't have one, derive an actual name from their email address
// (the local part before "@", separators split off, trailing digits stripped,
// title-cased) so every recipient is greeted by a real name -- never a generic
// "there" or a raw {{first_name}} placeholder. Only truly nameless input
// (no first_name and no usable email) falls back to "there".
function greetingName(user) {
  const stored = (user.first_name || "").trim();
  if (stored) return stored;
  const local = (user.email || "").split("@")[0];
  const token = local.split(/[._+-]/)[0].replace(/[0-9]+$/, "");
  if (!token) return "there";
  return token.charAt(0).toUpperCase() + token.slice(1).toLowerCase();
}

// Signed unsubscribe URL for a contact. Used for the footer link AND the
// List-Unsubscribe header, so Gmail's own Unsubscribe button (GET) and RFC 8058
// one-click (POST) both hit /unsubscribe with a token it will accept.
function unsubscribeUrl(user) {
  const baseUrl = process.env.PUBLIC_BASE_URL || "https://your-domain.com";
  const token = jwt.sign({ email: user.email, userId: user.id }, jwtSecret);
  return `${baseUrl}/unsubscribe?token=${token}`;
}

// Plain-text alternative for the multipart/alternative body. HTML-only mail is
// a spam signal, and text-only clients otherwise show nothing. Derived from the
// final HTML (after tracking injection) so links in both parts match: each link
// becomes "label (url)", block elements become line breaks, and the hidden
// preheader, MSO conditionals, styles and the tracking pixel are dropped.
function htmlToText(html) {
  return html
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<(head|style|script)[\s\S]*?<\/\1>/gi, "")
    .replace(/<div[^>]*display:\s*none[^>]*>[\s\S]*?<\/div>/gi, "")
    .replace(/<img[^>]*>/gi, "")
    .replace(/<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi, (m, href, label) => {
      const text = label.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
      return text ? `${text} (${href})` : href;
    })
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|tr|h[1-6]|li)>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function injectTracking(html, user, emailType) {
  const tokenPayload = { email: user.email, userId: user.id, emailType };
  const token = jwt.sign(tokenPayload, jwtSecret);

  const baseUrl = process.env.PUBLIC_BASE_URL || "https://your-domain.com";
  const openPixel = `<img src="${baseUrl}/track/open/${token}" width="1" height="1" style="display:none;" />`;

  let trackedHtml = html.replace("</body>", `${openPixel}</body>`);

  // Campaign CTA links that aren't finalised yet are templated as tokens and
  // filled from env HERE — before the click-tracking rewrite below, so they get
  // wrapped in /track/click like any other link. Unset links fall back to "#"
  // (a visible dead link) so a misconfiguration is obvious. The reserve CTA is
  // handled separately (it routes through /reserve-click, not /track/click).
  const campaignLinks = {
    "{{KICKSTARTER_LINK}}": process.env.KICKSTARTER_URL,
    "{{VIP_LINK}}": process.env.VIP_KICKSTARTER_URL || process.env.KICKSTARTER_URL,
    "{{PRELAUNCH_LINK}}": process.env.PRELAUNCH_URL,
    "{{COMMUNITY_LINK}}": process.env.COMMUNITY_URL
  };
  for (const [tok, url] of Object.entries(campaignLinks)) {
    trackedHtml = trackedHtml.split(tok).join(url || "#");
  }

  trackedHtml = trackedHtml.replace(
    /href="(https?:\/\/[^"]+)"/g,
    (match, url) => `href="${baseUrl}/track/click/${token}?url=${encodeURIComponent(url)}"`
  );

  // The reserve CTA routes through our own /reserve-click endpoint, which
  // counts a "reserve intent click" and then redirects to the landing-page
  // /emotion-sphere reservation flow (see tracking.js). It is deliberately NOT
  // rewritten through the generic /track/click handler.
  const reserveTrackUrl = `${baseUrl}/reserve-click/${token}`;
  trackedHtml = trackedHtml.replace(/\{\{RESERVE_LINK\}\}/g, reserveTrackUrl);

  // Personalise the greeting with the recipient's actual name (see
  // greetingName): the stored first name, or one derived from their email when
  // we don't have one -- never a generic greeting or a raw placeholder.
  const firstName = greetingName(user);
  trackedHtml = trackedHtml.replace(/\{\{first_name\}\}/g, firstName);

  const unsubscribeLink = unsubscribeUrl(user);

  // Physical postal address is required for CAN-SPAM compliance. Set
  // SENDER_POSTAL_ADDRESS in the environment; falls back to a clearly-marked
  // placeholder so a misconfiguration is obvious rather than silently shipping.
  const postalAddress = process.env.SENDER_POSTAL_ADDRESS || "IPMD Inc., [set SENDER_POSTAL_ADDRESS]";
  trackedHtml = trackedHtml.replace(
    "</body>",
    `<p style="font-size:12px;color:#888;">
      ${postalAddress}<br/>
      <a href="${unsubscribeLink}">Unsubscribe</a>
    </p></body>`
  );

  return trackedHtml;
}

async function sendCustomEmail(user, subject, body) {
  const unsubscribeLink = unsubscribeUrl(user);
  const escapedBody = String(body)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\r?\n/g, "<br>");
  const html = `<div style="font-family:Arial,sans-serif;color:#2A2F42;line-height:1.6;white-space:normal;">${escapedBody}</div><p style="font-size:12px;color:#888;">${process.env.SENDER_POSTAL_ADDRESS || "IPMD Inc., [set SENDER_POSTAL_ADDRESS]"}<br/><a href="${unsubscribeLink}">Unsubscribe</a></p>`;

  await gmailTransporter.sendMail({
    from: gmailUser,
    to: user.email,
    subject,
    html,
    text: htmlToText(html),
    headers: {
      "Return-Path": "bounce@ipmdinc.com",
      "List-Unsubscribe": `<mailto:bounce@ipmdinc.com>, <${unsubscribeLink}>`,
      "List-Unsubscribe-Post": "List-Unsubscribe=One-Click"
    }
  });

  await db.query(
    `INSERT INTO send_log (user_id, sent_at, email_type, variant, channel, status)
     VALUES ($1, NOW(), 'custom', 'A', 'gmail', 'sent')`,
    [user.id]
  );
  await db.query("UPDATE users SET total_emails_sent = total_emails_sent + 1 WHERE id = $1", [user.id]);
}

async function sendEmailWithTracking(user, emailType, channelPreferred = "gmail") {
  const counts = await getDailyCounts();
  const warmupLimit = getWarmupLimit();
  const totalToday = counts.gmail + counts.brevo;

  if (totalToday >= warmupLimit) {
    console.log("Daily warmup limit reached:", totalToday, "/", warmupLimit);
    return;
  }

  const htmlRaw = loadTemplate(emailType);
  const html = injectTracking(htmlRaw, user, emailType);

  // Subject lines from KS_Email_Marketing_Contents.xlsx. Where the sheet gives
  // two subjects, we run a simple 50/50 A/B split on the contact's ab_variant
  // (assigned at signup): variant "B" contacts get subject B, everyone else A.
  // Emails with only one subject in the sheet use it for both variants.
  const subjectMap = {
    welcome: { A: "How Are You Feeling Today?", B: "A new way to show how you feel" },
    resend: { A: "We Invite You! 💌", B: "A new way to show how you feel" },
    reengage: { A: "We Appreciate Your Time :)" },
    final_nudge: { A: "We Don't Want You To Miss Your Spot!" },
    last_call: { A: "One last invitation to reserve", B: "Last call to reserve for $1" },
    reserved_thankyou: { A: "YOU'RE IN! — your EchoSphere spot is reserved" },
    follow_kickstarter: { A: "Mark Your Calendars: D-7 📅✅", B: "One week from today — EchoSphere launches" },
    launch_instructions: { A: "❗️D-1 Till Live❗️ Here's What You Should Know:", B: "8 AM tomorrow — EchoSphere goes live" },
    vip_private_link: { A: "⭐️Your Special Early Access Link 🔗⭐️", B: "It's live for you first" },
    we_are_live: { A: "ANDD We're Finally Live! Back us now!", B: "It's happening. EchoSphere is live right now." },
    still_live: { A: "You Still Have Time to Back Us. We're Still Live!", B: "In case you missed it — we launched today" },
    unsubscribe_confirmation: { A: "Thank You, and We Hope to See You Again Soon 👋" },
    test: { A: "🧪 EMS test email — please confirm you received this" }
  };

  // 50/50 split: fall back to A when the contact has no B subject or no variant.
  const variant = user.ab_variant === "B" ? "B" : "A";
  const subjects = subjectMap[emailType] || {};
  const subject = subjects[variant] || subjects.A || "IPMD Update";

  const mailOptions = {
    from: gmailUser,
    to: user.email,
    subject,
    html,
    text: htmlToText(html),
    headers: {
      "Return-Path": "bounce@ipmdinc.com",
      "List-Unsubscribe": `<mailto:bounce@ipmdinc.com>, <${unsubscribeUrl(user)}>`,
      "List-Unsubscribe-Post": "List-Unsubscribe=One-Click"
    }
  };

  // Gmail-only for now -- Brevo dropped (no credentials available).
  await gmailTransporter.sendMail(mailOptions);
  const channel = "gmail";

  // Record the A/B variant so open rates can be compared per subject line.
  await db.query(
    `INSERT INTO send_log (user_id, sent_at, email_type, variant, channel, status)
     VALUES ($1, NOW(), $2, $3, $4, 'sent')`,
    [user.id, emailType, variant, channel]
  );

  await db.query(
    `UPDATE users SET total_emails_sent = total_emails_sent + 1 WHERE id = $1`,
    [user.id]
  );
}

module.exports = {
  sendEmailWithTracking,
  sendCustomEmail,
  getWarmupLimit,
  getDailyCounts,
  loadTemplate,
  previewTemplate,
  listTemplates,
  createTemplate,
  deleteTemplate
};
