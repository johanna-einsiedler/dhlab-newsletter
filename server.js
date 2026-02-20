require("dotenv").config();
const { getLinkPreview } = require("link-preview-js");
const { Resend } = require("resend");
const express = require("express");
const cron = require("node-cron");
const path = require("path");
const { google } = require("googleapis");

const resend = new Resend(process.env.RESEND_API_KEY);
const PUBLIC_FORM_URL = process.env.PUBLIC_FORM_URL;

console.log(
  "Service email:",
  process.env.GOOGLE_SERVICE_EMAIL
);
console.log(
  "Private key starts with:",
  process.env.GOOGLE_PRIVATE_KEY?.slice(0, 30)
);

// ======================
// Google Sheets setup
// ======================
const auth = new google.auth.JWT({
  email: process.env.GOOGLE_SERVICE_EMAIL,
  key: process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, "\n"),
  scopes: ["https://www.googleapis.com/auth/spreadsheets"],
});

const sheets = google.sheets({ version: "v4", auth });


const SHEET_ID = process.env.GOOGLE_SHEET_ID;
const SHEET_NAME = "entries";

// simple in-memory last sent tracker (good enough for your scale)
let lastEmailSent = null;

async function getLastEmailSent() {
  return lastEmailSent;
}

function updateLastEmailSent() {
  lastEmailSent = new Date();
}

// ======================
// Basic setup
// ======================
const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, "public")));

// ======================
// Sheet helpers
// ======================
async function getUnemailedEntries() {
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: `${SHEET_NAME}!A2:E`,
  });

  const rows = res.data.values || [];

  return rows
    .map((r) => ({
      id: r[0],
      url: r[1],
      event_date: r[2],
      created_at: r[3],
      emailed: Number(r[4] || 0),
    }))
    .filter((r) => r.emailed === 0)
    .sort((a, b) => new Date(a.event_date) - new Date(b.event_date));
}

async function markEntriesEmailed(ids) {
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: `${SHEET_NAME}!A2:E`,
  });

  const rows = res.data.values || [];

  const updated = rows.map((r) => {
    if (ids.includes(r[0])) {
      r[4] = 1;
    }
    return r;
  });

  await sheets.spreadsheets.values.update({
    spreadsheetId: SHEET_ID,
    range: `${SHEET_NAME}!A2`,
    valueInputOption: "RAW",
    requestBody: { values: updated },
  });
}

// ======================
// Email sender
// ======================
async function sendNewsletter(entries) {
  if (!entries.length) return;

  const enriched = await Promise.all(
    entries.map(async (e) => {
      try {
        const preview = await getLinkPreview(e.url);
        return {
          ...e,
          title: preview.title || e.url,
          description: preview.description || "",
        };
      } catch {
        return {
          ...e,
          title: e.url,
          description: "",
        };
      }
    })
  );

  const issueDate = new Date().toISOString().slice(0, 10);

  const itemsHtml = enriched
    .map(
      (e) => `
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
    `
    )
    .join("");

  const html = `
<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8" />
<style>
  body { background:#fff; color:#111; font-family: Courier, monospace; font-size:14px; line-height:1.6; }
  .container { max-width:660px; margin:0 auto; padding:20px; }
  .item { margin-bottom:22px; }
  .item-title a { color:#111; text-decoration:none; font-weight:bold; }
  .item-date { font-size:12px; color:#999; margin:4px 0 6px 0; }
  .item-desc { font-size:13px; color:#444; }
</style>
</head>
<body>

<div class="container">

<pre style="margin:0; font-family:'Courier New', monospace;">
 ____  _   _ _          _
|  _ \\| | | | |    __ _| |__
| | | | |_| | |   / _\` | '_ \\
| |_| |  _  | |__| (_| | |_) |
|____/|_| |_|_____\\__,_|_.__/
</pre>

<p><strong>DIGITAL HUMANITIES LAB — AUTOMATED BULLETIN</strong></p>
<p>ITEMS: ${enriched.length}</p>
<hr/>

${itemsHtml}

<hr/>

<div style="margin-top:28px; font-family: Courier, monospace;">
<pre style="display:inline-block; text-align:left; font-size:12px; color:#666;">
------------------------------------------------------------
SUBMIT SOMETHING INTERESTING?

Seen a call, event, or opportunity worth sharing?
Add it to the next dispatch:

→ <a href="${PUBLIC_FORM_URL}" style="color:#555;">Fill out the form</a>
------------------------------------------------------------
</pre>
</div>

<p style="font-size:12px;color:#777;margin-top:18px;">
DHLab | Digital Humanities Lab<br/>
automated digest — ${issueDate}
</p>

</div>
</body>
</html>
`;

  const { data, error } = await resend.emails.send({
    from: `DHLab Newsletter <${process.env.NEWSLETTER_FROM}>`,
    to: process.env.NEWSLETTER_TO,
    subject: `DHLab Signal Dispatch — ${enriched.length} item(s)`,
    html,
  });

  if (error) throw error;

  console.log("Email sent:", data?.id);
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
      now - lastSent > 21 * 24 * 60 * 60 * 1000;

    if (conditionA || conditionB || conditionC) {
      await sendNewsletter(entries);
      await markEntriesEmailed(entries.map((e) => e.id));
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
// Cron job
// ======================
cron.schedule("0 9 * * *", () => {
  console.log("Running daily check...");
  evaluateAndSend();
});

// ======================
// Submit endpoint
// ======================
app.post("/submit", async (req, res) => {
  const url = req.body.url?.trim();
  const date = req.body.date;

  if (!url || !date) {
    return res.status(400).json({ error: "Missing url or date" });
  }

  // reject past dates
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const submittedDate = new Date(date);
  submittedDate.setHours(0, 0, 0, 0);

  if (submittedDate < today) {
    return res.status(400).json({
      error: "Date cannot be in the past",
    });
  }

  try {
    // check duplicates
    const existing = await sheets.spreadsheets.values.get({
      spreadsheetId: SHEET_ID,
      range: `${SHEET_NAME}!B2:B`,
    });

    const urls = (existing.data.values || []).flat();

    if (urls.includes(url)) {
      return res.status(409).json({ error: "URL already submitted" });
    }

    const id = Date.now().toString();

    await sheets.spreadsheets.values.append({
      spreadsheetId: SHEET_ID,
      range: `${SHEET_NAME}!A:E`,
      valueInputOption: "RAW",
      requestBody: {
        values: [[id, url, date, new Date().toISOString(), 0]],
      },
    });

    res.json({ success: true, id });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Sheets error" });
  }
});

// ======================
// Debug endpoint
// ======================
app.get("/admin/entries", async (req, res) => {
  try {
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId: SHEET_ID,
      range: `${SHEET_NAME}!A2:E`,
    });

    res.json(response.data.values || []);
  } catch (err) {
    console.error(err);
    res.status(500).send("Sheets error");
  }
});

// ======================
app.get("/health", (_, res) => {
  res.send("OK");
});

app.get("/test-send", async (_, res) => {
  await evaluateAndSend();
  res.send("Triggered email check");
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
