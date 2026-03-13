require("dotenv").config();
const express = require("express");
const TelegramBot = require("node-telegram-bot-api");
const sqlite3 = require("sqlite3").verbose();
const fs = require("fs");
const csv = require("csv-parser");
const axios = require("axios");
const rateLimit = require("axios-rate-limit"); // rate limit STK pushes

// ------------------- CONFIG -------------------
const app = express();
app.use(express.json());

const PORT = process.env.PORT || 10000;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_WEBHOOK_URL = process.env.TELEGRAM_WEBHOOK_URL; // https://yourdomain.com/bot<token>
const OWNER_ID = process.env.OWNER_ID || "8257970991";

const PESAPAL_API_BASE = process.env.PESAPAL_API_BASE;
const PESAPAL_CONSUMER_KEY = process.env.PESAPAL_CONSUMER_KEY;
const PESAPAL_CONSUMER_SECRET = process.env.PESAPAL_CONSUMER_SECRET;

// ------------------- DATABASE -------------------
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

// ------------------- TELEGRAM BOT -------------------
const bot = new TelegramBot(TELEGRAM_BOT_TOKEN);
bot.setWebHook(`${TELEGRAM_WEBHOOK_URL}`);

// Handle Telegram webhook POST
app.post(`/bot${TELEGRAM_BOT_TOKEN}`, async (req, res) => {
  const msg = req.body.message || req.body.edited_message;
  if (!msg) return res.sendStatus(200);
  const chatId = msg.chat.id;
  const fromId = msg.from.id.toString();

  // Only owner can push
  if (fromId !== OWNER_ID) return res.sendStatus(200);

  const text = msg.text;

  // Bulk CSV command
  if (text && text.toLowerCase() === "/bulk") {
    if (!fs.existsSync("donors.csv")) {
      await bot.sendMessage(chatId, "donors.csv not found ❌");
      return res.sendStatus(200);
    }

    const donations = [];
    fs.createReadStream("donors.csv")
      .pipe(csv())
      .on("data", (row) => {
        donations.push({ phone: row.phone, amount: parseInt(row.amount || "100") });
      })
      .on("end", async () => {
        await bot.sendMessage(chatId, `Processing ${donations.length} donations...`);
        for (let d of donations) {
          await processSTK(d.phone, d.amount, chatId);
        }
      });

    return res.sendStatus(200);
  }

  // Single phone donation
  if (text && text.startsWith("254") && text.length === 12) {
    const donationId = "DONATION_" + Date.now();
    const amount = 100;

    db.run(
      `INSERT INTO donations (id, phone, amount, status) VALUES (?, ?, ?, ?)`,
      [donationId, text, amount, "PENDING"],
      async (err) => {
        if (err) {
          await bot.sendMessage(chatId, "Database error ❌");
          console.error(err);
        } else {
          await bot.sendMessage(chatId, "Donation logged as PENDING ✅");
          await processSTK(text, amount, chatId);
        }
      }
    );
    return res.sendStatus(200);
  }

  await bot.sendMessage(chatId, "Send phone in format: 2547XXXXXXXX or /bulk for CSV");
  return res.sendStatus(200);
});

// ------------------- RATE-LIMITED STK -------------------
const http = rateLimit(axios.create(), { maxRPS: 0.125 }); // 1 request per 8 sec

async function processSTK(phone, amount, chatId) {
  const donationId = "DONATION_" + Date.now();

  try {
    // Pesapal STK request payload
    const payload = {
      phoneNumber: phone,
      amount,
      currency: "KES",
      reference: donationId,
      callbackUrl: `${process.env.SERVER_URL}/callback`,
      description: "Support Street Kids Donation",
    };

    // STK push
    const token = await getPesapalToken();
    const response = await http.post(`${PESAPAL_API_BASE}/v1/checkout`, payload, {
      headers: { Authorization: `Bearer ${token}` },
    });

    if (response.data && response.data.status === "OK") {
      await bot.sendMessage(chatId, `STK push sent for ${phone} 🎉`);
      db.run(`UPDATE donations SET status=? WHERE phone=?`, ["SENT", phone]);
    } else {
      await bot.sendMessage(chatId, `STK push failed for ${phone} ❌`);
      console.error("Pesapal STK failed:", response.data);
      db.run(`UPDATE donations SET status=? WHERE phone=?`, ["FAILED", phone]);
    }
  } catch (err) {
    await bot.sendMessage(chatId, `STK push error for ${phone} ❌`);
    console.error("Pesapal STK request error:", err.message);
    db.run(`UPDATE donations SET status=? WHERE phone=?`, ["FAILED", phone]);
  }
}

// ------------------- GET PESAPAL TOKEN -------------------
async function getPesapalToken() {
  // Implement OAuth flow here
  // For example, Base64 encode key:secret, request token
  const auth = Buffer.from(`${PESAPAL_CONSUMER_KEY}:${PESAPAL_CONSUMER_SECRET}`).toString("base64");
  const res = await axios.post(`${PESAPAL_API_BASE}/oauth/token`, null, {
    headers: {
      Authorization: `Basic ${auth}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
  });
  return res.data.access_token;
}

// ------------------- PESAPAL CALLBACK -------------------
app.post("/callback", (req, res) => {
  const { reference, status } = req.body;
  db.run(`UPDATE donations SET status=? WHERE id=?`, [status, reference], (err) => {
    if (err) console.error(err);
  });
  res.sendStatus(200);
});

// ------------------- TEST ROUTE -------------------
app.get("/", (req, res) => res.send("Support Street Kids Bot Running"));

// ------------------- START SERVER -------------------
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
