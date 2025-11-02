const axios = require('axios');
require('dotenv').config();
const express = require("express");
const bodyParser = require("body-parser");
const sendgrid = require("@sendgrid/mail");
const cors = require("cors");
const crypto = require('crypto');
const Razorpay = require('razorpay');
const rateLimit = require('express-rate-limit');
const corsOptions = {
  origin: [
    "https://kaalikacreations.com",
    "https://ecom-kaalika-crea-git-1a95c1-badriraminindia-gmailcoms-projects.vercel.app",
    "https://ecom-kaalika-creations-m9q3-8tu8asl7u.vercel.app"// add your actual frontend domain here if different
  ],
  credentials: true
};

const app = express();
const PORT = 4000;
const STRAPI_TOKEN = process.env.STRAPI_API_TOKEN;
const STRAPI_BASE = process.env.STRAPI_BASE_URL || 'https://admin.kaalikacreations.com';

// Initialize Razorpay (only if credentials are provided)
let razorpay = null;
if (process.env.RAZORPAY_KEY_ID && process.env.RAZORPAY_KEY_SECRET) {
  razorpay = new Razorpay({
    key_id: process.env.RAZORPAY_KEY_ID,
    key_secret: process.env.RAZORPAY_KEY_SECRET,
  });
}

function maskToken(token) {
  if (!token || typeof token !== 'string') return 'NO_TOKEN';
  if (token.length <= 8) return '****';
  return token.slice(0, 4) + '...' + token.slice(-4);
}

// Security validation for environment variables
function validateEnvironment() {
  const requiredForProduction = [
    'STRAPI_API_TOKEN',
    'SENDGRID_API_KEY'
  ];
  
  const requiredForRazorpay = [
    'RAZORPAY_KEY_ID', 
    'RAZORPAY_KEY_SECRET'
  ];

  // Check if we're in production
  const isProduction = process.env.NODE_ENV === 'production';
  
  // Validate Strapi and SendGrid keys
  const missingRequired = requiredForProduction.filter(key => !process.env[key]);
  if (missingRequired.length > 0 && isProduction) {
    console.warn(`⚠️  Missing required environment variables: ${missingRequired.join(', ')}`);
  }

  // Check Razorpay configuration
  const hasRazorpayKeys = requiredForRazorpay.every(key => process.env[key]);
  if (!hasRazorpayKeys) {
    console.log("🔑 Razorpay not configured - payment features will be limited");
  } else {
    console.log("🔑 Razorpay configured:", maskToken(process.env.RAZORPAY_KEY_ID));
  }

  // Security warnings for weak configurations
  if (process.env.RAZORPAY_KEY_SECRET && process.env.RAZORPAY_KEY_SECRET.length < 10) {
    console.warn("⚠️  Razorpay secret appears too short - check configuration");
  }

  return {
    razorpayConfigured: hasRazorpayKeys,
    productionReady: missingRequired.length === 0
  };
}

const envStatus = validateEnvironment();
console.log("Using Strapi API Token:", maskToken(STRAPI_TOKEN));

// Security: Rate limiting
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // Limit each IP to 100 requests per windowMs
  message: {
    success: false,
    message: 'Too many requests from this IP, please try again later.'
  },
  standardHeaders: true,
  legacyHeaders: false,
});

const strictLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes  
  max: 10, // Limit payment endpoints to 10 requests per windowMs
  message: {
    success: false,
    message: 'Too many payment requests, please try again later.'
  }
});

// Middleware
app.use(limiter); // Apply rate limiting to all requests
app.use(cors(corsOptions));
app.use(bodyParser.json());

// Configure SendGrid
sendgrid.setApiKey(process.env.SENDGRID_API_KEY);

