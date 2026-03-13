require("dotenv").config();
const express = require("express");
const TelegramBot = require("node-telegram-bot-api");
const sqlite3 = require("sqlite3").verbose();
const fs = require("fs");
const csv = require("csv-parser");
const fetch = require("node-fetch");
const rateLimit = require("axios-rate-limit");
const axios = require("axios");
const crypto = require("crypto");

// ---- ENVIRONMENT VALIDATION ----
const requiredEnvVars = [
  'TELEGRAM_BOT_TOKEN',
  'TELEGRAM_WEBHOOK_URL',
  'PESAPAL_CONSUMER_KEY',
  'PESAPAL_CONSUMER_SECRET'
];

requiredEnvVars.forEach(varName => {
  if (!process.env[varName]) {
    console.error(`❌ Missing required environment variable: ${varName}`);
    process.exit(1);
  }
});

// ---- CONFIG ----
const PORT = process.env.PORT || 10000;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_WEBHOOK_URL = process.env.TELEGRAM_WEBHOOK_URL;
const OWNER_ID = process.env.OWNER_ID || "8257970991";
const PESAPAL_CONSUMER_KEY = process.env.PESAPAL_CONSUMER_KEY;
const PESAPAL_CONSUMER_SECRET = process.env.PESAPAL_CONSUMER_SECRET;
const PESAPAL_ENV = process.env.PESAPAL_ENV || "demo"; // 'demo' or 'live'
const PESAPAL_BASE_URL = PESAPAL_ENV === 'live' 
  ? "https://pay.pesapal.com/v3" 
  : "https://demo.pesapal.com/v3";
const MAX_AMOUNT = 150000; // Maximum donation amount in KES
const BATCH_SIZE = 5; // Process 5 donations at a time

// ---- LOGGER ----
const logger = {
  info: (...args) => console.log(`[INFO] ${new Date().toISOString()} -`, ...args),
  error: (...args) => console.error(`[ERROR] ${new Date().toISOString()} -`, ...args),
  warn: (...args) => console.warn(`[WARN] ${new Date().toISOString()} -`, ...args)
};

// ---- DATABASE ----
const db = new sqlite3.Database("./donations.db", (err) => {
  if (err) {
    logger.error("Database connection failed:", err);
    process.exit(1);
  }
  logger.info("Connected to SQLite database");
});

