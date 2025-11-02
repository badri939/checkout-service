const axios = require('axios');
require('dotenv').config();
const express = require("express");
const bodyParser = require("body-parser");
const sendgrid = require("@sendgrid/mail");
const cors = require("cors");
const crypto = require('crypto');
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

function maskToken(token) {
  if (!token || typeof token !== 'string') return 'NO_TOKEN';
  if (token.length <= 8) return '****';
  return token.slice(0, 4) + '...' + token.slice(-4);
}
console.log("Using Strapi API Token:", maskToken(STRAPI_TOKEN));

// Middleware
app.use(cors(corsOptions));
app.use(bodyParser.json());

// Configure SendGrid
sendgrid.setApiKey(process.env.SENDGRID_API_KEY);

// Updated checkout route with new validation
// Map client payment values to Strapi enum values
function mapPaymentMethod(clientValue) {
  const clientToStrapi = {
    'credit-card': 'Card',
    'paypal': 'Paypal',
    'cod': 'Cash on Delivery'
  };
  
  const strapiToClient = {
    'Card': 'Card',
    'Paypal': 'Paypal',
    'Cash on Delivery': 'Cash on Delivery'
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

app.post("/api/checkout", async (req, res) => {
  try {
    const { cart, totalCost, name, address, paymentMethod, customerEmail, paymentId, idempotencyKey: bodyIdempotencyKey } = req.body;
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
  maskToken
};
