require("dotenv").config();
const express = require("express");
const TelegramBot = require("node-telegram-bot-api");
const sqlite3 = require("sqlite3").verbose();
const fs = require("fs");
const csv = require("csv-parser");
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
const PESAPAL_ENV = process.env.PESAPAL_ENV || "live"; // 'demo' or 'live'
const MAX_AMOUNT = 150000;
const BATCH_SIZE = 5;

// ---- API 3.0 URLS (CORRECT) ----
const PESAPAL_URLS = {
  demo: "https://cybqa.pesapal.com/pesapalv3/api",  // Correct sandbox URL [citation:4][citation:5]
  live: "https://pay.pesapal.com/v3/api"            // Correct production URL [citation:4][citation:5][citation:8]
};

const BASE_URL = PESAPAL_ENV === 'demo' ? PESAPAL_URLS.demo : PESAPAL_URLS.live;

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

// ---- EXPRESS ----
const app = express();
app.use(express.json());

// ---- TELEGRAM BOT ----
const bot = new TelegramBot(TELEGRAM_BOT_TOKEN);
const webhookUrl = `${TELEGRAM_WEBHOOK_URL}/bot${TELEGRAM_BOT_TOKEN}`;

// Set webhook on startup
bot.setWebHook(webhookUrl).then(() => {
  logger.info(`Webhook set to: ${webhookUrl}`);
}).catch(err => {
  logger.error("Failed to set webhook:", err);
});

// ---- RATE LIMITER ----
const http = rateLimit(axios.create(), { 
  maxRequests: 2, 
  perMilliseconds: 1000
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

// ========== PESAPAL API 3.0 FUNCTIONS (CORRECT) ==========

/**
 * Get OAuth token from Pesapal API 3.0
 * Uses correct JSON endpoint and Bearer token format [citation:5][citation:8]
 */
async function getPesapalToken() {
  try {
    const url = `${BASE_URL}/Auth/RequestToken`; // Correct endpoint [citation:8]
    
    logger.info(`Requesting token from: ${url}`);
    
    const response = await http.post(url, {
      consumer_key: PESAPAL_CONSUMER_KEY,
      consumer_secret: PESAPAL_CONSUMER_SECRET
    }, {
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json'
      }
    });

    logger.info("Token response received");
    
    // API 3.0 returns token in response.data.token [citation:8]
    if (response.data && response.data.token) {
      const token = response.data.token;
      logger.info(`✅ Token obtained successfully: ${token.substring(0, 20)}...`);
      return token;
    } else {
      logger.error("Unexpected response format:", JSON.stringify(response.data));
      return null;
    }
  } catch (err) {
    logger.error("Failed to get token:", err.response?.data || err.message);
    if (err.response) {
      logger.error("Status:", err.response.status);
      logger.error("Data:", err.response.data);
    }
    return null;
  }
}

/**
 * Register IPN URL (required for API 3.0) [citation:5][citation:10]
 * This must be done once per IPN URL
 */
async function registerIPN(ipnUrl, token) {
  try {
    const url = `${BASE_URL}/URLSetup/RegisterIPN`;
    
    const response = await http.post(url, {
      url: ipnUrl,
      ipn_notification_type: "GET" // or "POST"
    }, {
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
        'Accept': 'application/json'
      }
    });

    logger.info("IPN registration response:", response.data);
    
    if (response.data && response.data.ipn_id) {
      return response.data.ipn_id;
    }
    return null;
  } catch (err) {
    logger.error("IPN registration failed:", err.response?.data || err.message);
    return null;
  }
}

/**
 * Get registered IPNs [citation:5]
 */
async function getRegisteredIPNs(token) {
  try {
    const url = `${BASE_URL}/URLSetup/GetIpnList`;
    
    const response = await http.get(url, {
      headers: {
        'Authorization': `Bearer ${token}`,
        'Accept': 'application/json'
      }
    });

    return response.data;
  } catch (err) {
    logger.error("Failed to get IPNs:", err.response?.data || err.message);
    return [];
  }
}

/**
 * Submit order request to Pesapal API 3.0 [citation:5][citation:10]
 */
