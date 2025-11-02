# 🔐 Security Configuration Guide

## Environment Variables Security

### ❌ **NEVER DO THIS:**
```bash
# DON'T commit .env files to git
# DON'T hardcode keys in source code
# DON'T share keys in chat/email
# DON'T use production keys in development
```

### ✅ **DO THIS:**

#### 1. **Local Development (.env file)**
```bash
# Create .env file (already in .gitignore)
RAZORPAY_KEY_ID=rzp_test_your_key_here
RAZORPAY_KEY_SECRET=your_test_secret_here
```

#### 2. **Production Deployment (Render)**
- Go to Render Dashboard → Your Service → Environment
- Add variables one by one:
  ```
  RAZORPAY_KEY_ID=rzp_live_your_production_key
  RAZORPAY_KEY_SECRET=your_production_secret
  STRAPI_API_TOKEN=your_strapi_token
  SENDGRID_API_KEY=your_sendgrid_key
  NODE_ENV=production
  ```

#### 3. **Key Rotation Best Practices**
- **Rotate keys every 90 days**
- **Use different keys for test/production**
- **Monitor key usage in Razorpay dashboard**
- **Immediately rotate if compromised**

## 🛡️ **Security Features Implemented**

### 1. **Environment Validation**
- Validates required environment variables on startup
- Masks sensitive tokens in logs
- Warns about missing production configurations

### 2. **Rate Limiting**
- **General API**: 100 requests per 15 minutes per IP
- **Payment APIs**: 10 requests per 15 minutes per IP
- Prevents brute force attacks

### 3. **Payment Security**
- HMAC signature verification for all Razorpay payments
- Double verification: signature + payment status check
- Webhook signature validation
- Secure error handling (no sensitive data in errors)

### 4. **Access Control**
- CORS configured for specific domains only
- Webhook endpoints validate signatures
- No keys exposed in API responses

## 🚨 **Security Checklist**

### Before Going Live:
- [ ] Use **production** Razorpay keys (rzp_live_*)
- [ ] Set `NODE_ENV=production`
- [ ] Enable webhook signature validation
- [ ] Configure proper CORS origins
- [ ] Set up monitoring/alerts
- [ ] Test payment flow end-to-end

### Regular Security Maintenance:
- [ ] Monitor Razorpay dashboard for unusual activity
- [ ] Check server logs for failed authentication attempts
- [ ] Review and rotate API keys quarterly
- [ ] Keep dependencies updated (`npm audit`)

## 🔍 **Monitoring & Alerts**

### Set up alerts for:
- Multiple failed payment verification attempts
- Webhook signature validation failures
- Rate limit violations
- Environment variable access errors

### Log Analysis:
- Payment verification logs show masked keys only
- Failed authentication attempts are logged
- All webhook events are logged for audit

## 🆘 **Emergency Response**

### If Keys Are Compromised:
1. **Immediately disable** keys in Razorpay dashboard
2. **Generate new keys** in Razorpay
3. **Update environment variables** in Render
4. **Redeploy service** with new keys
5. **Monitor transactions** for unauthorized activity
6. **Review logs** to understand breach scope

## 📞 **Support Contacts**
- **Razorpay Support**: https://razorpay.com/support/
- **Render Support**: https://render.com/docs/support
- **Emergency**: Contact your system administrator immediately