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
const PESAPAL_ENV = process.env.PESAPAL_ENV || "live";
const PESAPAL_IPN_ID = process.env.PESAPAL_IPN_ID;
const MAX_AMOUNT = 150000;
const BATCH_SIZE = 5;

// ---- API 3.0 URLS ----
const PESAPAL_URLS = {
  demo: "https://cybqa.pesapal.com/pesapalv3/api",
  live: "https://pay.pesapal.com/v3/api"
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

// Drop and recreate table with correct schema
db.serialize(() => {
  // Drop existing table if it has wrong schema
  db.run(`DROP TABLE IF EXISTS donations`);
  
  // Create table with correct schema
  db.run(`
    CREATE TABLE donations (
      id TEXT PRIMARY KEY,
      phone TEXT NOT NULL,
      amount INTEGER NOT NULL,
      status TEXT DEFAULT 'PENDING',
      order_tracking_id TEXT,
      merchant_reference TEXT,
      redirect_url TEXT,
      payment_link TEXT,
      error_message TEXT,
      retry_count INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);
  
  db.run(`CREATE INDEX IF NOT EXISTS idx_phone ON donations(phone)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_status ON donations(status)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_created_at ON donations(created_at)`);
  
  logger.info("Database schema initialized with correct columns");
});

// ---- EXPRESS ----
const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ---- TELEGRAM BOT ----
const bot = new TelegramBot(TELEGRAM_BOT_TOKEN, { polling: false });
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

const formatPhoneForPesapal = (phone) => {
  const cleaned = phone.replace(/\D/g, '');
  if (cleaned.startsWith('0')) {
    return '254' + cleaned.substring(1);
  }
  if (cleaned.startsWith('7')) {
    return '254' + cleaned;
  }
  return cleaned;
};

// Escape markdown characters for Telegram
const escapeMarkdown = (text) => {
  if (!text) return '';
  return text.replace(/[_*[\]()~`>#+\-=|{}.!]/g, '\\$&');
};

// ========== PESAPAL API 3.0 FUNCTIONS ==========

/**
 * Get authentication token
 */
async function getPesapalToken() {
  try {
    const url = `${BASE_URL}/Auth/RequestToken`;
    
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

    if (response.data && response.data.token) {
      const token = response.data.token;
      logger.info(`✅ Token obtained: ${token.substring(0, 20)}...`);
      return token;
    } else {
      logger.error("Unexpected token response:", JSON.stringify(response.data));
      return null;
    }
  } catch (err) {
    logger.error("Failed to get token:", err.response?.data || err.message);
    return null;
  }
}

/**
 * Submit order request (initiate payment)
 */
async function submitOrder(phone, amount, donationId, token) {
  try {
    const url = `${BASE_URL}/Transactions/SubmitOrderRequest`;
    
    const formattedPhone = formatPhoneForPesapal(phone);
    
    const payload = {
      id: donationId,
      currency: "KES",
      amount: amount,
      description: "Support Street Kids Donation",
      callback_url: `${TELEGRAM_WEBHOOK_URL}/payment-callback`,
      notification_id: PESAPAL_IPN_ID,
      branch: "Street Kids Support",
      billing_address: {
        phone_number: formattedPhone,
        country_code: "KE",
        first_name: "Street",
        last_name: "Kids Supporter",
        line_1: "Nairobi, Kenya",
        city: "Nairobi",
        state: "Nairobi",
        postal_code: "00100"
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
    
    if (response.data && response.data.redirect_url) {
      const result = {
        success: true,
        redirect_url: response.data.redirect_url,
        order_tracking_id: response.data.order_tracking_id,
        merchant_reference: response.data.merchant_reference
      };
      
      logger.info(`✅ Order submitted successfully:`, result);
      return result;
    }
    
    return { success: false, error: "Invalid response from Pesapal" };
  } catch (err) {
    logger.error("Order submission failed:", err.response?.data || err.message);
    throw err;
  }
}

/**
 * Process a donation and get payment link
 */
async function processDonation(phone, amount, donationId) {
  try {
    // Step 1: Get token
    const token = await getPesapalToken();
    if (!token) {
      throw new Error("Failed to obtain authentication token");
    }

    // Step 2: Submit order
    const result = await submitOrder(phone, amount, donationId, token);
    
    if (result.success) {
      // Step 3: Update database
      await new Promise((resolve, reject) => {
        db.run(
          `UPDATE donations SET 
             order_tracking_id = ?,
             merchant_reference = ?,
             redirect_url = ?,
             payment_link = ?,
             status = ?,
             updated_at = CURRENT_TIMESTAMP 
           WHERE id = ?`,
          [
            result.order_tracking_id,
            result.merchant_reference,
            result.redirect_url,
            result.redirect_url,
            "PENDING",
            donationId
          ],
          (err) => err ? reject(err) : resolve()
        );
      });

      return { 
        success: true, 
        redirect_url: result.redirect_url,
        tracking_id: result.order_tracking_id,
        payment_link: result.redirect_url
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

// ========== TELEGRAM HANDLER ==========

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
      const helpMessage = 
`🤖 *Support Street Kids Donation Bot*

*Commands:*
• Send phone (2547XXXXXXXX) - Generate payment link for KES 100
• /bulk [size] - Process donations from donors.csv
• /stats - View donation statistics
• /status [id] - Check donation status
• /link [id] - Get payment link for a donation
• /retry [id] - Retry failed donation
• /health - Check system status
• /test-auth - Test Pesapal authentication

*Examples:*
/bulk 5 - Process 5 donations at a time
/status DON_123456 - Check donation status
/link DON_123456 - Get payment link

*CSV Format:* phone,amount`;
      
      return bot.sendMessage(chatId, helpMessage, { parse_mode: 'Markdown' });
    }

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
          logger.error("Stats error:", err);
          return bot.sendMessage(chatId, "❌ Failed to fetch statistics");
        }
        
        const stats = 
`📊 *Donation Statistics*
Total: ${row.total || 0}
✅ Completed: ${row.completed || 0}
⏳ Pending: ${row.pending || 0}
❌ Failed: ${row.failed || 0}
💰 Total Amount: KES ${row.total_amount || 0}`;
        
        bot.sendMessage(chatId, stats, { parse_mode: 'Markdown' });
      });
      return;
    }

    if (text === "/health") {
      const health = await checkHealth();
      const statusIcon = health.database && health.pesapal ? "✅" : "⚠️";
      const message = 
`${statusIcon} *System Health*
• Database: ${health.database ? '✅' : '❌'}
• Pesapal: ${health.pesapal ? '✅' : '❌'}
• Environment: ${PESAPAL_ENV}
• API URL: ${BASE_URL}
• IPN ID: ${PESAPAL_IPN_ID || 'Not set'}
• Uptime: ${Math.floor(health.uptime / 60)} minutes`;
      
      bot.sendMessage(chatId, message, { parse_mode: 'Markdown' });
      return;
    }

    if (text === "/test-auth") {
      bot.sendMessage(chatId, "🔄 Testing Pesapal authentication...");
      
      const token = await getPesapalToken();
      
      if (token) {
        bot.sendMessage(chatId, 
          `✅ *Authentication Successful*\n\nToken: ${token.substring(0, 30)}...\nEnvironment: ${PESAPAL_ENV}`,
          { parse_mode: 'Markdown' }
        );
      } else {
        bot.sendMessage(chatId, "❌ *Authentication Failed*\n\nCheck your credentials.", { parse_mode: 'Markdown' });
      }
      return;
    }

    if (text.startsWith("/status")) {
      const args = text.split(' ');
      if (args.length < 2) {
        return bot.sendMessage(chatId, "❌ Please provide donation ID: /status DON_123456");
      }
      
      const donationId = args[1];
      
      db.get("SELECT * FROM donations WHERE id = ?", [donationId], async (err, row) => {
        if (err || !row) {
          return bot.sendMessage(chatId, "❌ Donation not found");
        }
        
        const message = 
`📋 *Donation Details*
ID: ${row.id}
Phone: ${row.phone}
Amount: KES ${row.amount}
Status: ${row.status}
Created: ${new Date(row.created_at).toLocaleString()}
${row.order_tracking_id ? `\nTracking ID: ${row.order_tracking_id}` : ''}
${row.error_message ? `\n❌ Error: ${row.error_message}` : ''}`;
        
        bot.sendMessage(chatId, message, { parse_mode: 'Markdown' });
      });
      return;
    }

    if (text.startsWith("/link")) {
      const args = text.split(' ');
      if (args.length < 2) {
        return bot.sendMessage(chatId, "❌ Please provide donation ID: /link DON_123456");
      }
      
      const donationId = args[1];
      
      db.get("SELECT * FROM donations WHERE id = ?", [donationId], async (err, row) => {
        if (err || !row) {
          return bot.sendMessage(chatId, "❌ Donation not found");
        }
        
        if (row.payment_link) {
          const message = 
`🔗 *Payment Link for ${donationId}*

${row.payment_link}

Share this link with the donor to complete payment.`;
          
          bot.sendMessage(chatId, message, { parse_mode: 'Markdown' });
        } else {
          bot.sendMessage(chatId, "❌ No payment link available for this donation");
        }
      });
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
        
        const result = await processDonation(row.phone, row.amount, donationId);
        
        if (result.success) {
          const message = 
`✅ *Payment Link Generated*

Donation: ${donationId}
Tracking ID: ${result.tracking_id}

🔗 *Payment Link:*
${result.payment_link}`;
          
          bot.sendMessage(chatId, message, { parse_mode: 'Markdown' });
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
            invalidRows.push({ row, reason: "Invalid phone (use 2547XXXXXXXX)" });
          } else if (!validateAmount(amount)) {
            invalidRows.push({ row, reason: `Amount must be 1-${MAX_AMOUNT}` });
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
          const links = [];

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
                  links.push({
                    phone: row.phone,
                    id: donationId,
                    link: result.payment_link
                  });
                } else {
                  failCount++;
                }
                
                await sleep(1500);
                
              } catch (err) {
                logger.error("Batch error:", err);
                failCount++;
              }
            }

            await bot.editMessageText(
              `📊 Progress: ${Math.min(i + customBatchSize, results.length)}/${results.length}\n✅ Success: ${successCount}\n❌ Failed: ${failCount}`,
              {
                chat_id: chatId,
                message_id: statusMsg.message_id
              }
            );
          }

          // Send summary
          const summaryMessage = 
`✅ *Bulk Processing Complete*

Total: ${results.length}
✅ Successful: ${successCount}
❌ Failed: ${failCount}
⚠️ Invalid: ${invalidRows.length}`;
          
          bot.sendMessage(chatId, summaryMessage, { parse_mode: 'Markdown' });
          
          // Send links in batches
          if (links.length > 0) {
            let linkMessage = "🔗 *Payment Links Generated*\n\n";
            links.forEach(item => {
              linkMessage += `📱 ${item.phone}\nID: ${item.id}\nLink: ${item.link}\n\n`;
            });
            
            // Split if too long (Telegram limit is 4096)
            if (linkMessage.length > 3500) {
              bot.sendMessage(chatId, `✅ Generated ${links.length} payment links. Use /link [id] to get individual links.`);
            } else {
              bot.sendMessage(chatId, linkMessage, { parse_mode: 'Markdown' });
            }
          }
        });
      
      return;
    }

    if (text && text.startsWith("254") && text.length === 12) {
      if (!validatePhone(text)) {
        return bot.sendMessage(chatId, "❌ Invalid phone. Use: 2547XXXXXXXX");
      }

      const donationId = generateDonationId();
      const amount = 100;

      bot.sendMessage(chatId, `🔄 Processing donation for ${text}...`);

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
            // Try to send DM to donor
            try {
              const donorMessage = 
`🤝 *Support Street Kids*

Thank you for your willingness to donate KES ${amount}!

🔗 Click this link to complete your payment:
${result.payment_link}

The link will expire in 30 minutes.`;
              
              await bot.sendMessage(text, donorMessage, { parse_mode: 'Markdown' });
              
              const ownerMessage = 
`✅ *Payment Link Sent*

📱 Phone: ${text}
💰 Amount: KES ${amount}
🆔 Donation ID: ${donationId}

The payment link has been sent to the donor via Telegram.`;
              
              bot.sendMessage(chatId, ownerMessage, { parse_mode: 'Markdown' });
              
            } catch (dmError) {
              // If can't send DM, send link to owner
              const ownerMessage = 
`✅ *Payment Link Generated*

📱 Phone: ${text}
💰 Amount: KES ${amount}
🆔 Donation ID: ${donationId}

🔗 *Payment Link:*
${result.payment_link}

Please share this link with the donor.`;
              
              bot.sendMessage(chatId, ownerMessage, { parse_mode: 'Markdown' });
            }
          } else {
            bot.sendMessage(chatId, 
              `❌ *Payment Initiation Failed*\n\nError: ${result.error}\nRetry with: /retry ${donationId}`,
              { parse_mode: 'Markdown' }
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

// ========== WEBHOOK ENDPOINTS ==========

/**
 * Payment callback (user returns here after payment)
 */
app.get("/payment-callback", async (req, res) => {
  try {
    const {
      order_tracking_id,
      order_merchant_reference,
      payment_status_description
    } = req.query;

    logger.info("Payment callback received:", req.query);

    const status = payment_status_description?.toLowerCase() === 'completed' ? 'COMPLETED' : 'PENDING';

    db.run(
      `UPDATE donations SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
      [status, order_merchant_reference],
      (err) => {
        if (err) {
          logger.error("Failed to update donation:", err);
        }
      }
    );

    // Send thank you page
    res.send(`
      <!DOCTYPE html>
      <html>
        <head>
          <title>Payment Status - Support Street Kids</title>
          <meta name="viewport" content="width=device-width, initial-scale=1">
          <style>
            body { font-family: Arial, sans-serif; text-align: center; padding: 50px 20px; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; }
            .card { background: white; color: #333; max-width: 500px; margin: 0 auto; padding: 30px; border-radius: 10px; box-shadow: 0 10px 30px rgba(0,0,0,0.2); }
            .success { color: #28a745; font-size: 48px; margin-bottom: 20px; }
            .pending { color: #ffc107; font-size: 48px; margin-bottom: 20px; }
            .btn { background: #667eea; color: white; padding: 12px 30px; text-decoration: none; border-radius: 5px; display: inline-block; margin-top: 20px; }
          </style>
        </head>
        <body>
          <div class="card">
            ${status === 'COMPLETED' 
              ? '<div class="success">✅</div><h1>Payment Successful!</h1><p>Thank you for supporting street kids.</p>'
              : '<div class="pending">⏳</div><h1>Payment Processing</h1><p>Your payment is being processed. You will receive a confirmation shortly.</p>'
            }
            <p>Reference: ${order_merchant_reference}</p>
            <p>Tracking ID: ${order_tracking_id}</p>
            <a href="https://t.me/streetskidsbot" class="btn">Return to Bot</a>
          </div>
        </body>
      </html>
    `);
  } catch (err) {
    logger.error("Callback error:", err);
    res.status(500).send("Error processing callback");
  }
});

/**
 * IPN webhook (asynchronous notifications from Pesapal)
 */
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
          ? `✅ Payment completed for ${OrderMerchantReference}\nTransaction: ${OrderTrackingId}`
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

// ========== HEALTH CHECK ==========

async function checkHealth() {
  const healthcheck = {
    uptime: process.uptime(),
    timestamp: Date.now(),
    database: false,
    pesapal: false,
    memory: `${Math.round(process.memoryUsage().heapUsed / 1024 / 1024)} MB`,
    ipn_id: PESAPAL_IPN_ID
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
  
  try {
    const token = await getPesapalToken();
    healthcheck.pesapal = !!token;
  } catch (err) {
    logger.error("Pesapal health check failed:", err);
  }
  
  return healthcheck;
}

// ========== EXPRESS ENDPOINTS ==========

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
    version: "3.2.0",
    status: "running",
    environment: PESAPAL_ENV,
    api_url: BASE_URL,
    ipn_id: PESAPAL_IPN_ID,
    timestamp: new Date().toISOString()
  });
});

// ---- ERROR HANDLING ----
app.use((err, req, res, next) => {
  logger.error("Unhandled error:", err);
  res.status(500).json({ error: "Internal server error" });
});

// ========== START SERVER ==========

const server = app.listen(PORT, '0.0.0.0', () => {
  logger.info(`✅ Server running on port ${PORT}`);
  logger.info(`🤖 Telegram webhook: ${webhookUrl}`);
  logger.info(`💰 Pesapal environment: ${PESAPAL_ENV}`);
  logger.info(`📡 Pesapal API URL: ${BASE_URL}`);
  logger.info(`📋 IPN ID: ${PESAPAL_IPN_ID}`);
  logger.info(`🔧 Test auth with: /test-auth`);
});

server.on('error', (error) => {
  logger.error("Server failed:", error.message);
  process.exit(1);
});

// ========== GRACEFUL SHUTDOWN ==========

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