async function submitOrder(phone, amount, donationId, token) {
  try {
    const url = `${BASE_URL}/Transactions/SubmitOrderRequest`;
    
    const cleanPhone = phone.replace(/\D/g, '');
    
    // API 3.0 order payload format [citation:5][citation:10]
    const payload = {
      id: donationId,
      currency: "KES",
      amount: amount,
      description: "Support Street Kids Donation",
      callback_url: `${TELEGRAM_WEBHOOK_URL}/payment-callback`,
      notification_id: process.env.PESAPAL_IPN_ID, // You need to register IPN first
      billing_address: {
        phone_number: cleanPhone,
        country_code: "KE",
        first_name: "Street",
        last_name: "Kids Supporter",
        line_1: "Nairobi, Kenya"
      }
    };

    logger.info(`Submitting order for ${donationId}`);

    const response = await http.post(url, payload, {
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
        'Accept': 'application/json'
      },
      timeout: 30000
    });

    logger.info("Order submission response:", response.data);
    
    // Check for redirect URL (customer goes here to complete payment)
    if (response.data && response.data.redirect_url) {
      return {
        success: true,
        redirect_url: response.data.redirect_url,
        order_tracking_id: response.data.order_tracking_id,
        merchant_reference: response.data.merchant_reference
      };
    }
    
    return { success: false, error: "No redirect URL in response" };
  } catch (err) {
    logger.error("Order submission failed:", err.response?.data || err.message);
    throw err;
  }
}

/**
 * Get transaction status [citation:5]
 */
async function getTransactionStatus(trackingId, merchantReference, token) {
  try {
    const url = `${BASE_URL}/Transactions/GetTransactionStatus`;
    
    const response = await http.get(url, {
      headers: {
        'Authorization': `Bearer ${token}`,
        'Accept': 'application/json'
      },
      params: {
        order_tracking_id: trackingId,
        order_merchant_reference: merchantReference
      }
    });

    return response.data;
  } catch (err) {
    logger.error("Failed to get transaction status:", err.message);
    return null;
  }
}

/**
 * Main function to process a donation
 */
