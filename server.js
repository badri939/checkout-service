const axios = require('axios');
require('dotenv').config();
const express = require("express");
const bodyParser = require("body-parser");
const sendgrid = require("@sendgrid/mail");
const cors = require("cors");
const crypto = require('crypto');
const Razorpay = require('razorpay');
const rateLimit = require('express-rate-limit');
const fs = require('fs');
const path = require('path');
const corsOptions = {
  origin: [
    "https://kaalikacreations.com",
    "https://ecom-kaalika-crea-git-1a95c1-badriraminindia-gmailcoms-projects.vercel.app",
    "https://ecom-kaalika-creations-m9q3-8tu8asl7u.vercel.app"// add your actual frontend domain here if different
  ],
  credentials: true
};

const app = express();
const PORT = process.env.PORT || 4000;
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

// Trust proxy for Render deployment (fixes rate limiting behind reverse proxy)
app.set('trust proxy', 1);

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
// Capture raw body for webhook signature verification while still parsing JSON
app.use(bodyParser.json({
  verify: (req, res, buf) => {
    req.rawBody = buf;
  }
}));

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

    const { amount, currency = "INR", receipt, cart, customerEmail, customerName } = req.body;
    
    if (!amount) {
      return res.status(400).json({ success: false, message: "Amount is required" });
    }

    const options = {
      amount: amount * 100, // Razorpay expects amount in paise
      currency: currency,
      receipt: receipt || `receipt_${Date.now()}`,
    };

    const order = await razorpay.orders.create(options);
    
    // Create a provisional order in Strapi that includes the Razorpay order id
    // so webhooks can deterministically find and update the order later.
    const headerIdempotencyKey = req.headers['idempotency-key'] || req.headers['Idempotency-Key'];
    const idempotencyKey = headerIdempotencyKey || crypto.randomBytes(16).toString('hex');

    if (STRAPI_TOKEN) {
      const strapiPayload = {
        customerEmail: customerEmail || null,
        customerName: customerName || null,
        cart: cart || [],
        totalCost: amount,
        razorpayOrderId: order.id,
        transactionStatus: 'pending'
      };

      try {
        await postToStrapi(strapiPayload, idempotencyKey, 2);
        console.log('Provisional Strapi order created for Razorpay order', order.id);
      } catch (err) {
        // Don't fail the Razorpay order creation if Strapi write fails; log and continue
        console.error('Failed to create provisional Strapi order:', err?.response?.data || err.message || err);
      }
    } else {
      console.warn('STRAPI_API_TOKEN not set — skipping provisional Strapi order creation');
    }

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

// --- Persistent webhook dedupe store (Strapi-backed with local-file fallback) ---
const DATA_DIR = path.join(__dirname, 'data');
const WEBHOOK_STORE_FILE = path.join(DATA_DIR, 'processed_webhooks.json');
let processedWebhookSet = new Set();

function ensureDataDirSync() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  } catch (e) {
    // ignore
  }
}

function loadProcessedWebhooksSync() {
  try {
    ensureDataDirSync();
    if (fs.existsSync(WEBHOOK_STORE_FILE)) {
      const content = fs.readFileSync(WEBHOOK_STORE_FILE, 'utf8');
      const arr = JSON.parse(content || '[]');
      processedWebhookSet = new Set(Array.isArray(arr) ? arr : []);
    } else {
      fs.writeFileSync(WEBHOOK_STORE_FILE, JSON.stringify([]), 'utf8');
      processedWebhookSet = new Set();
    }
  } catch (err) {
    console.error('Could not load processed webhooks file, starting with empty set:', err.message || err);
    processedWebhookSet = new Set();
  }
}

async function persistProcessedWebhooks() {
  try {
    ensureDataDirSync();
    await fs.promises.writeFile(WEBHOOK_STORE_FILE, JSON.stringify([...processedWebhookSet]), 'utf8');
  } catch (err) {
    console.error('Failed to persist processed webhooks file:', err.message || err);
  }
}

/**
 * Check whether a webhook with the given eventId has already been processed.
 * First tries to query Strapi `webhook-events` (if STRAPI_TOKEN present), else falls back to local file.
 */
