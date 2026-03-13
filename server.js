require("dotenv").config();
const express = require("express");
const sqlite3 = require("sqlite3").verbose();
const bodyParser = require("body-parser");
const TelegramBot = require("node-telegram-bot-api");
const fs = require("fs");
const csv = require("csv-parser"); // for bulk CSV uploads
const fetch = require("node-fetch"); // for Pesapal API calls

const app = express();
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// ---------------------- DATABASE ----------------------
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

// ---------------------- TELEGRAM WEBHOOK ----------------------
const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const ADMIN_CHAT_ID = process.env.ADMIN_CHAT_ID;
const bot = new TelegramBot(TELEGRAM_TOKEN);

// Set webhook URL (Render URL)
const WEBHOOK_URL = `https://${process.env.RENDER_SERVICE_NAME}.onrender.com/bot${TELEGRAM_TOKEN}`;
bot.setWebHook(WEBHOOK_URL);

// Webhook route for Telegram
app.post(`/bot${TELEGRAM_TOKEN}`, (req, res) => {
  bot.processUpdate(req.body);
  res.sendStatus(200);
});

// ---------------------- BOT COMMANDS ----------------------
bot.onText(/\/start/, (msg) => {
  if (msg.chat.id.toString() !== ADMIN_CHAT_ID) return;
  bot.sendMessage(msg.chat.id, "Support Street Kids Bot is active ✅");
});

bot.onText(/\/bulk/, async (msg) => {
  if (msg.chat.id.toString() !== ADMIN_CHAT_ID) return;

  const donors = [];
  fs.createReadStream("donors.csv")
    .pipe(csv())
    .on("data", (row) => donors.push(row))
    .on("end", async () => {
      bot.sendMessage(msg.chat.id, `Starting bulk STK push to ${donors.length} donors...`);
      for (const donor of donors) {
        await new Promise(r => setTimeout(r, 8000)); // 8 sec rate limiter
        await sendSTK(donor.phone, 100);
      }
      bot.sendMessage(msg.chat.id, "Bulk STK push completed ✅");
    });
});

// Handle single donation via phone number
bot.on("message", async (msg) => {
  if (msg.chat.id.toString() !== ADMIN_CHAT_ID) return;

  const text = msg.text;
  if (/^2547\d{8}$/.test(text)) {
    const donationId = "DONATION_" + Date.now();
    db.run(
      `INSERT INTO donations (id, phone, amount, status) VALUES (?, ?, ?, ?)`,
      [donationId, text, 100, "PENDING"],
      async (err) => {
        if (err) {
          bot.sendMessage(msg.chat.id, "Database error ❌");
        } else {
          bot.sendMessage(msg.chat.id, `Donation logged as PENDING ✅\nSending STK push...`);
          await sendSTK(text, 100);
          bot.sendMessage(msg.chat.id, `STK prompt sent for ${text} ✅`);
        }
      }
    );
  } else if (!text.startsWith("/")) {
    bot.sendMessage(msg.chat.id, "Send phone in format: 2547XXXXXXXX");
  }
});

// ---------------------- PESAPAL STK PUSH ----------------------
const PESAPAL_KEY = process.env.PESAPAL_CONSUMER_KEY;
const PESAPAL_SECRET = process.env.PESAPAL_CONSUMER_SECRET;

async function sendSTK(phone, amount) {
  try {
    // Example Pesapal STK call
    const body = {
      amount,
      phone,
      reference: "DON_" + Date.now(),
      description: "Support Street Kids Donation",
      callback_url: `https://${process.env.RENDER_SERVICE_NAME}.onrender.com/callback`
    };

    // Replace with real Pesapal endpoint and OAuth
    const res = await fetch("https://demo.pesapal.com/api/checkout/v3/hostedpay", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${PESAPAL_KEY}:${PESAPAL_SECRET}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(body)
    });

    const data = await res.json();
    console.log("Pesapal response:", data);
  } catch (err) {
    console.error("STK push error:", err);
  }
}

// ---------------------- PESAPAL CALLBACK ----------------------
app.post("/callback", (req, res) => {
  const { reference, status } = req.body;
  db.run(
    `UPDATE donations SET status = ? WHERE id = ?`,
    [status, reference],
    (err) => {
      if (err) {
        console.error("Error updating donation:", err);
        return res.sendStatus(500);
      }
      console.log(`Donation ${reference} updated to ${status}`);
      res.sendStatus(200);
    }
  );
});

// ---------------------- BASIC ROUTE ----------------------
app.get("/", (req, res) => {
  res.send("Support Street Kids Bot Running");
});

// ---------------------- START SERVER ----------------------
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
