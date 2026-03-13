require("dotenv").config();
const express = require("express");
const sqlite3 = require("sqlite3").verbose();
const TelegramBot = require("node-telegram-bot-api");
const axios = require("axios");
const fs = require("fs");
const csvParser = require("csv-parser");

const app = express();
app.use(express.json());

// ====== DATABASE SETUP ======
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

// ====== TELEGRAM BOT SETUP ======
const bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, { polling: true });
const OWNER_ID = process.env.ADMIN_CHAT_ID;

// ====== PESAPAL VARIABLES ======
let pesapalToken = null;
let ipnId = null;

// ====== FETCH PESAPAL TOKEN ======
async function getPesapalToken() {
  try {
    const response = await axios.post("https://pay.pesapal.com/v3/api/Auth/RequestToken", {
      consumer_key: process.env.PESAPAL_CONSUMER_KEY,
      consumer_secret: process.env.PESAPAL_CONSUMER_SECRET
    });
    pesapalToken = response.data.token;
    console.log("Pesapal token acquired");
    return pesapalToken;
  } catch (err) {
    console.error("Error fetching Pesapal token:", err.message);
  }
}

// ====== FETCH IPN ID ======
async function getIpnId() {
  if (!pesapalToken) await getPesapalToken();

  try {
    const response = await axios.get("https://pay.pesapal.com/v3/api/URLSetup/GetIpnList", {
      headers: { Authorization: `Bearer ${pesapalToken}`, Accept: "application/json" }
    });
    const ipns = response.data;
    if (ipns.length > 0) {
      ipnId = ipns[0].ipn_id;
      console.log("IPN ID detected:", ipnId);
    }
    return ipnId;
  } catch (err) {
    console.error("Error fetching IPN ID:", err.message);
  }
}

// ====== INITIALIZE PESAPAL ======
async function initPesapal() {
  await getPesapalToken();
  await getIpnId();
}
initPesapal();

// ====== STK PUSH FUNCTION ======
async function sendSTKPush(phone, amount = 100) {
  if (!pesapalToken || !ipnId) {
    console.log("Pesapal not initialized");
    return;
  }

  const checkoutRequest = {
    payment_type: "MERCHANT",
    amount: amount,
    currency: "KES",
    description: "Support Street Kids Donation",
    callback_url: process.env.CALLBACK_URL,
    notification_id: ipnId,
    payer: { phone_number: phone }
  };

  try {
    const response = await axios.post(
      "https://pay.pesapal.com/v3/api/Transactions/RequestPayment",
      checkoutRequest,
      { headers: { Authorization: `Bearer ${pesapalToken}`, "Content-Type": "application/json" } }
    );
    console.log("STK request sent:", phone);
  } catch (err) {
    console.error("Error sending STK:", err.message);
  }
}

// ====== TELEGRAM MESSAGE HANDLER ======
bot.on("message", async (msg) => {
  if (msg.from.id.toString() !== OWNER_ID) return;
  const text = msg.text;

  // ====== BULK STK COMMAND ======
  if (text === "/bulk") {
    if (!fs.existsSync("donors.csv")) {
      bot.sendMessage(msg.chat.id, "donors.csv not found");
      return;
    }

    fs.createReadStream("donors.csv")
      .pipe(csvParser())
      .on("data", async (row) => {
        const phone = row.phone;
        if (phone && phone.startsWith("254") && phone.length === 12) {
          const donationId = "DONATION_" + Date.now() + Math.floor(Math.random() * 1000);

          db.run(
            `INSERT INTO donations (id, phone, amount, status) VALUES (?, ?, ?, ?)`,
            [donationId, phone, 100, "PENDING"]
          );

          await sendSTKPush(phone, 100);
          await new Promise((r) => setTimeout(r, 8000)); // 1 push every 8 sec
        }
      })
      .on("end", () => {
        bot.sendMessage(msg.chat.id, "Bulk STK initiated ✅");
      });
    return;
  }

  // ====== SINGLE DONATION ======
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
          await sendSTKPush(text, 100);
        }
      }
    );
  } else {
    bot.sendMessage(msg.chat.id, "Send phone in format: 2547XXXXXXXX");
  }
});

// ====== CALLBACK ROUTE ======
app.post("/callback", (req, res) => {
  console.log("Pesapal callback received:", req.body);
  // Example: update donation status based on Pesapal response
  const { reference, status } = req.body || {};
  if (reference && status) {
    db.run(`UPDATE donations SET status = ? WHERE id = ?`, [status, reference], (err) => {
      if (err) console.error(err);
    });
  }
  res.sendStatus(200);
});

// ====== TEST ROUTE ======
app.get("/", (req, res) => res.send("Support Street Kids Bot Running"));

// ====== START SERVER ======
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