async function isWebhookProcessed(eventId) {
  if (!eventId) return false;
  // Try Strapi first
  if (STRAPI_TOKEN) {
    try {
      const headers = { Authorization: `Bearer ${STRAPI_TOKEN}` };
      const url = `${STRAPI_BASE}/api/webhook-events?filters[eventId][$eq]=${encodeURIComponent(eventId)}`;
      const resp = await axios.get(url, { headers });
      if (resp.data && resp.data.data && resp.data.data.length > 0) return true;
    } catch (err) {
      // If Strapi doesn't have the content-type or is unavailable, fallback to local store
      console.log('Strapi webhook-events lookup failed or not available, falling back to local webhook store');
    }
  }
  return processedWebhookSet.has(eventId);
}

/**
 * Mark a webhook as processed. Attempts to create a Strapi `webhook-events` record first,
 * and falls back to a local file-based store if that fails.
 */
async function markWebhookProcessed(eventId, rawEvent) {
  if (!eventId) return;
  if (STRAPI_TOKEN) {
    try {
      const headers = { Authorization: `Bearer ${STRAPI_TOKEN}` };
      const payload = {
        eventId,
        receivedAt: new Date().toISOString(),
        payload: rawEvent
      };
      await axios.post(`${STRAPI_BASE}/api/webhook-events`, { data: payload }, { headers });
      return;
    } catch (err) {
      console.log('Creating Strapi webhook-event failed, will persist locally instead');
    }
  }

  // Local fallback
  try {
    processedWebhookSet.add(eventId);
    await persistProcessedWebhooks();
  } catch (err) {
    console.error('Failed to mark webhook as processed in local store:', err.message || err);
  }
}

