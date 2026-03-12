require("dotenv").config();

const express = require("express");
const TelegramBot = require("node-telegram-bot-api");
const sqlite3 = require("sqlite3").verbose();
const axios = require("axios");

const app = express();
app.use(express.json());

// DATABASE
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

// TELEGRAM BOT
const bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, {
  polling: true,
});

const OWNER_ID = "8257970991";

// BASIC ROUTE
app.get("/", (req, res) => {
  res.send("Support Street Kids Bot Running");
});

// PESAPAL TOKEN
async function getPesapalToken() {
  const token = Buffer.from(
    process.env.PESAPAL_CONSUMER_KEY +
      ":" +
      process.env.PESAPAL_CONSUMER_SECRET
  ).toString("base64");

  const res = await axios.post(
    "https://www.pesapal.com/api/v3/oauth/token",
    {},
    {
      headers: {
        Authorization: `Basic ${token}`,
      },
    }
  );

  return res.data.access_token;
}

// STK PUSH
async function triggerSTK(phone, donationId) {
  const token = await getPesapalToken();

  const order = {
    amount: 100,
    currency: "KES",
    description: "Support Street Kids",
    type: "MERCHANT",
    reference: donationId,
    phonenumber: phone,
    callback_url: process.env.BASE_URL + "/callback",
  };

  await axios.post(
    "https://www.pesapal.com/api/v3/transactions",
    order,
    {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    }
  );
}

// TELEGRAM HANDLER
bot.on("message", (msg) => {
  if (msg.from.id.toString() !== OWNER_ID) return;

  const phone = msg.text;

  if (phone && phone.startsWith("254") && phone.length === 12) {
    const id = "DONATION_" + Date.now();

    db.run(
      `INSERT INTO donations (id, phone, amount, status)
       VALUES (?, ?, ?, ?)`,
      [id, phone, 100, "PENDING"],
      async function (err) {
        if (err) {
          bot.sendMessage(msg.chat.id, "Database error");
        } else {
          bot.sendMessage(msg.chat.id, "Sending STK prompt...");

          try {
            await triggerSTK(phone, id);
            bot.sendMessage(msg.chat.id, "STK sent");
          } catch (e) {
            bot.sendMessage(msg.chat.id, "STK failed");
          }
        }
      }
    );
  } else {
    bot.sendMessage(msg.chat.id, "Send number like 2547XXXXXXXX");
  }
});

// CALLBACK
app.post("/callback", (req, res) => {
  const { reference, status } = req.body;

  db.run(
    `UPDATE donations SET status=? WHERE id=?`,
    [status, reference]
  );

  res.sendStatus(200);
});

// START SERVER
const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log("Server running on port " + PORT);
});