// Create Razorpay order
app.post("/api/create-order", strictLimiter, async (req, res) => {
  try {
    if (!razorpay) {
      return res.status(500).json({ 
        success: false, 
        message: "Razorpay not configured. Please set RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET." 
      });
    }

    const { amount, currency = "INR", receipt } = req.body;
    
    if (!amount) {
      return res.status(400).json({ success: false, message: "Amount is required" });
    }

    const options = {
      amount: amount * 100, // Razorpay expects amount in paise
      currency: currency,
      receipt: receipt || `receipt_${Date.now()}`,
    };

    const order = await razorpay.orders.create(options);
    
    res.json({
      success: true,
      order: {
        id: order.id,
        amount: order.amount,
        currency: order.currency,
        receipt: order.receipt
      }
    });
  } catch (error) {
    console.error("Order creation error:", error);
    res.status(500).json({ 
      success: false, 
      message: "Failed to create order",
      error: error.message 
    });
  }
});

// Updated checkout route with new validation
// Map client payment values to Strapi enum values (including Razorpay methods)
function mapPaymentMethod(clientValue) {
  const clientToStrapi = {
    'credit-card': 'Card',
    'debit-card': 'Card',
    'card': 'Card',
    'upi': 'UPI',
    'netbanking': 'Net Banking',
    'wallet': 'Wallet',
    'paypal': 'Paypal',
    'cod': 'Cash on Delivery',
    // Razorpay specific method names
    'razorpay': 'Razorpay',
    'gpay': 'UPI',
    'phonepe': 'UPI',
    'paytm': 'Wallet'
  };
  
  const strapiToClient = {
    'Card': 'Card',
    'UPI': 'UPI',
    'Net Banking': 'Net Banking',
    'Wallet': 'Wallet',
    'Paypal': 'Paypal',
    'Cash on Delivery': 'Cash on Delivery',
    'Razorpay': 'Razorpay'
  };
  
  // First try client-to-strapi mapping
  if (clientToStrapi[clientValue]) {
    return clientToStrapi[clientValue];
  }
  
  // If that fails, check if it's already a Strapi value
  if (strapiToClient[clientValue]) {
    return strapiToClient[clientValue];
  }
  
  return undefined;
}

// Helper: sleep for ms
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// Verify Razorpay payment signature
function verifyRazorpaySignature(orderId, paymentId, signature) {
  try {
    const text = orderId + "|" + paymentId;
    const expectedSignature = crypto
      .createHmac("sha256", process.env.RAZORPAY_KEY_SECRET)
      .update(text.toString())
      .digest("hex");
    
    return expectedSignature === signature;
  } catch (error) {
    console.error("Signature verification error:", error);
    return false;
  }
}

// Fetch payment details from Razorpay
async function fetchRazorpayPayment(paymentId) {
  if (!razorpay) {
    throw new Error("Razorpay not configured");
  }
  
  try {
    const payment = await razorpay.payments.fetch(paymentId);
    return payment;
  } catch (error) {
    console.error("Error fetching Razorpay payment:", error);
    throw error;
  }
}

// Determine if error is transient (network error or 5xx)
function isTransientError(err) {
  if (!err) return false;
  if (err.code && (err.code === 'ECONNABORTED' || err.code === 'ECONNRESET' || err.code === 'ENOTFOUND')) return true;
  if (err.response && err.response.status && err.response.status >= 500) return true;
  // treat no response as transient
  if (err.request && !err.response) return true;
  return false;
}

// Post to Strapi with retries/backoff
async function postToStrapi(payload, idempotencyKey, maxRetries = 3) {
  const base = process.env.STRAPI_BASE_URL || STRAPI_BASE;
  const url = `${base}/api/orders`;
  const headers = { Authorization: `Bearer ${STRAPI_TOKEN}` };
  if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;

  let attempt = 0;
  while (attempt <= maxRetries) {
    try {
      const resp = await axios.post(url, { data: payload }, { headers });
      return resp;
    } catch (err) {
      attempt++;
      const transient = isTransientError(err);
      // Mask-sensitive logs
      const maskedHeaders = Object.assign({}, (err.config && err.config.headers) || {});
      if (maskedHeaders && maskedHeaders.Authorization) maskedHeaders.Authorization = maskToken(maskedHeaders.Authorization);
      console.error(`Strapi post attempt ${attempt} error (masked headers):`, maskedHeaders);
      if (!transient || attempt > maxRetries) {
        // permanent or out of retries
        throw err;
      }
      // exponential backoff
      const backoff = 500 * Math.pow(2, attempt - 1);
      await sleep(backoff);
    }
  }
}