// Load local processed webhook IDs on startup
loadProcessedWebhooksSync();


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
// Razorpay webhook endpoint — verifies signature from raw body, updates Strapi order and decrements stock
app.post("/api/razorpay/webhook", async (req, res) => {
  try {
    const signatureHeader = req.headers['x-razorpay-signature'];
    const rawBody = req.rawBody || Buffer.from(JSON.stringify(req.body));

    console.log('📥 Webhook received:', {
      hasSignature: !!signatureHeader,
      headers: Object.keys(req.headers),
      bodyPreview: req.body?.event || 'unknown'
    });

    if (!signatureHeader) {
      console.error('❌ Missing razorpay signature header');
      console.error('   This might be a test webhook or Razorpay test mode issue');
      console.error('   Headers received:', Object.keys(req.headers));
      
      // For test mode, we might want to proceed anyway (security risk in production!)
      if (process.env.NODE_ENV !== 'production') {
        console.warn('⚠️  DEVELOPMENT MODE: Proceeding without signature verification (NOT SAFE FOR PRODUCTION!)');
        // Continue processing without signature check
      } else {
        return res.status(400).json({ success: false, message: 'Missing signature' });
      }
    }

    // Verify signature if present
    if (signatureHeader) {
      const expected = crypto
        .createHmac('sha256', process.env.RAZORPAY_WEBHOOK_SECRET || process.env.RAZORPAY_KEY_SECRET)
        .update(rawBody)
        .digest('hex');

      // timing-safe comparison
      const sigBuf = Buffer.from(signatureHeader);
      const expBuf = Buffer.from(expected);
      if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) {
        console.error('❌ Invalid webhook signature');
        console.error('   Expected length:', expBuf.length, 'Got:', sigBuf.length);
        return res.status(400).json({ success: false, message: 'Invalid signature' });
      }
      console.log('✅ Webhook signature verified');
    }

    const event = JSON.parse(rawBody.toString());
    const eventName = event.event;
    const paymentEntity = event.payload && event.payload.payment && event.payload.payment.entity;
    if (!paymentEntity) {
      console.log('Webhook received with no payment entity');
      return res.status(200).json({ success: true });
    }

    // Use a stable dedupe key: prefer a provider-supplied event id, else fall back to eventType:paymentId
    const dedupeId = event.id || `${eventName}:${paymentEntity.id}`;
    try {
      if (await isWebhookProcessed(dedupeId)) {
        console.log('Duplicate webhook ignored:', dedupeId);
        return res.status(200).json({ success: true, duplicate: true });
      }
    } catch (err) {
      console.error('Error checking webhook dedupe store, continuing processing:', err?.message || err);
    }

    console.log('Razorpay webhook received:', { event: eventName, paymentId: paymentEntity.id, status: paymentEntity.status });

    // Helper: find order in Strapi by paymentId or razorpay order id
    async function findStrapiOrderByPayment(paymentId, razorpayOrderId) {
      const base = STRAPI_BASE;
      const headers = { Authorization: `Bearer ${STRAPI_TOKEN}` };
      try {
        // Try by paymentId
        if (paymentId) {
          const url = `${base}/api/orders?filters[paymentId][$eq]=${paymentId}&populate=deep`;
          const resp = await axios.get(url, { headers });
          if (resp.data && resp.data.data && resp.data.data.length > 0) return resp.data.data[0];
        }
        // Try by razorpay order id
        if (razorpayOrderId) {
          const url2 = `${base}/api/orders?filters[razorpayOrderId][$eq]=${razorpayOrderId}&populate=deep`;
          const resp2 = await axios.get(url2, { headers });
          if (resp2.data && resp2.data.data && resp2.data.data.length > 0) return resp2.data.data[0];
        }
      } catch (err) {
        console.error('Error searching Strapi for order:', err?.response?.data || err.message || err);
      }
      return null;
    }

    // Helper: update product stock in Strapi if product field exists
    async function decrementProductStock(productId, qty) {
      const headers = { Authorization: `Bearer ${STRAPI_TOKEN}` };
      try {
        const url = `${STRAPI_BASE}/api/products/${productId}?populate=deep`;
        const resp = await axios.get(url, { headers });
        const product = resp.data && resp.data.data;
        if (!product) return false;
        const attrs = product.attributes || {};
        // common stock field names
        const stockFields = ['stock', 'quantity', 'inventory', 'available'];
        let fieldName = null;
        for (const f of stockFields) {
          if (typeof attrs[f] === 'number') {
            fieldName = f;
            break;
          }
        }
        if (!fieldName) {
          console.log(`No numeric stock field found on product ${productId}`);
          return false;
        }
        const current = attrs[fieldName];
        const updated = Math.max(0, current - qty);
        const patchUrl = `${STRAPI_BASE}/api/products/${productId}`;
        await axios.put(patchUrl, { data: { [fieldName]: updated } }, { headers });
        console.log(`Product ${productId} stock updated: ${current} -> ${updated}`);
        return true;
      } catch (err) {
        console.error('Error decrementing product stock:', err?.response?.data || err.message || err);
        return false;
      }
    }

  // --- Razorpay Invoices integration ---
  const RAZORPAY_API_BASE = process.env.RAZORPAY_API_BASE || 'https://api.razorpay.com';

  /**
   * Create a Razorpay Invoice for a captured payment and (best-effort) ask Razorpay
   * to send the invoice to the customer via email.
   * - Uses basic auth with RAZORPAY_KEY_ID:RAZORPAY_KEY_SECRET
   * - Attaches invoice id / url back to Strapi order when possible
   */
  async function createAndSendRazorpayInvoice({ strapiOrder, paymentEntity }) {
    if (!process.env.RAZORPAY_KEY_ID || !process.env.RAZORPAY_KEY_SECRET) {
      console.log('⚠️  Razorpay keys not configured; skipping invoice creation');
      return null;
    }

    // Helper: Sanitize customer name for Razorpay (only letters, spaces, dots, hyphens)
    function sanitizeName(name) {
      if (!name) return null;
      const cleaned = name
        .replace(/[^\p{L}\s\.\-']/gu, '')
        .trim()
        .substring(0, 100);
      
      if (cleaned.length < 3 || /^\s*$/.test(cleaned)) {
        return null;
      }
      return cleaned;
    }

    // Build customer info
    const rawName = (strapiOrder && (strapiOrder.attributes && strapiOrder.attributes.customerName)) || paymentEntity.name || paymentEntity.contact || null;
    const sanitizedName = sanitizeName(rawName);
    
    const customer = {
      email: (strapiOrder && (strapiOrder.attributes && strapiOrder.attributes.customerEmail)) || paymentEntity.email || null,
      contact: paymentEntity.contact || null
    };
    
    if (sanitizedName) {
      customer.name = sanitizedName;
    } else if (rawName) {
      console.warn('⚠️  Customer name invalid for Razorpay:', rawName, '- proceeding without name');
    }

    // Build cart items
    let cartItems = [];
    try {
      const cart = (strapiOrder && (strapiOrder.attributes && strapiOrder.attributes.cart)) || [];
      if (Array.isArray(cart) && cart.length > 0) {
        for (const item of cart) {
          const name = item.name || (item.product && item.product.attributes && item.product.attributes.title) || 'Item';
          const qty = item.quantity || item.qty || 1;
          const unit_cost = Math.round(((item.price || item.unitPrice || item.unit_cost || 0) * 100));
          cartItems.push({ name, quantity: qty, unit_cost });
        }
      }
    } catch (err) {
      console.warn('Could not build cart items from Strapi order, falling back to total');
      cartItems = [];
    }

    // Fallback
    if (cartItems.length === 0) {
      const total = ((paymentEntity.amount || 0) / 100) || ((strapiOrder && strapiOrder.attributes && strapiOrder.attributes.totalCost) || 0);
      cartItems = [{ name: 'Order Total', quantity: 1, unit_cost: Math.round(total * 100) }];
    }

    const auth = { username: process.env.RAZORPAY_KEY_ID, password: process.env.RAZORPAY_KEY_SECRET };

    try {
      // Step 1: Create Razorpay Items (so we have item_id for the invoice)
      console.log('📦 Creating Razorpay items for invoice...');
      const createdItems = [];
      
      for (const cartItem of cartItems) {
        try {
          const itemPayload = {
            name: cartItem.name,
            amount: cartItem.unit_cost,
            currency: paymentEntity.currency || 'INR',
            description: `Item for invoice`
          };
          
          const itemResp = await axios.post(`${RAZORPAY_API_BASE}/v1/items`, itemPayload, { auth });
          if (itemResp && itemResp.data && itemResp.data.id) {
            createdItems.push({
              item_id: itemResp.data.id,
              quantity: cartItem.quantity
            });
            console.log('✅ Created Razorpay item:', itemResp.data.id, '-', cartItem.name);
          }
        } catch (itemErr) {
          console.error('❌ Failed to create Razorpay item:', cartItem.name, itemErr?.response?.data || itemErr.message);
          // Fallback: use inline item without item_id (may fail but worth trying)
          createdItems.push({
            name: cartItem.name,
            amount: cartItem.unit_cost,
            currency: paymentEntity.currency || 'INR',
            quantity: cartItem.quantity
          });
        }
      }

      if (createdItems.length === 0) {
        console.error('❌ No items created - cannot generate invoice');
        return null;
      }

      // Step 2: Create invoice with item_id references
      const invoicePayload = {
        type: 'invoice',
        customer: customer,
        line_items: createdItems,
        currency: paymentEntity.currency || 'INR',
        description: `Invoice for Payment ${paymentEntity.id}`,
        email_notify: 1,
        sms_notify: 0
      };

      console.log('📄 Creating Razorpay invoice with', createdItems.length, 'items...');
      const resp = await axios.post(`${RAZORPAY_API_BASE}/v1/invoices`, invoicePayload, { auth });
      
      if (resp && resp.data) {
        const invoice = resp.data;
        console.log('✅ Razorpay invoice created:', invoice.id);

        // Update Strapi order with invoice info
        try {
          if (strapiOrder && process.env.STRAPI_API_TOKEN) {
            const orderId = strapiOrder.id || (strapiOrder.data && strapiOrder.data.id);
            if (orderId) {
              const update = { 
                razorpayInvoiceId: invoice.id, 
                razorpayInvoiceUrl: invoice.short_url || null,
                invoiceSentAt: new Date().toISOString()
              };
              await axios.put(`${STRAPI_BASE}/api/orders/${orderId}`, { data: update }, { headers: { Authorization: `Bearer ${process.env.STRAPI_API_TOKEN}` } });
              console.log('✅ Attached invoice info to Strapi order', orderId);
            }
          }
        } catch (err) {
          console.error('❌ Failed to attach invoice info to Strapi order:', err?.response?.data || err.message || err);
        }

        return invoice;
      }
    } catch (err) {
      console.error('❌ Error creating Razorpay invoice:', err?.response?.data || err.message || err);
      if (err.response?.data?.error) {
        console.error('   Razorpay error code:', err.response.data.error.code);
        console.error('   Razorpay error description:', err.response.data.error.description);
      }
      return null;
    }
  }

    const paymentId = paymentEntity.id;
    const rzpOrderId = paymentEntity.order_id;
    const status = paymentEntity.status;

    // Find existing order in Strapi
    let strapiOrder = null;
    if (STRAPI_TOKEN) {
      strapiOrder = await findStrapiOrderByPayment(paymentId, rzpOrderId);
    }

    // If order exists, update status; else create a new order record in Strapi
    if (strapiOrder) {
      const orderId = strapiOrder.id;
      const updatePayload = {
        transactionStatus: status === 'captured' ? 'paid' : status,
        paymentId: paymentId,
        razorpayOrderId: rzpOrderId
      };
      try {
        const url = `${STRAPI_BASE}/api/orders/${orderId}`;
        await axios.put(url, { data: updatePayload }, { headers: { Authorization: `Bearer ${STRAPI_TOKEN}` } });
        console.log(`Strapi order ${orderId} updated with payment status ${status}`);

        // If payment captured, decrement stock for items in order.cart
        if (status === 'captured') {
          const cart = (strapiOrder.attributes && strapiOrder.attributes.cart) || strapiOrder.cart || [];
          for (const item of cart) {
            const productId = item.productId || (item.product && item.product.id) || item.product_id;
            const quantity = item.quantity || item.qty || 1;
            if (productId) {
              await decrementProductStock(productId, quantity);
            }
          }
          // Create and send Razorpay invoice (best-effort)
          try {
            console.log('📄 Attempting to create Razorpay invoice for order', orderId);
            const invoice = await createAndSendRazorpayInvoice({ strapiOrder, paymentEntity });
            if (invoice) {
              console.log('✅ Invoice created successfully:', invoice.id, '- URL:', invoice.short_url);
            } else {
              console.warn('⚠️  Invoice creation returned null - check logs above for errors');
            }
          } catch (err) {
            console.error('❌ Invoice creation failed (non-fatal):', err?.response?.data || err.message || err);
          }
        }
      } catch (err) {
        console.error('Failed to update Strapi order:', err?.response?.data || err.message || err);
      }
    } else if (STRAPI_TOKEN) {
      // Create a minimal order record in Strapi with payment details
      const payload = {
        customerEmail: paymentEntity.email || null,
        customerName: paymentEntity.contact || null,
        cart: [],
        totalCost: (paymentEntity.amount || 0) / 100,
        paymentId: paymentId,
        razorpayOrderId: rzpOrderId,
        transactionStatus: status === 'captured' ? 'paid' : status
      };
      try {
        const resp = await postToStrapi(payload, null, 2);
        console.log('Created Strapi order from webhook payment');
        // Try to create/send invoice using the newly created order
        try {
          const createdOrder = (resp && resp.data && resp.data.data) ? resp.data.data : null;
          console.log('📄 Attempting to create Razorpay invoice for newly created order');
          const invoice = await createAndSendRazorpayInvoice({ strapiOrder: createdOrder, paymentEntity });
          if (invoice) {
            console.log('✅ Invoice created for payment (new order):', invoice.id, '- URL:', invoice.short_url);
          } else {
            console.warn('⚠️  Invoice creation returned null - check logs above for errors');
          }
        } catch (err) {
          console.error('❌ Invoice creation after order create failed (non-fatal):', err?.response?.data || err.message || err);
        }
      } catch (err) {
        console.error('Failed to create Strapi order from webhook:', err?.response?.data || err.message || err);
      }
    }

    // Mark event as processed (best-effort) to prevent duplicate processing on retries
    try {
      await markWebhookProcessed(dedupeId, event);
    } catch (err) {
      console.error('Failed to mark webhook processed (non-fatal):', err?.message || err);
    }

    res.json({ success: true });
  } catch (error) {
    console.error('Webhook processing error:', error?.response?.data || error.message || error);
    res.status(500).json({ success: false, message: 'Webhook processing failed' });
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
