# Checkout Service with Razorpay Integration

A Node.js Express service that handles e-commerce checkout operations with Razorpay payment gateway integration.

## Features

- 🏦 **Razorpay Integration** - Complete payment processing with signature verification
- 🔄 **Payment Method Mapping** - Supports multiple payment methods (UPI, Cards, Wallets, etc.)
- ✅ **Payment Verification** - Secure signature validation and payment status checks
- 🎯 **Order Creation** - Create Razorpay orders before payment
- 🔔 **Webhook Support** - Handle Razorpay payment status updates
- 🛡️ **Security** - Payment signature verification and secure token handling
- 🔁 **Retry Logic** - Robust error handling with exponential backoff
- 📧 **Email Notifications** - SendGrid integration for order confirmations

## Environment Variables

Copy `.env.example` to `.env` and configure:

```bash
# Strapi Configuration
STRAPI_API_TOKEN=your_strapi_api_token_here
STRAPI_BASE_URL=https://admin.kaalikacreations.com

# SendGrid Configuration
SENDGRID_API_KEY=your_sendgrid_api_key_here

# Razorpay Configuration
RAZORPAY_KEY_ID=your_razorpay_key_id_here
RAZORPAY_KEY_SECRET=your_razorpay_key_secret_here
RAZORPAY_WEBHOOK_SECRET=your_razorpay_webhook_secret_here
```

## API Endpoints

### 1. Create Razorpay Order
**POST** `/api/create-order`

Creates a Razorpay order before payment initiation.

```json
{
  "amount": 100,
  "currency": "INR",
  "receipt": "receipt_123"
}
```

**Response:**
```json
{
  "success": true,
  "order": {
    "id": "order_xxxxx",
    "amount": 10000,
    "currency": "INR",
    "receipt": "receipt_123"
  }
}
```

### 2. Process Checkout
**POST** `/api/checkout`

Processes the complete checkout with payment verification.

```json
{
  "cart": [{"id": 1, "name": "Product", "price": 100}],
  "totalCost": 100,
  "name": "Customer Name",
  "address": "Customer Address",
  "paymentMethod": "upi",
  "customerEmail": "customer@example.com",
  "paymentId": "pay_xxxxx",
  "razorpayOrderId": "order_xxxxx",
  "signature": "signature_xxxxx"
}
```

### 3. Razorpay Webhook
**POST** `/api/razorpay/webhook`

Handles Razorpay webhook events for payment status updates.

## Payment Methods Supported

The service maps various payment method identifiers to standardized Strapi enum values:

| Frontend Value | Mapped To |
|----------------|-----------|
| `credit-card`, `debit-card`, `card` | `Card` |
| `upi`, `gpay`, `phonepe` | `UPI` |
| `netbanking` | `Net Banking` |
| `wallet`, `paytm` | `Wallet` |
| `razorpay` | `Razorpay` |
| `paypal` | `Paypal` |
| `cod` | `Cash on Delivery` |

## Payment Flow

1. **Create Order**: Call `/api/create-order` to generate a Razorpay order
2. **Frontend Payment**: Use Razorpay SDK on frontend with the order ID
3. **Process Checkout**: Send payment details to `/api/checkout` for verification
4. **Webhook Updates**: Receive real-time payment status via webhook

## Security Features

- **Signature Verification**: All payments are verified using Razorpay signature
- **Payment Status Check**: Additional verification by fetching payment details from Razorpay
- **Webhook Authentication**: Webhook requests are validated using signature
- **Token Masking**: Sensitive tokens are masked in logs

## Testing

Run the test suite:
```bash
npm test
```

Tests cover:
- Payment method mapping (15 test cases)
- Retry logic with exponential backoff
- Error handling scenarios

## Deployment

1. Set up environment variables in your hosting platform
2. Configure Razorpay webhook URL: `https://your-domain.com/api/razorpay/webhook`
3. Deploy the service
4. Test with Razorpay test credentials

## Error Handling

The service includes comprehensive error handling:
- Invalid payment signatures return 400 status
- Failed payment verification returns appropriate error messages
- Webhook processing errors are logged and handled gracefully
- Network failures use exponential backoff retry logic

## Development

```bash
# Install dependencies
npm install

# Run locally
npm start

# Run tests
npm test
```

The service runs on port 4000 by default.