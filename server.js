require("dotenv").config();
const express = require("express");
const TelegramBot = require("node-telegram-bot-api");
const sqlite3 = require("sqlite3").verbose();
const fs = require("fs");
const csv = require("csv-parser");
const rateLimit = require("axios-rate-limit");
const axios = require("axios");
const crypto = require("crypto");
const querystring = require('querystring');
const OAuth = require('oauth-1.0a');

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
const PESAPAL_ENV = process.env.PESAPAL_ENV || "live";
const PESAPAL_CALLBACK_URL = process.env.PESAPAL_CALLBACK_URL || `${TELEGRAM_WEBHOOK_URL}/callback`;
const MAX_AMOUNT = 150000;
const BATCH_SIZE = 5;

// Pesapal API URLs
const PESAPAL_URLS = {
  demo: {
    token: "https://demo.pesapal.com/API/Token/RequestToken",
    stk: "https://demo.pesapal.com/API/STKPush/Request",
    order: "https://demo.pesapal.com/API/SubmitOrderDirect",
    query: "https://demo.pesapal.com/API/QueryPaymentStatus"
  },
  live: {
    token: "https://www.pesapal.com/API/Token/RequestToken",
    stk: "https://www.pesapal.com/API/STKPush/Request",
    order: "https://www.pesapal.com/API/SubmitOrderDirect",
    query: "https://www.pesapal.com/API/QueryPaymentStatus"
  }
};

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
app.use(express.urlencoded({ extended: true }));

// ---- TELEGRAM BOT ----
const bot = new TelegramBot(TELEGRAM_BOT_TOKEN);
const webhookUrl = `${TELEGRAM_WEBHOOK_URL}/bot${TELEGRAM_BOT_TOKEN}`;

// Set webhook on startup
bot.setWebHook(webhookUrl).then(() => {
  logger.info(`Webhook set to: ${webhookUrl}`);
}).catch(err => {
  logger.error("Failed to set webhook:", err);
});

// ---- RATE LIMITER FOR PESAPAL ----
const http = rateLimit(axios.create(), { 
  maxRequests: 1, 
  perMilliseconds: 1500
});

