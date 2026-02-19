require("dotenv").config();
const { getLinkPreview } = require("link-preview-js");

const { Resend } = require("resend");

const resend = new Resend(process.env.RESEND_API_KEY);

// server.js

const express = require("express");
const sqlite3 = require("sqlite3").verbose();
const cron = require("node-cron");
const path = require("path");

// ======================
// Basic setup
// ======================
const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, "public")));

// ======================
// Database setup
// ======================
const db = new sqlite3.Database("./database.sqlite");

db.serialize(() => {
db.run(`
  CREATE TABLE IF NOT EXISTS entries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    url TEXT NOT NULL UNIQUE,
    event_date TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    emailed INTEGER DEFAULT 0
  )
`);


  db.run(`
    CREATE TABLE IF NOT EXISTS meta (
      key TEXT PRIMARY KEY,
      value TEXT
    )
  `);
});

// ======================
// Helper functions
// ======================

function getLastEmailSent() {
  return new Promise((resolve) => {
    db.get(
      `SELECT value FROM meta WHERE key = 'last_email_sent'`,
      (err, row) => {
        if (row) resolve(new Date(row.value));
        else resolve(null);
      }
    );
  });
}

function updateLastEmailSent() {
  const now = new Date().toISOString();
  db.run(
    `INSERT OR REPLACE INTO meta (key, value)
     VALUES ('last_email_sent', ?)`,
    [now]
  );
}

function getUnemailedEntries() {
  return new Promise((resolve, reject) => {
    db.all(
      `SELECT * FROM entries WHERE emailed = 0 ORDER BY event_date ASC`,
      (err, rows) => {
        if (err) reject(err);
        else resolve(rows);
      }
    );
  });
}

function markEntriesEmailed(ids) {
  const placeholders = ids.map(() => "?").join(",");
  db.run(
    `UPDATE entries SET emailed = 1 WHERE id IN (${placeholders})`,
    ids
  );
}

// ======================
// Email sender (STUB)
// Replace with Resend later
// ======================
async function sendNewsletter(entries) {
  if (!entries.length) return;

  // 🔍 Fetch link previews in parallel
  const enriched = await Promise.all(
    entries.map(async (e) => {
      try {
        const preview = await getLinkPreview(e.url);

        return {
          ...e,
          title: preview.title || e.url,
          description: preview.description || "",
          image: preview.images?.[0] || null,
        };
      } catch (err) {
        console.log("Preview failed for", e.url);
        return {
          ...e,
          title: e.url,
          description: "",
          image: null,
        };
      }
    })
  );

  const issueDate = new Date().toISOString().slice(0, 10);

  const itemsHtml = enriched
    .map((e) => {
      return `
      <div class="item">
        <div class="item-title">
          &gt; <a href="${e.url}">${e.title}</a>
        </div>
        <div class="item-date">
          DATE: ${e.event_date}
        </div>
        ${
          e.description
            ? `<div class="item-desc">${e.description}</div>`
            : ""
        }
      </div>
      `;
    })
    .join("");

  const html = `
<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8" />
<style>
  body { background:#fff; color:#111; font-family: Courier, monospace; font-size:14px; line-height:1.6; }
  .container { max-width:660px; margin:0 auto; padding:20px; }
  .header { white-space:pre; font-size:13px; line-height:1.3; margin-bottom:6px; }
  .subtitle { font-size:12px; color:#777; margin-bottom:24px; letter-spacing:2px; }
  .meta { font-size:12px; color:#777; margin-bottom:28px; white-space:pre; }
  .section-head { white-space:pre; font-size:13px; font-weight:bold; margin-bottom:16px; }
  .item { margin-bottom:22px; }
  .item-title a { color:#111; text-decoration:none; font-weight:bold; }
  .item-date { font-size:12px; color:#999; margin:4px 0 6px 0; }
  .item-desc { font-size:13px; color:#444; }
  .footer { white-space:pre; font-size:12px; color:#999; margin-top:40px; text-align:center; }
</style>
</head>
<body>

<div class="container">

<div class="header" style="font-size:13px; line-height:1.3;">
<pre style="margin:0; font-family:'Courier New', Courier, monospace;">
 ____  _   _ _          _
|  _ \\| | | | |    __ _| |__
| | | | |_| | |   / _\` | '_ \\
| |_| |  _  | |__| (_| | |_) |
|____/|_| |_|_____\\__,_|_.__/
</pre>
</div>

<div class="subtitle">
DIGITAL HUMANITIES LAB -- AUTOMATED BULLETIN
</div>

<div class="meta">
ISSUE: AUTO
DATE: ${issueDate}
ITEMS: ${enriched.length} intercepted
------------------------------------------------
</div>

<div class="section-head">
[SIG] NEW ITEMS
================================================
</div>

${itemsHtml}

<div class="footer">
<pre style="display:inline-block; text-align:center;">
============================

DHLab | Digital Humanities Lab
[ automated digest // generated ${issueDate} ]

============================
</pre>
</div>
</body>
</html>
`;

  try {
    const { data, error } = await resend.emails.send({
      from: `DHLab Newsletter <${process.env.NEWSLETTER_FROM}>`,
      to: process.env.NEWSLETTER_TO,
      subject: `DHLab Signal Dispatch — ${enriched.length} item(s)`,
      html,
    });

    if (error) {
      console.error("Resend error:", error);
      throw error;
    }

    console.log("Email sent:", data?.id);
    return true;
  } catch (err) {
    console.error("Email failed:", err);
    throw err;
  }
}