app.post("/api/checkout", strictLimiter, async (req, res) => {
  try {
    const { 
      cart, 
      totalCost, 
      name, 
      address, 
      paymentMethod, 
      customerEmail, 
      paymentId, 
      razorpayOrderId, 
      signature,
      idempotencyKey: bodyIdempotencyKey 
    } = req.body;
    let missing = [];
    if (!cart) missing.push("cart");
    if (!Array.isArray(cart)) missing.push("cart (must be an array)");
    if (typeof totalCost !== "number") missing.push("totalCost (must be a number)");
    if (!name) missing.push("name");
    if (!address) missing.push("address");
    if (!paymentMethod) missing.push("paymentMethod");
    if (missing.length > 0) {
      return res.status(400).json({ success: false, message: `Missing or invalid fields: ${missing.join(", ")}` });
    }

    // Map and validate payment method
    const mappedPayment = mapPaymentMethod(paymentMethod);
    if (!mappedPayment) {
      return res.status(400).json({ success: false, message: `Invalid paymentMethod: ${paymentMethod}` });
    }

    // Verify Razorpay payment if payment details are provided
    if (paymentId && razorpayOrderId && signature) {
      const isValidSignature = verifyRazorpaySignature(razorpayOrderId, paymentId, signature);
      if (!isValidSignature) {
        return res.status(400).json({ 
          success: false, 
          message: "Invalid payment signature. Payment verification failed." 
        });
      }

      // Optionally fetch payment details from Razorpay for additional verification
      try {
        const paymentDetails = await fetchRazorpayPayment(paymentId);
        if (paymentDetails.status !== 'captured' && paymentDetails.status !== 'authorized') {
          return res.status(400).json({ 
            success: false, 
            message: "Payment not successful. Please try again." 
          });
        }
        console.log("Payment verified successfully:", {
          paymentId: paymentDetails.id,
          status: paymentDetails.status,
          amount: paymentDetails.amount / 100, // Convert from paise to rupees
          method: paymentDetails.method
        });
      } catch (error) {
        console.error("Payment verification error:", error);
        return res.status(400).json({ 
          success: false, 
          message: "Unable to verify payment. Please contact support." 
        });
      }
    }

    // Idempotency key: prefer header, then body, else generate
    const headerIdempotencyKey = req.headers['idempotency-key'] || req.headers['Idempotency-Key'];
    const idempotencyKey = headerIdempotencyKey || bodyIdempotencyKey || crypto.randomBytes(16).toString('hex');

    // Debug: Log request payload (don't log tokens)
    console.log("Checkout request payload:", {
      customerEmail,
      customerName: name,
      cart,
      totalCost,
      address,
      paymentId,
      paymentMethod: mappedPayment,
      transactionStatus: "paid",
      idempotencyKey
    });

    // Save transaction details to Strapi (with retries)
    if (!STRAPI_TOKEN) {
      return res.status(500).json({ success: false, message: "Strapi API token not set." });
    }
    const payload = {
      customerEmail,
      customerName: name,
      cart,
      totalCost,
      address,
      paymentId,
      paymentMethod: mappedPayment,
      transactionStatus: "paid"
    };

    let strapiRes;
    try {
      strapiRes = await postToStrapi(payload, idempotencyKey, 3);
    } catch (err) {
      // Log masked information only
      if (err.response) {
        console.error("Strapi save error status:", err.response.status);
        console.error("Strapi save error data:", JSON.stringify(err.response.data, null, 2));
      } else {
        console.error("Strapi save error:", err.message);
      }
      return res.status(500).json({ success: false, message: "Failed to save order to Strapi.", error: err?.response?.data || err.message || err });
    }

    let orderId = null;
    if (strapiRes && strapiRes.data && strapiRes.data.data && strapiRes.data.data.id) {
      orderId = strapiRes.data.data.id;
    } else {
      orderId = Date.now(); // fallback if Strapi response is missing
    }

    res.json({
      success: true,
      orderId: orderId,
      redirectUrl: `/order/success?orderId=${orderId}`
    });
  } catch (error) {
    console.error("Checkout error:", error?.response?.data || error.message || error);
    res.status(500).json({ success: false, message: "Checkout failed.", error: error?.response?.data || error.message || error });
  }
});

