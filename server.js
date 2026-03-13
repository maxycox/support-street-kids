require("dotenv").config();
const express = require("express");
const TelegramBot = require("node-telegram-bot-api");
const sqlite3 = require("sqlite3").verbose();
const fs = require("fs");
const csv = require("csv-parser");
const fetch = require("node-fetch");
const rateLimit = require("axios-rate-limit");
const axios = require("axios");

// ---- CONFIG ----
const PORT = process.env.PORT || 10000;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_WEBHOOK_URL = process.env.TELEGRAM_WEBHOOK_URL;
const OWNER_ID = process.env.OWNER_ID || "8257970991"; // your Telegram ID
const PESAPAL_CONSUMER_KEY = process.env.PESAPAL_CONSUMER_KEY;
const PESAPAL_CONSUMER_SECRET = process.env.PESAPAL_CONSUMER_SECRET;

// ---- DATABASE ----
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

// ---- EXPRESS ----
const app = express();
app.use(express.json());

// ---- TELEGRAM BOT ----
const bot = new TelegramBot(TELEGRAM_BOT_TOKEN);
bot.setWebHook(`${TELEGRAM_WEBHOOK_URL}`);

// Webhook endpoint
app.post(`/bot${TELEGRAM_BOT_TOKEN}`, (req, res) => {
  bot.processUpdate(req.body);
  res.sendStatus(200);
});

// ---- RATE LIMITER FOR PESAPAL ----
const http = rateLimit(axios.create(), { maxRequests: 1, perMilliseconds: 1000 });

// ---- PESAPAL STK FUNCTIONS ----
async function getPesapalToken() {
  try {
    const url = "https://demo.pesapal.com/api/token"; // demo; replace with live URL
    const response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Basic ${Buffer.from(
          `${PESAPAL_CONSUMER_KEY}:${PESAPAL_CONSUMER_SECRET}`
        ).toString("base64")}`,
      },
    });
    const data = await response.json();
    return data.access_token;
  } catch (err) {
    console.error("Failed to get Pesapal token:", err);
    return null;
  }
}

async function sendSTK(phone, amount, donationId) {
  try {
    const token = await getPesapalToken();
    if (!token) throw new Error("No Pesapal token");

    // Demo STK push request structure
    const response = await http.post(
      "https://demo.pesapal.com/api/stkpush",
      {
        amount,
        phone,
        reference: donationId,
      },
      { headers: { Authorization: `Bearer ${token}` } }
    );

    console.log("STK push sent:", response.data);
    return true;
  } catch (err) {
    console.error("Pesapal STK push failed:", err.message);
    return false;
  }
}

// ---- TELEGRAM HANDLER ----
bot.on("message", async (msg) => {
  if (msg.from.id.toString() !== OWNER_ID) return;
  const text = msg.text;

  // BULK CSV STK: /bulk command
  if (text.startsWith("/bulk")) {
    if (!fs.existsSync("donors.csv")) {
      return bot.sendMessage(msg.chat.id, "CSV file not found.");
    }

    let count = 0;
    fs.createReadStream("donors.csv")
      .pipe(csv())
      .on("data", async (row) => {
        const phone = row.phone;
        const donationId = "DONATION_" + Date.now() + "_" + count;
        db.run(
          `INSERT INTO donations (id, phone, amount, status) VALUES (?, ?, ?, ?)`,
          [donationId, phone, parseInt(row.amount), "PENDING"]
        );
        const sent = await sendSTK(phone, parseInt(row.amount), donationId);
        if (sent) count++;
      })
      .on("end", () => {
        bot.sendMessage(msg.chat.id, `Bulk STK process completed. ${count} sent.`);
      });

    return;
  }

  // Individual donation: send phone
  if (text && text.startsWith("254") && text.length === 12) {
    const donationId = "DONATION_" + Date.now();
    db.run(
      `INSERT INTO donations (id, phone, amount, status) VALUES (?, ?, ?, ?)`,
      [donationId, text, 100, "PENDING"],
      async function (err) {
        if (err) {
          bot.sendMessage(msg.chat.id, "Database error ❌");
          console.error(err);
        } else {
          bot.sendMessage(msg.chat.id, "Donation logged as PENDING ✅");
          const sent = await sendSTK(text, 100, donationId);
          if (sent) bot.sendMessage(msg.chat.id, "STK push sent 🎉");
          else bot.sendMessage(msg.chat.id, "STK push failed ❌ Check server logs");
        }
      }
    );
    return;
  }

  bot.sendMessage(msg.chat.id, "Send phone in format: 2547XXXXXXXX or use /bulk for CSV");
});

// ---- PESAPAL CALLBACK ----
app.post("/callback", (req, res) => {
  console.log("Pesapal callback received:", req.body);
  // Here you should verify the signature and update donation status in DB
  res.sendStatus(200);
});

// ---- TEST ROUTE ----
app.get("/", (req, res) => {
  res.send("Support Street Kids Bot Running");
});

// ---- START SERVER ----
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