// ======================
// Core evaluation logic
// ======================
async function evaluateAndSend() {
  try {
    const entries = await getUnemailedEntries();
    if (entries.length === 0) return;

    const now = new Date();
    const sevenDaysFromNow = new Date(
      now.getTime() + 7 * 24 * 60 * 60 * 1000
    );

    const conditionA = entries.some(
      (e) => new Date(e.event_date) <= sevenDaysFromNow
    );

    const conditionB = entries.length >= 7;

    const lastSent = await getLastEmailSent();
    const conditionC =
      !lastSent ||
      now - lastSent > 21 * 24 * 60 * 60 * 1000


    if (conditionA || conditionB || conditionC) {
      await sendNewsletter(entries);
      markEntriesEmailed(entries.map((e) => e.id));
      updateLastEmailSent();
      console.log("Newsletter sent.");
    } else {
      console.log("Conditions not met.");
    }
  } catch (err) {
    console.error("Cron error:", err);
  }
}

// ======================
// Cron job (runs daily at 9am)
// ======================
cron.schedule("0 9 * * *", () => {
  console.log("Running daily check...");
  evaluateAndSend();
});

// ======================
// API endpoint
// ======================
app.post("/submit", (req, res) => {
  const url = req.body.url?.trim();
  const date = req.body.date;

  if (!url || !date) {
  return res.status(400).json({ error: "Missing url or date" });
}

// 🚫 Reject past dates (date-only safe)
const today = new Date();
today.setHours(0, 0, 0, 0);

const submittedDate = new Date(date);
submittedDate.setHours(0, 0, 0, 0);

if (submittedDate < today) {
  return res.status(400).json({
    error: "Date cannot be in the past",
  });
}

  db.run(
    `INSERT INTO entries (url, event_date) VALUES (?, ?)`,
    [url, date],
    function (err) {
      if (err) {
        if (err.message.includes("UNIQUE")) {
          return res.status(409).json({ error: "URL already submitted" });
        }

        console.error(err);
        return res.status(500).json({ error: "DB error" });
      }

      res.json({ success: true, id: this.lastID });
    }
  );
});


// ======================
// Health check
// ======================
app.get("/health", (_, res) => {
  res.send("OK");
});

app.get("/test-send", async (req, res) => {
  await evaluateAndSend();
  res.send("Triggered email check");
});

// ======================
// Start server
// ======================
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});



//=====================
// Debug endpoint to view all entries (for development only)
//=====================
app.get("/admin/entries", (req, res) => {
  db.all(
    `SELECT * FROM entries ORDER BY created_at DESC`,
    (err, rows) => {
      if (err) {
        console.error(err);
        return res.status(500).send("DB error");
      }
      res.json(rows);
    }
  );
});