// Razorpay webhook endpoint
app.post("/api/razorpay/webhook", async (req, res) => {
  try {
    const webhookSignature = req.headers['x-razorpay-signature'];
    const webhookBody = JSON.stringify(req.body);
    
    // Verify webhook signature
    const expectedSignature = crypto
      .createHmac('sha256', process.env.RAZORPAY_WEBHOOK_SECRET || process.env.RAZORPAY_KEY_SECRET)
      .update(webhookBody)
      .digest('hex');
    
    if (webhookSignature !== expectedSignature) {
      console.error("Invalid webhook signature");
      return res.status(400).json({ success: false, message: "Invalid signature" });
    }

    const event = req.body.event;
    const paymentEntity = req.body.payload.payment.entity;
    
    console.log("Razorpay webhook received:", {
      event: event,
      paymentId: paymentEntity.id,
      status: paymentEntity.status,
      amount: paymentEntity.amount / 100
    });

    // Handle different webhook events
    switch (event) {
      case 'payment.captured':
        // Payment was successfully captured
        console.log(`Payment captured: ${paymentEntity.id}`);
        break;
      case 'payment.failed':
        // Payment failed
        console.log(`Payment failed: ${paymentEntity.id}`);
        break;
      default:
        console.log(`Unhandled webhook event: ${event}`);
    }

    res.json({ success: true });
  } catch (error) {
    console.error("Webhook processing error:", error);
    res.status(500).json({ success: false, message: "Webhook processing failed" });
  }
});

// Custom checkout endpoint
app.post("/api/checkout/custom", async (req, res) => {
  try {
    const { email, items, total } = req.body;

    // 1. Process purchase logic here (e.g., validate items, calculate total, etc.)
    console.log("Processing order:", items, total);

    // 2. Send email notification
    const message = {
      to: email,
  from: "admin@kaalikacreations.com",
      subject: "Your Purchase Invoice",
      text: `Thank you for your purchase! Your total was $${total}.`,
      html: `<h3>Invoice</h3><p>Items: ${JSON.stringify(items)}</p><p>Total: $${total}</p>`,
    };

    await sendgrid.send(message);

    res.json({ success: true, message: "Checkout successful. Email sent." });
  } catch (error) {
    console.error("Error:", error);
    res.status(500).json({ success: false, message: "Checkout failed." });
  }
});
app.post("/api/send-invoice", async (req, res) => {
  try {
    const { recipient, subject, html } = req.body;
    if (!recipient || !subject || !html) {
      return res.status(400).json({ success: false, message: "Missing required fields." });
    }

    const message = {
      to: recipient,
      from: "admin@kaalikacreations.com", // Use your verified sender
      subject,
      html,
    };

    await sendgrid.send(message);

    res.json({ success: true, message: "Invoice sent." });
  } catch (error) {
    console.error("Send invoice error:", error);
    res.status(500).json({ success: false, message: "Failed to send invoice." });
  }
});
// Start server only when run directly
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`Checkout service running on http://localhost:${PORT}`);
  });
}

// Export for testing
module.exports = {
  app,
  mapPaymentMethod,
  postToStrapi,
  maskToken,
  verifyRazorpaySignature,
  fetchRazorpayPayment
};
