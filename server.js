require("dotenv").config();
const express = require("express");
const TelegramBot = require("node-telegram-bot-api");
const sqlite3 = require("sqlite3").verbose();
const fs = require("fs");
const csv = require("csv-parser");
const bodyParser = require("body-parser");

// Environment variables
const {
  TELEGRAM_BOT_TOKEN,
  TELEGRAM_WEBHOOK_URL, // e.g., https://support-street-kids.onrender.com/bot<BOT_TOKEN>
  PORT = 3000,
  PESAPAL_KEY,
  PESAPAL_SECRET
} = process.env;

// Initialize SQLite database
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

// Express app
const app = express();
app.use(bodyParser.json());

// Rate limiter (1 request per 8 sec per phone)
const lastPush = {};

// Initialize Telegram bot with webhook
const bot = new TelegramBot(TELEGRAM_BOT_TOKEN);
bot.setWebHook(`${TELEGRAM_WEBHOOK_URL}`);

// Telegram webhook route
app.post(`/bot${TELEGRAM_BOT_TOKEN}`, (req, res) => {
  bot.processUpdate(req.body);
  res.sendStatus(200);
});

// Telegram command: bulk CSV STK push
bot.onText(/\/bulk/, async (msg) => {
  const chatId = msg.chat.id;
  if (!fs.existsSync("donors.csv")) {
    return bot.sendMessage(chatId, "CSV file not found.");
  }

  const results = [];
  fs.createReadStream("donors.csv")
    .pipe(csv())
    .on("data", (data) => results.push(data))
    .on("end", async () => {
      bot.sendMessage(chatId, `Processing ${results.length} donations...`);
      for (const row of results) {
        if (!row.phone) continue;
        await handleDonation(row.phone, row.amount || 100, chatId);
      }
      bot.sendMessage(chatId, "Bulk STK push completed 🎉");
    });
});

// Handle individual donation
async function handleDonation(phone, amount = 100, chatId) {
  // Rate limiting
  const now = Date.now();
  if (lastPush[phone] && now - lastPush[phone] < 8000) return;
  lastPush[phone] = now;

  const donationId = "DONATION_" + Date.now();

  db.run(
    `INSERT INTO donations (id, phone, amount, status) VALUES (?, ?, ?, ?)`,
    [donationId, phone, amount, "PENDING"],
    async (err) => {
      if (err) {
        bot.sendMessage(chatId, `DB error for ${phone}: ${err.message}`);
        return;
      }
      bot.sendMessage(chatId, `Donation logged as PENDING ✅ for ${phone}`);
      await sendSTK(phone, amount, donationId, chatId);
    }
  );
}

// Pesapal STK push
async function sendSTK(phone, amount, donationId, chatId) {
  try {
    const token = await getPesapalToken();
    if (!token) throw new Error("Failed to get Pesapal token");

    const payload = {
      amount,
      phone,
      reference: donationId
    };

    const res = await fetch("https://demo.pesapal.com/stk/push", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(payload)
    });

    const data = await res.json();

    if (data.success) {
      bot.sendMessage(chatId, `STK push sent 🎉 to ${phone}`);
      db.run(
        `UPDATE donations SET status = ? WHERE id = ?`,
        ["SENT", donationId]
      );
    } else {
      bot.sendMessage(chatId, `STK push failed ❌ for ${phone}`);
    }
  } catch (err) {
    console.error(err);
    bot.sendMessage(chatId, `STK push error for ${phone}: ${err.message}`);
  }
}

// Pesapal token generator
async function getPesapalToken() {
  try {
    const res = await fetch("https://demo.pesapal.com/oauth/token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        consumer_key: PESAPAL_KEY,
        consumer_secret: PESAPAL_SECRET,
        grant_type: "client_credentials"
      })
    });
    const data = await res.json();
    return data.access_token;
  } catch (err) {
    console.error("Pesapal token error:", err);
    return null;
  }
}

// IPN callback route
app.post("/callback", (req, res) => {
  const { reference, status } = req.body;
  if (!reference) return res.sendStatus(400);

  db.run(
    `UPDATE donations SET status = ? WHERE id = ?`,
    [status.toUpperCase(), reference],
    (err) => {
      if (err) console.error(err);
      else console.log(`Donation ${reference} updated to ${status}`);
    }
  );

  res.sendStatus(200);
});

// Health check
app.get("/", (req, res) => res.send("Support Street Kids Bot Running"));

// Start server
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
