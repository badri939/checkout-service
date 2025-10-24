const axios = require('axios');
require('dotenv').config();
const express = require("express");
const bodyParser = require("body-parser");
const sendgrid = require("@sendgrid/mail");
const cors = require("cors");
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
const strapiToken = process.env.STRAPI_API_TOKEN;
console.log("Using Strapi API Token:", strapiToken);

// Middleware
app.use(cors(corsOptions));
app.use(bodyParser.json());

// Configure SendGrid
sendgrid.setApiKey(process.env.SENDGRID_API_KEY);

// Updated checkout route with new validation
app.post("/api/checkout", async (req, res) => {
  try {
    const { cart, totalCost, name, address, paymentMethod, customerEmail, paymentId } = req.body;
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

    // Debug: Log request payload
    console.log("Checkout request payload:", {
      customerEmail,
      customerName: name,
      cart,
      totalCost,
      address,
      paymentId,
      paymentMethod,
      transactionStatus: "paid"
    });

    // Save transaction details to Strapi
    const strapiToken = process.env.STRAPI_API_TOKEN;
    console.log("Using Strapi API Token:", strapiToken);
    if (!strapiToken) {
      return res.status(500).json({ success: false, message: "Strapi API token not set." });
    }
    let strapiRes;
    try {
      strapiRes = await axios.post(
        "https://admin.kaalikacreations.com/api/orders",
        {
          data: {
            customerEmail,
            customerName: name,
            cart,
            totalCost,
            address,
            paymentId,
            paymentMethod,
            transactionStatus: "paid"
          }
        },
        { headers: { Authorization: `Bearer ${strapiToken}` } }
      );
    } catch (err) {
      // Debug: Log full error response from Strapi
      if (err.response) {
        console.error("Strapi save error status:", err.response.status);
        console.error("Strapi save error data:", JSON.stringify(err.response.data, null, 2));
        console.error("Strapi save error headers:", err.response.headers);
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
// Start server
app.listen(PORT, () => {
  console.log(`Checkout service running on http://localhost:${PORT}`);
});