db.serialize(() => {
  db.run(`
    CREATE TABLE IF NOT EXISTS donations (
      id TEXT PRIMARY KEY,
      phone TEXT NOT NULL,
      amount INTEGER NOT NULL,
      status TEXT DEFAULT 'PENDING',
      pesapal_transaction_id TEXT,
      pesapal_reference TEXT,
      error_message TEXT,
      retry_count INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);
  
  db.run(`CREATE INDEX IF NOT EXISTS idx_phone ON donations(phone)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_status ON donations(status)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_created_at ON donations(created_at)`);
  
  logger.info("Database schema initialized");
});

// ---- HELPER FUNCTIONS ----
const validatePhone = (phone) => {
  const phoneRegex = /^254[0-9]{9}$/;
  return phoneRegex.test(phone);
};

const validateAmount = (amount) => {
  const num = parseInt(amount);
  return !isNaN(num) && num > 0 && num <= MAX_AMOUNT;
};

const generateDonationId = () => {
  return `DON_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
};

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// ---- EXPRESS ----
const app = express();
app.use(express.json());

// ---- TELEGRAM BOT ----
const bot = new TelegramBot(TELEGRAM_BOT_TOKEN);
bot.setWebHook(`${TELEGRAM_WEBHOOK_URL}/bot${TELEGRAM_BOT_TOKEN}`);

// ---- RATE LIMITER FOR PESAPAL ----
const http = rateLimit(axios.create(), { 
  maxRequests: 1, 
  perMilliseconds: 1500 // 1.5 seconds between requests
});

// ---- PESAPAL FUNCTIONS ----
async function getPesapalToken() {
  try {
    const url = `${PESAPAL_BASE_URL}/api/token`;
    const auth = Buffer.from(`${PESAPAL_CONSUMER_KEY}:${PESAPAL_CONSUMER_SECRET}`).toString("base64");
    
    const response = await fetch(url, {
      method: "POST",
      headers: {
        'Authorization': `Basic ${auth}`,
        'Content-Type': 'application/json',
        'Accept': 'application/json'
      },
      body: JSON.stringify({
        grant_type: 'client_credentials'
      })
    });

    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }

    const data = await response.json();
    logger.info("Successfully obtained Pesapal token");
    return data.access_token;
  } catch (err) {
    logger.error("Failed to get Pesapal token:", err.message);
    return null;
  }
}

async function sendSTK(phone, amount, donationId, retryCount = 0) {
  try {
    const token = await getPesapalToken();
    if (!token) throw new Error("No Pesapal token available");

    const payload = {
      amount: amount,
      phone_number: phone,
      reference: donationId,
      description: "Support Street Kids Donation",
      callback_url: `${TELEGRAM_WEBHOOK_URL}/callback`,
      currency: "KES"
    };

    logger.info(`Sending STK push for donation ${donationId}:`, payload);

    const response = await http.post(
      `${PESAPAL_BASE_URL}/api/stkpush`,
      payload,
      { 
        headers: { 
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json'
        },
        timeout: 30000 // 30 second timeout
      }
    );

    logger.info(`STK push successful for ${donationId}:`, response.data);
    
    // Update database with Pesapal reference
    if (response.data.transaction_id) {
      await new Promise((resolve, reject) => {
        db.run(
          `UPDATE donations SET pesapal_transaction_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
          [response.data.transaction_id, donationId],
          (err) => err ? reject(err) : resolve()
        );
      });
    }
    
    return { success: true, data: response.data };
  } catch (err) {
    logger.error(`STK push failed for ${donationId} (attempt ${retryCount + 1}):`, err.message);
    
    // Update error message in database
    await new Promise((resolve) => {
      db.run(
        `UPDATE donations SET error_message = ?, retry_count = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
        [err.message, retryCount + 1, donationId],
        () => resolve()
      );
    });
    
    return { success: false, error: err.message };
  }
}

async function sendSTKWithRetry(phone, amount, donationId, maxRetries = 3) {
  for (let i = 0; i < maxRetries; i++) {
    try {
      const result = await sendSTK(phone, amount, donationId, i);
      if (result.success) {
        return result;
      }
      
      if (i < maxRetries - 1) {
        const waitTime = 2000 * (i + 1); // Exponential backoff
        logger.info(`Retrying ${donationId} in ${waitTime}ms (attempt ${i + 2}/${maxRetries})`);
        await sleep(waitTime);
      }
    } catch (err) {
      logger.error(`Unexpected error in retry logic for ${donationId}:`, err);
    }
  }
  
  return { success: false, error: "Max retries exceeded" };
}

// ---- TELEGRAM HANDLER ----
bot.on("message", async (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id.toString();
  const text = msg.text;

  // Verify owner
  if (userId !== OWNER_ID) {
    logger.warn(`Unauthorized access attempt from user ${userId}`);
    return bot.sendMessage(chatId, "⛔ Unauthorized. This bot is private.");
  }

  try {
    // Help command
    if (text === "/start" || text === "/help") {
      const helpMessage = `
🤖 *Support Street Kids Donation Bot*

*Commands:*
• Send phone number (2547XXXXXXXX) - Process single KES 100 donation
• /bulk [batch_size] - Process donations from donors.csv
• /stats - View donation statistics
• /retry [donation_id] - Retry failed donation
• /health - Check system status

*Examples:*
\`/bulk 5\` - Process 5 donations at a time
\`/retry DON_123456\` - Retry specific donation

*CSV Format:* phone,amount
      `;
      return bot.sendMessage(chatId, helpMessage, { parse_mode: 'Markdown' });
    }

    // Stats command
    if (text === "/stats") {
      db.get(`
        SELECT 
          COUNT(*) as total,
          SUM(CASE WHEN status = 'COMPLETED' THEN 1 ELSE 0 END) as completed,
          SUM(CASE WHEN status = 'PENDING' THEN 1 ELSE 0 END) as pending,
          SUM(CASE WHEN status = 'FAILED' THEN 1 ELSE 0 END) as failed,
          SUM(CASE WHEN status = 'COMPLETED' THEN amount ELSE 0 END) as total_amount
        FROM donations
      `, (err, row) => {
        if (err) {
          logger.error("Stats query error:", err);
          return bot.sendMessage(chatId, "❌ Failed to fetch statistics");
        }
        
        const stats = `
📊 *Donation Statistics*
Total: ${row.total || 0}
✅ Completed: ${row.completed || 0}
⏳ Pending: ${row.pending || 0}
❌ Failed: ${row.failed || 0}
💰 Total Amount: KES ${row.total_amount || 0}
        `;
        
        bot.sendMessage(chatId, stats, { parse_mode: 'Markdown' });
      });
      return;
    }

    // Health command
    if (text === "/health") {
      const health = await checkHealth();
      const status = health.database && health.pesapal ? "✅" : "⚠️";
      bot.sendMessage(chatId, 
        `${status} *System Health*\n` +
        `• Database: ${health.database ? '✅' : '❌'}\n` +
        `• Pesapal: ${health.pesapal ? '✅' : '❌'}\n` +
        `• Uptime: ${Math.floor(health.uptime / 60)} minutes\n` +
        `• Memory: ${health.memory}\n` +
        `• Batch Size: ${BATCH_SIZE}`,
        { parse_mode: 'Markdown' }
      );
      return;
    }

    // Retry command
    if (text.startsWith("/retry")) {
      const args = text.split(' ');
      if (args.length < 2) {
        return bot.sendMessage(chatId, "❌ Please provide donation ID: /retry DON_123456");
      }
      
      const donationId = args[1];
      
      db.get("SELECT * FROM donations WHERE id = ?", [donationId], async (err, row) => {
        if (err || !row) {
          return bot.sendMessage(chatId, "❌ Donation not found");
        }
        
        if (row.status === 'COMPLETED') {
          return bot.sendMessage(chatId, "✅ Donation already completed");
        }
        
        bot.sendMessage(chatId, `🔄 Retrying donation ${donationId}...`);
        
        const result = await sendSTKWithRetry(row.phone, row.amount, donationId);
        
        if (result.success) {
          bot.sendMessage(chatId, `✅ STK push resent successfully for ${donationId}`);
        } else {
          bot.sendMessage(chatId, `❌ Failed to resend STK: ${result.error}`);
        }
      });
      return;
    }

    // Bulk CSV processing
    if (text.startsWith("/bulk")) {
      const args = text.split(' ');
      const customBatchSize = args[1] ? parseInt(args[1]) : BATCH_SIZE;
      
      if (!fs.existsSync("donors.csv")) {
        return bot.sendMessage(chatId, "❌ donors.csv file not found. Please upload the file first.");
      }

      // Read and validate CSV
      const results = [];
      let invalidRows = [];

      fs.createReadStream("donors.csv")
        .pipe(csv())
        .on("data", (row) => {
          const phone = row.phone?.trim();
          const amount = parseInt(row.amount);
          
          if (!validatePhone(phone)) {
            invalidRows.push({ row, reason: "Invalid phone number" });
          } else if (!validateAmount(amount)) {
            invalidRows.push({ row, reason: `Amount must be between 1 and ${MAX_AMOUNT}` });
          } else {
            results.push({ phone, amount });
          }
        })
        .on("end", async () => {
          if (results.length === 0) {
            return bot.sendMessage(chatId, "❌ No valid donations found in CSV");
          }

          const statusMsg = await bot.sendMessage(chatId, 
            `📊 Processing ${results.length} donations in batches of ${customBatchSize}\n` +
            `⚠️ Invalid rows: ${invalidRows.length}\n\n` +
            `Progress: 0/${results.length}`
          );

          let successCount = 0;
          let failCount = 0;

          // Process in batches
          for (let i = 0; i < results.length; i += customBatchSize) {
            const batch = results.slice(i, i + customBatchSize);
            const batchPromises = batch.map(async (row) => {
              try {
                const donationId = generateDonationId();
                
                // Insert into database
                await new Promise((resolve, reject) => {
                  db.run(
                    `INSERT INTO donations (id, phone, amount, status) VALUES (?, ?, ?, ?)`,
                    [donationId, row.phone, row.amount, "PENDING"],
                    (err) => err ? reject(err) : resolve()
                  );
                });
                
                // Send STK push
                const result = await sendSTKWithRetry(row.phone, row.amount, donationId);
                
                if (result.success) {
                  successCount++;
                  return { success: true, donationId };
                } else {
                  // Update status to FAILED
                  await new Promise((resolve) => {
                    db.run(
                      `UPDATE donations SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
                      ["FAILED", donationId],
                      () => resolve()
                    );
                  });
                  failCount++;
                  return { success: false, donationId, error: result.error };
                }
              } catch (err) {
                logger.error("Batch processing error:", err);
                failCount++;
                return { success: false, error: err.message };
              }
            });

            const batchResults = await Promise.all(batchPromises);
            
            // Update progress
            await bot.editMessageText(
              `📊 Processing ${results.length} donations in batches of ${customBatchSize}\n` +
              `⚠️ Invalid rows: ${invalidRows.length}\n\n` +
              `Progress: ${Math.min(i + customBatchSize, results.length)}/${results.length}\n` +
              `✅ Success: ${successCount}\n` +
              `❌ Failed: ${failCount}`,
              {
                chat_id: chatId,
                message_id: statusMsg.message_id
              }
            );

            // Small delay between batches
            if (i + customBatchSize < results.length) {
              await sleep(2000);
            }
          }

          // Final summary
          const summary = `
✅ *Bulk Processing Complete!*

📊 *Summary:*
• Total processed: ${results.length}
• ✅ Successful: ${successCount}
• ❌ Failed: ${failCount}
• ⚠️ Invalid rows skipped: ${invalidRows.length}

${invalidRows.length > 0 ? '\n*Invalid Rows:*\n' + invalidRows.map(r => `• ${JSON.stringify(r.row)} - ${r.reason}`).join('\n') : ''}
          `;

          bot.sendMessage(chatId, summary, { parse_mode: 'Markdown' });
        });
      
      return;
    }

    // Single donation (phone number)
    if (text && text.startsWith("254") && text.length === 12) {
      if (!validatePhone(text)) {
        return bot.sendMessage(chatId, "❌ Invalid phone format. Use: 2547XXXXXXXX");
      }

      const donationId = generateDonationId();
      const amount = 100; // Default amount

      bot.sendMessage(chatId, `🔄 Processing donation for ${text}...`);

      db.run(
        `INSERT INTO donations (id, phone, amount, status) VALUES (?, ?, ?, ?)`,
        [donationId, text, amount, "PENDING"],
        async function (err) {
          if (err) {
            logger.error("Database error:", err);
            return bot.sendMessage(chatId, "❌ Failed to log donation");
          }

          bot.sendMessage(chatId, `📝 Donation logged: ${donationId}`);
          
          const result = await sendSTKWithRetry(text, amount, donationId);
          
          if (result.success) {
            bot.sendMessage(chatId, 
              `✅ STK push sent successfully!\n` +
              `📱 Phone: ${text}\n` +
              `💰 Amount: KES ${amount}\n` +
              `🆔 Transaction: ${result.data?.transaction_id || 'N/A'}`
            );
          } else {
            bot.sendMessage(chatId, 
              `❌ STK push failed.\n` +
              `Error: ${result.error}\n` +
              `You can retry with: /retry ${donationId}`
            );
          }
        }
      );
      return;
    }

    // Unknown command
    bot.sendMessage(chatId, "❌ Unknown command. Type /help for available commands.");

  } catch (err) {
    logger.error("Message handler error:", err);
    bot.sendMessage(chatId, "❌ An error occurred processing your request");
  }
});

// ---- PESAPAL CALLBACK ----
app.post("/callback", (req, res) => {
  try {
    const {
      pesapal_transaction_tracking_id,
      pesapal_merchant_reference,
      status,
      payment_status_description,
      amount,
      currency,
      payment_method
    } = req.body;

    logger.info("Pesapal callback received:", req.body);

    // Verify signature (implement based on Pesapal documentation)
    // const isValid = verifyPesapalSignature(req.body);
    // if (!isValid) {
    //   logger.warn("Invalid signature in callback");
    //   return res.status(400).send('Invalid signature');
    // }

    const donationStatus = status === 'COMPLETED' || status === 'SUCCESS' ? 'COMPLETED' : 'FAILED';

    db.run(
      `UPDATE donations 
       SET status = ?, 
           pesapal_transaction_id = ?,
           pesapal_reference = ?,
           updated_at = CURRENT_TIMESTAMP 
       WHERE id = ?`,
      [donationStatus, pesapal_transaction_tracking_id, pesapal_merchant_reference, pesapal_merchant_reference],
      (err) => {
        if (err) {
          logger.error("Failed to update donation status from callback:", err);
          return res.status(500).send('Database error');
        }

        // Notify owner
        const message = donationStatus === 'COMPLETED' 
          ? `✅ Payment completed for donation ${pesapal_merchant_reference}\n` +
            `💰 Amount: ${currency} ${amount}\n` +
            `🆔 Transaction: ${pesapal_transaction_tracking_id}`
          : `❌ Payment failed for donation ${pesapal_merchant_reference}\n` +
            `Reason: ${payment_status_description || 'Unknown'}`;

        bot.sendMessage(OWNER_ID, message).catch(e => 
          logger.error("Failed to send notification:", e)
        );

        res.sendStatus(200);
      }
    );
  } catch (err) {
    logger.error("Callback processing error:", err);
    res.status(500).send('Error');
  }
});

// ---- HEALTH CHECK FUNCTION ----
async function checkHealth() {
  const healthcheck = {
    uptime: process.uptime(),
    timestamp: Date.now(),
    database: false,
    pesapal: false,
    memory: `${Math.round(process.memoryUsage().heapUsed / 1024 / 1024)} MB`
  };
  
  // Check database
  try {
    await new Promise((resolve, reject) => {
      db.get("SELECT 1", (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
    healthcheck.database = true;
  } catch (err) {
    logger.error("Database health check failed:", err);
  }
  
  // Check Pesapal
  try {
    const token = await getPesapalToken();
    healthcheck.pesapal = !!token;
  } catch (err) {
    logger.error("Pesapal health check failed:", err);
  }
  
  return healthcheck;
}

// ---- HEALTH CHECK ENDPOINT ----
app.get("/health", async (req, res) => {
  const health = await checkHealth();
  res.json(health);
});

// ---- WEBHOOK ENDPOINT ----
app.post(`/bot${TELEGRAM_BOT_TOKEN}`, (req, res) => {
  bot.processUpdate(req.body);
  res.sendStatus(200);
});

// ---- TEST ROUTE ----
app.get("/", (req, res) => {
  res.json({
    name: "Support Street Kids Donation Bot",
    version: "1.0.0",
    status: "running",
    timestamp: new Date().toISOString()
  });
});

// ---- ERROR HANDLING MIDDLEWARE ----
app.use((err, req, res, next) => {
  logger.error("Unhandled error:", err);
  res.status(500).json({ error: "Internal server error" });
});

// ---- GRACEFUL SHUTDOWN ----
process.on('SIGTERM', () => {
  logger.info('SIGTERM received. Shutting down gracefully...');
  db.close(() => {
    logger.info('Database connection closed');
    process.exit(0);
  });
});

process.on('SIGINT', () => {
  logger.info('SIGINT received. Shutting down gracefully...');
  db.close(() => {
    logger.info('Database connection closed');
    process.exit(0);
  });
});

// ---- START SERVER ----
app.listen(PORT, () => {
  logger.info(`🚀 Server running on port ${PORT}`);
  logger.info(`🤖 Telegram bot webhook set to: ${TELEGRAM_WEBHOOK_URL}/bot${TELEGRAM_BOT_TOKEN}`);
  logger.info(`💰 Pesapal environment: ${PESAPAL_ENV}`);
});
