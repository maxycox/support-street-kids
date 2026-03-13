require("dotenv").config();
const express = require("express");
const TelegramBot = require("node-telegram-bot-api");
const sqlite3 = require("sqlite3").verbose();
const fs = require("fs");
const csv = require("csv-parser");
const axios = require("axios");
const crypto = require("crypto");

// ----- ENV -----
const {
  TELEGRAM_BOT_TOKEN,
  TELEGRAM_WEBHOOK_URL,
  OWNER_ID,
  PESAPAL_CONSUMER_KEY,
  PESAPAL_CONSUMER_SECRET,
  PESAPAL_CALLBACK_URL
} = process.env;

// ----- DATABASE -----
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

// ----- EXPRESS APP -----
const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ----- TELEGRAM BOT (WEBHOOK MODE) -----
const bot = new TelegramBot(TELEGRAM_BOT_TOKEN);
bot.setWebHook(TELEGRAM_WEBHOOK_URL);

app.post(`/bot${TELEGRAM_BOT_TOKEN}`, (req, res) => {
  bot.processUpdate(req.body);
  res.sendStatus(200);
});

// ----- RATE LIMITER -----
let lastPushTime = 0;
const RATE_LIMIT_MS = 8000; // 1 push every 8 seconds
const rateLimitedPush = async (phone, amount, donationId) => {
  const now = Date.now();
  const waitTime = Math.max(0, RATE_LIMIT_MS - (now - lastPushTime));
  await new Promise(r => setTimeout(r, waitTime));
  lastPushTime = Date.now();
  return sendPesapalSTK(phone, amount, donationId);
};

// ----- PESAPAL STK PUSH -----
const PESAPAL_API_BASE = "https://demo.pesapal.com/api"; // switch to production URL when ready

const getPesapalToken = async () => {
  const url = `${PESAPAL_API_BASE}/v3/merchant/checkout/token`;
  const auth = Buffer.from(`${PESAPAL_CONSUMER_KEY}:${PESAPAL_CONSUMER_SECRET}`).toString('base64');
  const res = await axios.post(url, {}, {
    headers: {
      Authorization: `Basic ${auth}`,
      "Content-Type": "application/json"
    }
  });
  return res.data.access_token;
};

const sendPesapalSTK = async (phone, amount, donationId) => {
  try {
    const token = await getPesapalToken();
    const url = `${PESAPAL_API_BASE}/v3/merchant/checkout`;

    const payload = {
      amount: amount,
      currency: "KES",
      description: `Donation ${donationId}`,
      type: "MERCHANT",
      reference: donationId,
      phone_number: phone,
      callback_url: PESAPAL_CALLBACK_URL
    };

    const res = await axios.post(url, payload, {
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json"
      }
    });

    console.log("Pesapal STK pushed:", res.data);
    return true;
  } catch (err) {
    console.error("Pesapal STK push failed:", err.response?.data || err.message);
    return false;
  }
};

// ----- TELEGRAM HANDLER -----
bot.on("message", async (msg) => {
  if (msg.from.id.toString() !== OWNER_ID) return;
  const chatId = msg.chat.id;
  const text = msg.text;

  // BULK CSV STK
  if (text && text.toLowerCase() === "/bulk") {
    if (!fs.existsSync("donors.csv")) {
      bot.sendMessage(chatId, "donors.csv file not found ❌");
      return;
    }
    bot.sendMessage(chatId, "Starting bulk STK push...");
    fs.createReadStream("donors.csv")
      .pipe(csv())
      .on("data", async (row) => {
        const phone = row.phone;
        const amount = parseInt(row.amount || "100");
        const donationId = "DONATION_" + Date.now();
        db.run(
          `INSERT INTO donations (id, phone, amount, status) VALUES (?, ?, ?, ?)`,
          [donationId, phone, amount, "PENDING"],
          async (err) => {
            if (!err) await rateLimitedPush(phone, amount, donationId);
          }
        );
      })
      .on("end", () => {
        bot.sendMessage(chatId, "Bulk STK push completed ✅");
      });
    return;
  }

  // SINGLE DONATION
  if (text && text.startsWith("254") && text.length === 12) {
    const donationId = "DONATION_" + Date.now();
    const amount = 100; // default
    db.run(
      `INSERT INTO donations (id, phone, amount, status) VALUES (?, ?, ?, ?)`,
      [donationId, text, amount, "PENDING"],
      async (err) => {
        if (err) {
          bot.sendMessage(chatId, "Database error ❌");
        } else {
          bot.sendMessage(chatId, `Donation logged as PENDING ✅\nSending STK...`);
          await rateLimitedPush(text, amount, donationId);
          bot.sendMessage(chatId, "STK push sent 🎉");
        }
      }
    );
    return;
  }

  bot.sendMessage(chatId, "Send phone in format: 2547XXXXXXXX or use /bulk for CSV push");
});

// ----- PESAPAL CALLBACK -----
app.post("/callback", (req, res) => {
  const data = req.body;
  console.log("Pesapal callback received:", data);

  // Example: update donation status
  const donationId = data?.reference;
  const status = data?.status || "COMPLETED";
  if (donationId) {
    db.run(`UPDATE donations SET status=? WHERE id=?`, [status, donationId]);
  }

  res.sendStatus(200);
});

// ----- TEST ROUTE -----
app.get("/", (req, res) => {
  res.send("Support Street Kids Bot Running ✅");
});

// ----- START SERVER -----
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
