// server.js
require("dotenv").config();
const express = require("express");
const sqlite3 = require("sqlite3").verbose();
const TelegramBot = require("node-telegram-bot-api");
const axios = require("axios");
const fs = require("fs");
const csv = require("csv-parser");

// --- DATABASE ---
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

// --- EXPRESS ---
const app = express();
app.use(express.json());

// --- TELEGRAM BOT ---
const bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, { polling: true });
const OWNER_ID = process.env.OWNER_ID || "8257970991";

// --- PESAPAL HELPER FUNCTIONS ---
async function getPesapalAccessToken() {
  const key = process.env.PESAPAL_CONSUMER_KEY;
  const secret = process.env.PESAPAL_CONSUMER_SECRET;

  const token = Buffer.from(`${key}:${secret}`).toString("base64");

  const response = await axios.post(
    "https://sandbox.pesapal.com/api/v3/oauth/token", // change to live for production
    "grant_type=client_credentials",
    {
      headers: {
        Authorization: `Basic ${token}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
    }
  );

  return response.data.access_token;
}

async function sendPesapalSTK({ accessToken, amount, phone, reference }) {
  const callbackUrl = process.env.PESAPAL_CALLBACK_URL;

  const data = {
    amount: amount,
    currency: "KES",
    description: "Support Street Kids",
    type: "MERCHANT",
    reference: reference,
    phone_number: phone,
    callback_url: callbackUrl,
  };

  const response = await axios.post(
    "https://sandbox.pesapal.com/api/v3/transactions/initialize", // live for production
    data,
    {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
    }
  );

  return response.data;
}

// --- TELEGRAM BOT HANDLER ---
bot.on("message", async (msg) => {
  if (msg.from.id.toString() !== OWNER_ID) return;

  const text = msg.text;

  // Single phone donation
  if (text && text.startsWith("254") && text.length === 12) {
    const donationId = "DON_" + Date.now();

    db.run(
      `INSERT INTO donations (id, phone, amount, status)
       VALUES (?, ?, ?, ?)`,
      [donationId, text, 100, "PENDING"],
      async function(err) {
        if (err) {
          bot.sendMessage(msg.chat.id, "Database error ❌");
          console.error(err);
        } else {
          bot.sendMessage(msg.chat.id, "Donation logged as PENDING ✅");

          // --- Send STK push ---
          try {
            const accessToken = await getPesapalAccessToken();
            const stkResponse = await sendPesapalSTK({
              accessToken,
              amount: 100,
              phone: text,
              reference: donationId,
            });

            console.log("Pesapal STK Response:", stkResponse);
            bot.sendMessage(msg.chat.id, `STK prompt sent to ${text} ✅`);
          } catch (err) {
            console.error("Pesapal STK Error:", err.response?.data || err.message);
            bot.sendMessage(msg.chat.id, "Error sending STK. Check server logs ❌");
          }
        }
      }
    );

  } else if (text === "/bulk") {
    bot.sendMessage(msg.chat.id, "Starting bulk STK...");
    sendBulkSTK(msg.chat.id);
  } else {
    bot.sendMessage(msg.chat.id, "Send phone in format: 2547XXXXXXXX");
  }
});

// --- BULK STK FUNCTION ---
function sendBulkSTK(chatId) {
  const numbers = [];
  fs.createReadStream("donors.csv")
    .pipe(csv())
    .on("data", (row) => {
      numbers.push(row.phone);
    })
    .on("end", async () => {
      bot.sendMessage(chatId, `Loaded ${numbers.length} donors`);

      let index = 0;
      const interval = setInterval(async () => {
        if (index >= numbers.length) {
          clearInterval(interval);
          bot.sendMessage(chatId, "Bulk STK completed ✅");
          return;
        }

        const phone = numbers[index];
        const donationId = "DON_" + Date.now();

        db.run(
          `INSERT INTO donations (id, phone, amount, status)
          VALUES (?, ?, ?, ?)`,
          [donationId, phone, 100, "PENDING"]
        );

        console.log("Sending STK to:", phone);

        try {
          const accessToken = await getPesapalAccessToken();
          await sendPesapalSTK({
            accessToken,
            amount: 100,
            phone,
            reference: donationId,
          });
        } catch (err) {
          console.error("Pesapal bulk error:", err.response?.data || err.message);
        }

        index++;
      }, 8000); // 1 push every 8 seconds
    });
}

// --- DONATION LINK ROUTE ---
app.get("/pay/:phone", async (req, res) => {
  const phone = req.params.phone;

  if (!phone.startsWith("254") || phone.length !== 12) {
    return res.send("Invalid phone number format");
  }

  const donationId = "DON_" + Date.now();

  db.run(
    `INSERT INTO donations (id, phone, amount, status)
     VALUES (?, ?, ?, ?)`,
    [donationId, phone, 100, "PENDING"]
  );

  try {
    const accessToken = await getPesapalAccessToken();
    const stkResponse = await sendPesapalSTK({
      accessToken,
      amount: 100,
      phone,
      reference: donationId,
    });

    console.log("Pesapal STK Response:", stkResponse);

    res.send(`STK prompt sent to ${phone}`);
  } catch (err) {
    console.error("Pesapal STK Error:", err.response?.data || err.message);
    res.send("Error sending STK. Check server logs.");
  }
});

// --- CALLBACK ROUTE ---
app.post("/callback", (req, res) => {
  const { reference, status } = req.body;

  db.run(
    `UPDATE donations SET status = ? WHERE id = ?`,
    [status, reference]
  );

  res.sendStatus(200);
});

// --- BASIC TEST ROUTE ---
app.get("/", (req, res) => {
  res.send("Support Street Kids Bot Running");
});

// --- SERVER ---
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
