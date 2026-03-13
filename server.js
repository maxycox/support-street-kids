require("dotenv").config();
const express = require("express");
const TelegramBot = require("node-telegram-bot-api");
const sqlite3 = require("sqlite3").verbose();
const fs = require("fs");
const csv = require("csv-parser");
const fetch = require("node-fetch");

// ----- CONFIG -----
const PORT = process.env.PORT || 10000;
const OWNER_ID = process.env.OWNER_ID; // Telegram numeric ID
const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_WEBHOOK_URL = process.env.TELEGRAM_WEBHOOK_URL;
const PESAPAL_KEY = process.env.PESAPAL_KEY;
const PESAPAL_SECRET = process.env.PESAPAL_SECRET;

// ----- DATABASE -----
const db = new sqlite3.Database("./donations.db");
db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS donations (
    id TEXT PRIMARY KEY,
    phone TEXT,
    amount INTEGER,
    status TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);
});

// ----- EXPRESS SERVER -----
const app = express();
app.use(express.json());

// ----- RATE LIMITER -----
let lastPushTime = 0;
function canSendSTK() {
  const now = Date.now();
  if (now - lastPushTime >= 8000) { // 8s
    lastPushTime = now;
    return true;
  }
  return false;
}

// ----- PESAPAL TOKEN -----
async function getPesapalToken() {
  try {
    const res = await fetch("https://demo.pesapal.com/oauth/token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        consumer_key: PESAPAL_KEY,
        consumer_secret: PESAPAL_SECRET,
        grant_type: "client_credentials",
      }),
    });
    const data = await res.json();
    console.log("Pesapal token acquired");
    return data.access_token;
  } catch (err) {
    console.error("Failed to get Pesapal token:", err);
    return null;
  }
}

// ----- STK PUSH FUNCTION -----
async function sendSTK(phone, amount = 100, chatId = null) {
  if (!canSendSTK()) {
    if (chatId) bot.sendMessage(chatId, "Rate limit: wait 8s before next STK 🔄");
    return;
  }

  const token = await getPesapalToken();
  if (!token) {
    if (chatId) bot.sendMessage(chatId, "Pesapal token fetch failed ❌");
    return;
  }

  try {
    const res = await fetch("https://demo.pesapal.com/stkpush", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        phone,
        amount,
        description: "Donation to Street Kids",
      }),
    });
    const data = await res.json();
    if (chatId) bot.sendMessage(chatId, "STK push sent 🎉");
    console.log("STK Response:", data);
  } catch (err) {
    console.error("Pesapal STK push failed:", err);
    if (chatId) bot.sendMessage(chatId, "Pesapal STK push failed ❌");
  }
}

// ----- TELEGRAM WEBHOOK BOT -----
const bot = new TelegramBot(TELEGRAM_TOKEN);
bot.setWebHook(TELEGRAM_WEBHOOK_URL);

app.post(`/bot${TELEGRAM_TOKEN}`, async (req, res) => {
  const msg = req.body.message;
  if (!msg) return res.sendStatus(200);
  const chatId = msg.chat.id;

  if (msg.from.id.toString() !== OWNER_ID) return res.sendStatus(200);

  const text = msg.text;
  if (text.startsWith("254") && text.length === 12) {
    const donationId = "DONATION_" + Date.now();
    db.run(
      `INSERT INTO donations (id, phone, amount, status) VALUES (?, ?, ?, ?)`,
      [donationId, text, 100, "PENDING"],
      function(err) {
        if (err) {
          bot.sendMessage(chatId, "Database error ❌");
          console.error(err);
        } else {
          bot.sendMessage(chatId, "Donation logged as PENDING ✅");
          sendSTK(text, 100, chatId);
        }
      }
    );
  } else if (text.toLowerCase() === "/bulk") {
    bot.sendMessage(chatId, "Processing CSV for bulk STK...");
    fs.createReadStream("donors.csv")
      .pipe(csv())
      .on("data", row => {
        if (row.phone) sendSTK(row.phone, row.amount || 100);
      })
      .on("end", () => {
        bot.sendMessage(chatId, "Bulk STK push completed 🎉");
      });
  } else {
    bot.sendMessage(chatId, "Send phone in format: 2547XXXXXXXX or use /bulk");
  }

  res.sendStatus(200);
});

// ----- IPN CALLBACK -----
app.post("/callback", (req, res) => {
  console.log("Pesapal IPN Callback:", req.body);
  // Here you can update donation status in DB based on IPN
  res.sendStatus(200);
});

// ----- BASIC ROUTE -----
app.get("/", (req, res) => {
  res.send("Support Street Kids Bot Running ✅");
});

// ----- START SERVER -----
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