// ---- OAUTH 1.0 SETUP FOR PESAPAL ----
const oauth = OAuth({
  consumer: {
    key: PESAPAL_CONSUMER_KEY,
    secret: PESAPAL_CONSUMER_SECRET
  },
  signature_method: 'HMAC-SHA1',
  hash_function(base_string, key) {
    return crypto
      .createHmac('sha1', key)
      .update(base_string)
      .digest('base64');
  }
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

// ---- PESAPAL FUNCTIONS ----
async function getPesapalToken() {
  try {
    const urls = PESAPAL_ENV === 'demo' ? PESAPAL_URLS.demo : PESAPAL_URLS.live;
    const url = urls.token;
    
    logger.info(`Requesting token from: ${url}`);
    
    // Generate OAuth signature
    const request_data = {
      url: url,
      method: 'POST'
    };
    
    const oauth_headers = oauth.toHeader(oauth.authorize(request_data));
    
    // Make request with OAuth headers
    const response = await http.post(url, null, {
      headers: {
        ...oauth_headers,
        'Content-Type': 'application/x-www-form-urlencoded',
        'Accept': 'application/json'
      }
    });

    logger.info("Pesapal token response received");
    
    // Parse the response
    if (response.data) {
      // If response is a string, try to parse it
      if (typeof response.data === 'string') {
        try {
          const parsed = JSON.parse(response.data);
          if (parsed.token || parsed.access_token || parsed.Token) {
            const token = parsed.token || parsed.access_token || parsed.Token;
            logger.info(`Token obtained: ${token.substring(0, 20)}...`);
            return token;
          }
        } catch (e) {
          // Not JSON, check if it's a plain token
          if (response.data.length < 500 && !response.data.includes('<!DOCTYPE')) {
            logger.info(`Plain token received: ${response.data.substring(0, 20)}...`);
            return response.data.trim();
          }
        }
      } else {
        // JSON object
        const token = response.data.token || response.data.access_token || response.data.Token;
        if (token) {
          logger.info(`Token obtained: ${token.substring(0, 20)}...`);
          return token;
        }
      }
    }
    
    logger.error("No token found in response:", response.data);
    return null;
    
  } catch (err) {
    logger.error("Failed to get Pesapal token:", err.response?.data || err.message);
    if (err.response) {
      logger.error("Error status:", err.response.status);
      logger.error("Error headers:", err.response.headers);
      logger.error("Error data:", err.response.data);
    }
    return null;
  }
}

async function initiateSTKPush(phone, amount, donationId) {
  try {
    const urls = PESAPAL_ENV === 'demo' ? PESAPAL_URLS.demo : PESAPAL_URLS.live;
    
    // First, get token
    const token = await getPesapalToken();
    if (!token) {
      throw new Error("Could not obtain Pesapal token");
    }
    
    const cleanPhone = phone.replace(/\D/g, '');
    
    // Prepare STK push request
    const stkData = {
      consumer_key: PESAPAL_CONSUMER_KEY,
      consumer_secret: PESAPAL_CONSUMER_SECRET,
      token: token,
      amount: amount,
      phone: cleanPhone,
      reference: donationId,
      description: "Support Street Kids Donation",
      callback_url: PESAPAL_CALLBACK_URL,
      currency: "KES"
    };
    
    logger.info(`Initiating STK push for ${donationId}`);
    
    // Try different endpoints
    const endpoints = [
      urls.stk,
      urls.order,
      `${PESAPAL_ENV === 'demo' ? 'https://demo.pesapal.com' : 'https://www.pesapal.com'}/api/STKPush/Request`
    ];
    
    let lastError = null;
    
    for (const endpoint of endpoints) {
      try {
        logger.info(`Trying endpoint: ${endpoint}`);
        
        const response = await http.post(endpoint, 
          querystring.stringify(stkData),
          {
            headers: {
              'Content-Type': 'application/x-www-form-urlencoded',
              'Accept': 'application/json'
            },
            timeout: 30000
          }
        );
        
        logger.info(`Response from ${endpoint}:`, response.data);
        
        // Parse response
        let result;
        if (typeof response.data === 'string') {
          try {
            result = JSON.parse(response.data);
          } catch (e) {
            result = { raw: response.data };
          }
        } else {
          result = response.data;
        }
        
        // Check for success indicators
        if (result.status === 'success' || result.success === true || result.transaction_id || result.OrderTrackingId) {
          const transactionId = result.transaction_id || result.OrderTrackingId || result.TransactionId;
          
          if (transactionId) {
            await new Promise((resolve, reject) => {
              db.run(
                `UPDATE donations SET pesapal_transaction_id = ?, status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
                [transactionId, "PROCESSING", donationId],
                (err) => err ? reject(err) : resolve()
              );
            });
          }
          
          return { 
            success: true, 
            data: result,
            transactionId: transactionId 
          };
        }
        
        lastError = new Error("Invalid response format");
      } catch (endpointErr) {
        logger.warn(`Endpoint ${endpoint} failed:`, endpointErr.message);
        lastError = endpointErr;
        continue;
      }
    }
    
    throw lastError || new Error("All endpoints failed");
    
  } catch (err) {
    logger.error(`STK push failed for ${donationId}:`, err.message);
    throw err;
  }
}

async function sendSTKWithRetry(phone, amount, donationId, maxRetries = 3) {
  for (let i = 0; i < maxRetries; i++) {
    try {
      const result = await initiateSTKPush(phone, amount, donationId);
      return result;
    } catch (err) {
      logger.error(`Attempt ${i + 1}/${maxRetries} failed for ${donationId}:`, err.message);
      
      if (i < maxRetries - 1) {
        const waitTime = 2000 * (i + 1);
        logger.info(`Retrying in ${waitTime}ms...`);
        await sleep(waitTime);
      }
    }
  }
  
  // Update database with final failure
  await new Promise((resolve) => {
    db.run(
      `UPDATE donations SET status = ?, error_message = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
      ["FAILED", "Max retries exceeded", donationId],
      () => resolve()
    );
  });
  
  return { success: false, error: "Max retries exceeded" };
}

// ---- TELEGRAM HANDLER ----
bot.on("message", async (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id.toString();
  const text = msg.text;

  if (userId !== OWNER_ID) {
    logger.warn(`Unauthorized access attempt from user ${userId}`);
    return bot.sendMessage(chatId, "⛔ Unauthorized. This bot is private.");
  }

  try {
    if (text === "/start" || text === "/help") {
      const helpMessage = `
🤖 *Support Street Kids Donation Bot*

*Commands:*
• Send phone number (2547XXXXXXXX) - Process single KES 100 donation
• /bulk [batch_size] - Process donations from donors.csv
• /stats - View donation statistics
• /retry [donation_id] - Retry failed donation
• /health - Check system status
• /test-pesapal - Test Pesapal connection

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
          logger.error("Stats query error:", err);
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
        `• Uptime: ${Math.floor(health.uptime / 60)} minutes\n` +
        `• Memory: ${health.memory}`,
        { parse_mode: 'Markdown' }
      );
      return;
    }

    if (text === "/test-pesapal") {
      bot.sendMessage(chatId, "🔄 Testing Pesapal connection...");
      
      try {
        // Test token generation
        const token = await getPesapalToken();
        
        if (token && !token.includes('<!DOCTYPE')) {
          bot.sendMessage(chatId, 
            `✅ *Pesapal Connection Successful*\n\n` +
            `Token: ${token.substring(0, 30)}...\n` +
            `Token Length: ${token.length}\n` +
            `Environment: ${PESAPAL_ENV}`,
            { parse_mode: 'Markdown' }
          );
        } else {
          bot.sendMessage(chatId, 
            `❌ *Pesapal Connection Failed*\n\n` +
            `Received HTML instead of token. This usually means:\n` +
            `1. Wrong API endpoint\n` +
            `2. Invalid credentials\n` +
            `3. IP not whitelisted\n\n` +
            `Environment: ${PESAPAL_ENV}`,
            { parse_mode: 'Markdown' }
          );
        }
      } catch (err) {
        bot.sendMessage(chatId, `❌ Error: ${err.message}`);
      }
      return;
    }

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
          bot.sendMessage(chatId, 
            `✅ STK push resent successfully for ${donationId}\n` +
            `Transaction ID: ${result.transactionId || 'N/A'}`
          );
        } else {
          bot.sendMessage(chatId, `❌ Failed to resend STK: ${result.error}`);
        }
      });
      return;
    }

    if (text.startsWith("/bulk")) {
      const args = text.split(' ');
      const customBatchSize = args[1] ? parseInt(args[1]) : BATCH_SIZE;
      
      if (!fs.existsSync("donors.csv")) {
        return bot.sendMessage(chatId, "❌ donors.csv file not found. Please upload the file first.");
      }

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

          for (let i = 0; i < results.length; i += customBatchSize) {
            const batch = results.slice(i, i + customBatchSize);
            const batchPromises = batch.map(async (row) => {
              try {
                const donationId = generateDonationId();
                
                await new Promise((resolve, reject) => {
                  db.run(
                    `INSERT INTO donations (id, phone, amount, status) VALUES (?, ?, ?, ?)`,
                    [donationId, row.phone, row.amount, "PENDING"],
                    (err) => err ? reject(err) : resolve()
                  );
                });
                
                const result = await sendSTKWithRetry(row.phone, row.amount, donationId);
                
                if (result.success) {
                  successCount++;
                  return { success: true, donationId };
                } else {
                  failCount++;
                  return { success: false, donationId, error: result.error };
                }
              } catch (err) {
                logger.error("Batch processing error:", err);
                failCount++;
                return { success: false, error: err.message };
              }
            });

            await Promise.all(batchPromises);
            
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

            if (i + customBatchSize < results.length) {
              await sleep(2000);
            }
          }

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

    if (text && text.startsWith("254") && text.length === 12) {
      if (!validatePhone(text)) {
        return bot.sendMessage(chatId, "❌ Invalid phone format. Use: 2547XXXXXXXX");
      }

      const donationId = generateDonationId();
      const amount = 100;

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
              `🆔 Transaction: ${result.transactionId || 'N/A'}`
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

    bot.sendMessage(chatId, "❌ Unknown command. Type /help for available commands.");

  } catch (err) {
    logger.error("Message handler error:", err);
    bot.sendMessage(chatId, "❌ An error occurred processing your request");
  }
});

// ---- PESAPAL CALLBACK ----
app.post("/callback", (req, res) => {
  try {
    logger.info("Pesapal callback received:", req.body);
    logger.info("Pesapal callback headers:", req.headers);

    const {
      OrderTrackingId,
      OrderMerchantReference,
      OrderStatus,
      Status,
      Amount,
      Currency
    } = req.body;

    const paymentStatus = OrderStatus || Status;
    const donationStatus = paymentStatus === 'COMPLETED' || paymentStatus === 'SUCCESS' ? 'COMPLETED' : 'FAILED';
    const transactionId = OrderTrackingId || req.body.transaction_id;

    db.run(
      `UPDATE donations 
       SET status = ?, 
           pesapal_transaction_id = ?,
           pesapal_reference = ?,
           updated_at = CURRENT_TIMESTAMP 
       WHERE id = ?`,
      [donationStatus, transactionId, OrderMerchantReference, OrderMerchantReference],
      (err) => {
        if (err) {
          logger.error("Failed to update donation status from callback:", err);
          return res.status(500).send('Database error');
        }

        const message = donationStatus === 'COMPLETED' 
          ? `✅ Payment completed for donation ${OrderMerchantReference}\n` +
            `💰 Amount: ${Currency || 'KES'} ${Amount || 'N/A'}\n` +
            `🆔 Transaction: ${transactionId || 'N/A'}`
          : `❌ Payment failed for donation ${OrderMerchantReference}`;

        bot.sendMessage(OWNER_ID, message).catch(e => 
          logger.error("Failed to send notification:", e)
        );

        res.status(200).send("Callback received successfully");
      }
    );
  } catch (err) {
    logger.error("Callback processing error:", err);
    res.status(500).send('Error processing callback');
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
  
  return healthcheck;
}

// ---- HEALTH CHECK ENDPOINTS ----
app.get("/health", async (req, res) => {
  const health = await checkHealth();
  res.json(health);
});

app.get("/healthz", (req, res) => {
  res.status(200).send("OK");
});

// ---- TEST PESAPAL ENDPOINT ----
app.get("/test-pesapal", async (req, res) => {
  try {
    const token = await getPesapalToken();
    
    res.json({
      success: !!token && !token.includes('<!DOCTYPE'),
      token: token ? `${token.substring(0, 50)}...` : null,
      token_length: token ? token.length : 0,
      is_html: token ? token.includes('<!DOCTYPE') : false,
      environment: PESAPAL_ENV,
      urls: PESAPAL_ENV === 'demo' ? PESAPAL_URLS.demo : PESAPAL_URLS.live,
      has_consumer_key: !!PESAPAL_CONSUMER_KEY,
      has_consumer_secret: !!PESAPAL_CONSUMER_SECRET,
      callback_url: PESAPAL_CALLBACK_URL,
      timestamp: new Date().toISOString()
    });
  } catch (err) {
    res.status(500).json({
      success: false,
      error: err.message,
      stack: err.stack
    });
  }
});

// ---- DEBUG ENDPOINT ----
app.get("/debug", (req, res) => {
  res.json({
    port: process.env.PORT,
    node_env: process.env.NODE_ENV,
    server_port: PORT,
    webhook: webhookUrl,
    pesapal_env: PESAPAL_ENV,
    pesapal_callback: PESAPAL_CALLBACK_URL,
    owner_id: OWNER_ID
  });
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
    environment: PESAPAL_ENV,
    timestamp: new Date().toISOString()
  });
});

// ---- ERROR HANDLING MIDDLEWARE ----
app.use((err, req, res, next) => {
  logger.error("Unhandled error:", err);
  res.status(500).json({ error: "Internal server error" });
});

// ---- START SERVER ----
const server = app.listen(PORT, '0.0.0.0', () => {
  logger.info(`✅ Server bound to 0.0.0.0 on port ${PORT}`);
  logger.info(`🤖 Telegram bot webhook set to: ${webhookUrl}`);
  logger.info(`💰 Pesapal environment: ${PESAPAL_ENV}`);
  logger.info(`📊 Health check available at: /healthz`);
  logger.info(`🔧 Test Pesapal at: /test-pesapal`);
});

server.on('error', (error) => {
  logger.error("Server failed to start:", error.message);
  process.exit(1);
});

// ---- GRACEFUL SHUTDOWN ----
process.on('SIGTERM', () => {
  logger.info('SIGTERM received. Shutting down gracefully...');
  server.close(() => {
    db.close(() => {
      logger.info('Database connection closed');
      process.exit(0);
    });
  });
});

process.on('SIGINT', () => {
  logger.info('SIGINT received. Shutting down gracefully...');
  server.close(() => {
    db.close(() => {
      logger.info('Database connection closed');
      process.exit(0);
    });
  });
});
