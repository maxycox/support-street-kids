require("dotenv").config();
const express = require("express");
const TelegramBot = require("node-telegram-bot-api");
const sqlite3 = require("sqlite3").verbose();
const fs = require("fs");
const csv = require("csv-parser");
const fetch = require("node-fetch");
const bodyParser = require("body-parser");

// =========================
// Express App
// =========================
const app = express();
app.use(bodyParser.json());
const PORT = process.env.PORT || 3000;

// =========================
// Database Setup
// =========================
const db = new sqlite3.Database("./donations.db");

db.serialize(() => {
  db.run(`
    CREATE TABLE IF NOT EXISTS donations (
      id TEXT PRIMARY KEY,
      phone TEXT,
      amount INTEGER,
      status TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);
});

// =========================
// Telegram Bot Setup (Webhook)
// =========================
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_WEBHOOK_URL = process.env.TELEGRAM_WEBHOOK_URL;
const OWNER_ID = process.env.OWNER_ID;

const bot = new TelegramBot(BOT_TOKEN);
bot.setWebHook(`${TELEGRAM_WEBHOOK_URL}`);

app.post(`/bot${BOT_TOKEN}`, (req, res) => {
  bot.processUpdate(req.body);
  res.sendStatus(200);
});

// =========================
// Rate Limiter Queue for STK
// =========================
const stkQueue = [];
let isProcessing = false;

async function processQueue() {
  if (isProcessing || stkQueue.length === 0) return;

  isProcessing = true;
  const { phone, amount, donationId } = stkQueue.shift();

  try {
    await sendPesapalSTK(phone, amount, donationId);
  } catch (err) {
    console.error("STK push error:", err);
  }

  setTimeout(() => {
    isProcessing = false;
    processQueue();
  }, 8000); // 8 seconds between each push
}

function queueSTK(phone, amount, donationId) {
  stkQueue.push({ phone, amount, donationId });
  processQueue();
}

// =========================
// Telegram Commands
// =========================
bot.on("message", async (msg) => {
  if (msg.from.id.toString() !== OWNER_ID) return;

  const text = msg.text;

  // Bulk CSV import command: /bulk <filename>
  if (text.startsWith("/bulk")) {
    const parts = text.split(" ");
    const filename = parts[1];
    if (!filename || !fs.existsSync(filename)) {
      return bot.sendMessage(msg.chat.id, "CSV file not found ❌");
    }

    const results = [];
    fs.createReadStream(filename)
      .pipe(csv())
      .on("data", (data) => results.push(data))
      .on("end", () => {
        for (const row of results) {
          const donationId = "DON_" + Date.now();
          const phone = row.phone;
          const amount = parseInt(row.amount || 100);

          db.run(
            `INSERT INTO donations (id, phone, amount, status) VALUES (?, ?, ?, ?)`,
            [donationId, phone, amount, "PENDING"],
            function (err) {
              if (err) console.error(err);
            }
          );

          // Queue STK push
          queueSTK(phone, amount, donationId);
        }
        bot.sendMessage(msg.chat.id, "Bulk donations queued ✅");
      });
    return;
  }

  // Single phone donation
  if (text && text.startsWith("254") && text.length === 12) {
    const donationId = "DON_" + Date.now();
    const amount = 100;

    db.run(
      `INSERT INTO donations (id, phone, amount, status) VALUES (?, ?, ?, ?)`,
      [donationId, text, amount, "PENDING"],
      function (err) {
        if (err) {
          bot.sendMessage(msg.chat.id, "Database error ❌");
        } else {
          bot.sendMessage(msg.chat.id, `Donation logged as PENDING ✅`);
          queueSTK(text, amount, donationId);
        }
      }
    );
  } else {
    bot.sendMessage(msg.chat.id, "Send phone in format: 2547XXXXXXXX");
  }
});

// =========================
// Pesapal STK Push
// =========================
const PESAPAL_CONSUMER_KEY = process.env.PESAPAL_CONSUMER_KEY;
const PESAPAL_CONSUMER_SECRET = process.env.PESAPAL_CONSUMER_SECRET;
const PESAPAL_CALLBACK_URL = process.env.PESAPAL_CALLBACK_URL;

async function sendPesapalSTK(phone, amount, donationId) {
  const payload = {
    amount,
    phoneNumber: phone,
    reference: donationId,
    callbackUrl: PESAPAL_CALLBACK_URL,
  };

  const response = await fetch("https://demo.pesapal.com/api/STKPush", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization:
        "Basic " +
        Buffer.from(`${PESAPAL_CONSUMER_KEY}:${PESAPAL_CONSUMER_SECRET}`).toString("base64"),
    },
    body: JSON.stringify(payload),
  });

  const data = await response.json();
  console.log("Pesapal STK response:", data);
}

// =========================
// Pesapal Callback Route
// =========================
app.post("/callback", (req, res) => {
  const { merchantReference, status } = req.body;

  if (!merchantReference) return res.sendStatus(400);

  const newStatus = status === "COMPLETED" ? "SUCCESS" : "FAILED";
  db.run(
    `UPDATE donations SET status = ? WHERE id = ?`,
    [newStatus, merchantReference],
    function (err) {
      if (err) console.error(err);
      else console.log(`Donation ${merchantReference} updated to ${newStatus}`);
    }
  );

  res.sendStatus(200);
});

// =========================
// Test Route
// =========================
app.get("/", (req, res) => {
  res.send("Support Street Kids Bot Running");
});

// =========================
// Start Server
// =========================
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`Telegram webhook URL: ${TELEGRAM_WEBHOOK_URL}`);
});