async function processDonation(phone, amount, donationId) {
  try {
    // Step 1: Get token
    const token = await getPesapalToken();
    if (!token) {
      throw new Error("Failed to obtain authentication token");
    }

    // Step 2: Check if IPN is registered (you should do this once and store the ID)
    // For now, we'll try to get existing IPNs
    const ipns = await getRegisteredIPNs(token);
    let ipnId = process.env.PESAPAL_IPN_ID;
    
    if (!ipnId && ipns.length > 0) {
      ipnId = ipns[0].ipn_id;
      logger.info(`Using existing IPN ID: ${ipnId}`);
    }

    // Step 3: Submit order
    const result = await submitOrder(phone, amount, donationId, token);
    
    if (result.success) {
      // Update database with tracking info
      await new Promise((resolve, reject) => {
        db.run(
          `UPDATE donations SET 
             pesapal_transaction_id = ?,
             pesapal_reference = ?,
             status = ?,
             updated_at = CURRENT_TIMESTAMP 
           WHERE id = ?`,
          [result.order_tracking_id, result.merchant_reference, "PROCESSING", donationId],
          (err) => err ? reject(err) : resolve()
        );
      });

      return { 
        success: true, 
        redirect_url: result.redirect_url,
        tracking_id: result.order_tracking_id
      };
    }

    throw new Error("Order submission failed");
    
  } catch (err) {
    logger.error(`Donation processing failed for ${donationId}:`, err.message);
    
    await new Promise((resolve) => {
      db.run(
        `UPDATE donations SET status = ?, error_message = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
        ["FAILED", err.message, donationId],
        () => resolve()
      );
    });
    
    return { success: false, error: err.message };
  }
}

// ---- TELEGRAM HANDLER ----
bot.on("message", async (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id.toString();
  const text = msg.text;

  if (userId !== OWNER_ID) {
    logger.warn(`Unauthorized access from user ${userId}`);
    return bot.sendMessage(chatId, "⛔ Unauthorized. This bot is private.");
  }

  try {
    if (text === "/start" || text === "/help") {
      const helpMessage = `
🤖 *Support Street Kids Donation Bot*

*Commands:*
• Send phone (2547XXXXXXXX) - Process KES 100 donation
• /bulk [size] - Process donations from donors.csv
• /stats - View donation statistics
• /retry [id] - Retry failed donation
• /health - Check system status
• /test-auth - Test Pesapal authentication

*Examples:*
\`/bulk 5\` - Process 5 donations at a time
\`/retry DON_123456\` - Retry specific donation

*CSV Format:* phone,amount
      `;
      return bot.sendMessage(chatId, helpMessage, { parse_mode: 'Markdown' });
    }

    if (text === "/stats") {
      db.get(`
        SELECT 
          COUNT(*) as total,
          SUM(CASE WHEN status = 'COMPLETED' THEN 1 ELSE 0 END) as completed,
          SUM(CASE WHEN status = 'PENDING' THEN 1 ELSE 0 END) as pending,
          SUM(CASE WHEN status = 'PROCESSING' THEN 1 ELSE 0 END) as processing,
          SUM(CASE WHEN status = 'FAILED' THEN 1 ELSE 0 END) as failed,
          SUM(CASE WHEN status = 'COMPLETED' THEN amount ELSE 0 END) as total_amount
        FROM donations
      `, (err, row) => {
        if (err) {
          logger.error("Stats error:", err);
          return bot.sendMessage(chatId, "❌ Failed to fetch statistics");
        }
        
        const stats = `
📊 *Donation Statistics*
Total: ${row.total || 0}
✅ Completed: ${row.completed || 0}
⏳ Processing: ${row.processing || 0}
⏳ Pending: ${row.pending || 0}
❌ Failed: ${row.failed || 0}
💰 Total Amount: KES ${row.total_amount || 0}
        `;
        
        bot.sendMessage(chatId, stats, { parse_mode: 'Markdown' });
      });
      return;
    }

    if (text === "/health") {
      const health = await checkHealth();
      const status = health.database && health.pesapal ? "✅" : "⚠️";
      bot.sendMessage(chatId, 
        `${status} *System Health*\n` +
        `• Database: ${health.database ? '✅' : '❌'}\n` +
        `• Pesapal: ${health.pesapal ? '✅' : '❌'}\n` +
        `• Environment: ${PESAPAL_ENV}\n` +
        `• API URL: ${BASE_URL}\n` +
        `• Uptime: ${Math.floor(health.uptime / 60)} minutes`,
        { parse_mode: 'Markdown' }
      );
      return;
    }

    if (text === "/test-auth") {
      bot.sendMessage(chatId, "🔄 Testing Pesapal authentication...");
      
      const token = await getPesapalToken();
      
      if (token) {
        bot.sendMessage(chatId, 
          `✅ *Authentication Successful*\n\n` +
          `Token: ${token.substring(0, 30)}...\n` +
          `Environment: ${PESAPAL_ENV}\n` +
          `API URL: ${BASE_URL}`,
          { parse_mode: 'Markdown' }
        );
      } else {
        bot.sendMessage(chatId, 
          `❌ *Authentication Failed*\n\n` +
          `Check your credentials and environment.\n` +
          `Environment: ${PESAPAL_ENV}\n` +
          `API URL: ${BASE_URL}`,
          { parse_mode: 'Markdown' }
        );
      }
      return;
    }

    if (text.startsWith("/retry")) {
      const args = text.split(' ');
      if (args.length < 2) {
        return bot.sendMessage(chatId, "❌ Please provide donation ID");
      }
      
      const donationId = args[1];
      
      db.get("SELECT * FROM donations WHERE id = ?", [donationId], async (err, row) => {
        if (err || !row) {
          return bot.sendMessage(chatId, "❌ Donation not found");
        }
        
        bot.sendMessage(chatId, `🔄 Retrying donation ${donationId}...`);
        
        const result = await processDonation(row.phone, row.amount, donationId);
        
        if (result.success) {
          bot.sendMessage(chatId, 
            `✅ Payment initiated for ${donationId}\n` +
            `Tracking ID: ${result.tracking_id || 'N/A'}`
          );
        } else {
          bot.sendMessage(chatId, `❌ Failed: ${result.error}`);
        }
      });
      return;
    }

    if (text.startsWith("/bulk")) {
      const args = text.split(' ');
      const customBatchSize = args[1] ? parseInt(args[1]) : BATCH_SIZE;
      
      if (!fs.existsSync("donors.csv")) {
        return bot.sendMessage(chatId, "❌ donors.csv file not found");
      }

      const results = [];
      let invalidRows = [];

      fs.createReadStream("donors.csv")
        .pipe(csv())
        .on("data", (row) => {
          const phone = row.phone?.trim();
          const amount = parseInt(row.amount);
          
          if (!validatePhone(phone)) {
            invalidRows.push({ row, reason: "Invalid phone" });
          } else if (!validateAmount(amount)) {
            invalidRows.push({ row, reason: `Amount 1-${MAX_AMOUNT}` });
          } else {
            results.push({ phone, amount });
          }
        })
        .on("end", async () => {
          if (results.length === 0) {
            return bot.sendMessage(chatId, "❌ No valid donations found");
          }

          const statusMsg = await bot.sendMessage(chatId, 
            `📊 Processing ${results.length} donations...`
          );

          let successCount = 0;
          let failCount = 0;

          for (let i = 0; i < results.length; i += customBatchSize) {
            const batch = results.slice(i, i + customBatchSize);
            
            for (const row of batch) {
              try {
                const donationId = generateDonationId();
                
                await new Promise((resolve, reject) => {
                  db.run(
                    `INSERT INTO donations (id, phone, amount) VALUES (?, ?, ?)`,
                    [donationId, row.phone, row.amount],
                    (err) => err ? reject(err) : resolve()
                  );
                });
                
                const result = await processDonation(row.phone, row.amount, donationId);
                
                if (result.success) {
                  successCount++;
                } else {
                  failCount++;
                }
                
                await sleep(1000); // Rate limiting
                
              } catch (err) {
                logger.error("Batch error:", err);
                failCount++;
              }
            }

            await bot.editMessageText(
              `📊 Progress: ${Math.min(i + customBatchSize, results.length)}/${results.length}\n` +
              `✅ Success: ${successCount}\n` +
              `❌ Failed: ${failCount}`,
              {
                chat_id: chatId,
                message_id: statusMsg.message_id
              }
            );
          }

          bot.sendMessage(chatId, 
            `✅ *Bulk Complete*\n\n` +
            `Total: ${results.length}\n` +
            `✅ Success: ${successCount}\n` +
            `❌ Failed: ${failCount}\n` +
            `⚠️ Invalid: ${invalidRows.length}`,
            { parse_mode: 'Markdown' }
          );
        });
      
      return;
    }

    if (text && text.startsWith("254") && text.length === 12) {
      if (!validatePhone(text)) {
        return bot.sendMessage(chatId, "❌ Invalid phone. Use: 2547XXXXXXXX");
      }

      const donationId = generateDonationId();
      const amount = 100;

      bot.sendMessage(chatId, `🔄 Processing donation...`);

      db.run(
        `INSERT INTO donations (id, phone, amount) VALUES (?, ?, ?)`,
        [donationId, text, amount],
        async function (err) {
          if (err) {
            logger.error("DB error:", err);
            return bot.sendMessage(chatId, "❌ Failed to log donation");
          }

          bot.sendMessage(chatId, `📝 Donation logged: ${donationId}`);
          
          const result = await processDonation(text, amount, donationId);
          
          if (result.success) {
            bot.sendMessage(chatId, 
              `✅ Payment initiated!\n` +
              `📱 Phone: ${text}\n` +
              `💰 Amount: KES ${amount}\n` +
              `🆔 Tracking: ${result.tracking_id || 'N/A'}`
            );
          } else {
            bot.sendMessage(chatId, 
              `❌ Payment failed: ${result.error}\n` +
              `Retry: /retry ${donationId}`
            );
          }
        }
      );
      return;
    }

    bot.sendMessage(chatId, "❌ Unknown command. Type /help");

  } catch (err) {
    logger.error("Handler error:", err);
    bot.sendMessage(chatId, "❌ An error occurred");
  }
});

// ---- PAYMENT CALLBACK (User returns here after payment) ----
app.get("/payment-callback", async (req, res) => {
  try {
    const {
      order_tracking_id,
      order_merchant_reference,
      payment_status_description
    } = req.query;

    logger.info("Payment callback received:", req.query);

    const status = payment_status_description === 'Completed' ? 'COMPLETED' : 'FAILED';

    db.run(
      `UPDATE donations SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
      [status, order_merchant_reference],
      (err) => {
        if (err) {
          logger.error("Failed to update donation:", err);
        }
      }
    );

    // Redirect to a simple thank you page
    res.send(`
      <html>
        <body style="text-align: center; padding: 50px; font-family: Arial;">
          <h1>Thank You for Your Support! 🙏</h1>
          <p>Payment Status: ${payment_status_description}</p>
          <p>Reference: ${order_merchant_reference}</p>
          <p>You can close this window and return to Telegram.</p>
        </body>
      </html>
    `);
  } catch (err) {
    logger.error("Callback error:", err);
    res.status(500).send("Error processing callback");
  }
});

// ---- PESAPAL IPN WEBHOOK (Asynchronous notifications) ----
app.post("/ipn", async (req, res) => {
  try {
    logger.info("IPN received:", req.body);
    
    const {
      OrderTrackingId,
      OrderMerchantReference,
      OrderStatus,
      PaymentStatusDescription
    } = req.body;

    const status = OrderStatus === 'COMPLETED' || PaymentStatusDescription === 'Completed' 
      ? 'COMPLETED' 
      : 'FAILED';

    db.run(
      `UPDATE donations SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
      [status, OrderMerchantReference],
      (err) => {
        if (err) {
          logger.error("Failed to update from IPN:", err);
          return res.status(500).send("Error");
        }
        
        // Notify owner
        const message = status === 'COMPLETED'
          ? `✅ Payment completed for ${OrderMerchantReference}`
          : `❌ Payment failed for ${OrderMerchantReference}`;
        
        bot.sendMessage(OWNER_ID, message).catch(e => logger.error("Notify failed:", e));
        
        res.status(200).send("OK");
      }
    );
  } catch (err) {
    logger.error("IPN error:", err);
    res.status(500).send("Error");
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
  
  // Check Pesapal authentication
  try {
    const token = await getPesapalToken();
    healthcheck.pesapal = !!token;
  } catch (err) {
    logger.error("Pesapal health check failed:", err);
  }
  
  return healthcheck;
}

// ---- ENDPOINTS ----
app.get("/health", async (req, res) => {
  const health = await checkHealth();
  res.json(health);
});

app.get("/healthz", (req, res) => {
  res.status(200).send("OK");
});

app.post(`/bot${TELEGRAM_BOT_TOKEN}`, (req, res) => {
  bot.processUpdate(req.body);
  res.sendStatus(200);
});

app.get("/", (req, res) => {
  res.json({
    name: "Support Street Kids Donation Bot",
    version: "2.0.0",
    status: "running",
    environment: PESAPAL_ENV,
    api_url: BASE_URL,
    timestamp: new Date().toISOString()
  });
});

// ---- ERROR HANDLING ----
app.use((err, req, res, next) => {
  logger.error("Unhandled error:", err);
  res.status(500).json({ error: "Internal server error" });
});

// ---- START SERVER ----
const server = app.listen(PORT, '0.0.0.0', () => {
  logger.info(`✅ Server running on port ${PORT}`);
  logger.info(`🤖 Telegram webhook: ${webhookUrl}`);
  logger.info(`💰 Pesapal environment: ${PESAPAL_ENV}`);
  logger.info(`📡 Pesapal API URL: ${BASE_URL}`);
  logger.info(`🔧 Test auth with: /test-auth`);
});

server.on('error', (error) => {
  logger.error("Server failed:", error.message);
  process.exit(1);
});

// ---- GRACEFUL SHUTDOWN ----
process.on('SIGTERM', () => {
  logger.info('SIGTERM received. Shutting down...');
  server.close(() => {
    db.close(() => {
      logger.info('Database closed');
      process.exit(0);
    });
  });
});

process.on('SIGINT', () => {
  logger.info('SIGINT received. Shutting down...');
  server.close(() => {
    db.close(() => {
      logger.info('Database closed');
      process.exit(0);
    });
  });
});
