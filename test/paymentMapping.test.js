const { expect } = require('chai');

// require mapPaymentMethod from server
const { mapPaymentMethod } = require('../server');

describe('mapPaymentMethod', () => {
  it('maps credit-card to Card', () => {
    expect(mapPaymentMethod('credit-card')).to.equal('Card');
  });

  it('maps paypal to Paypal', () => {
    expect(mapPaymentMethod('paypal')).to.equal('Paypal');
  });

  it('maps cod to Cash on Delivery', () => {
    expect(mapPaymentMethod('cod')).to.equal('Cash on Delivery');
  });

  it('returns undefined for unknown method', () => {
    expect(mapPaymentMethod('bitcoin')).to.be.undefined;
  });

  // Test that Strapi values also work (bidirectional mapping)
  it('accepts Card and returns Card', () => {
    expect(mapPaymentMethod('Card')).to.equal('Card');
  });

  it('accepts Paypal and returns Paypal', () => {
    expect(mapPaymentMethod('Paypal')).to.equal('Paypal');
  });

  it('accepts Cash on Delivery and returns Cash on Delivery', () => {
    expect(mapPaymentMethod('Cash on Delivery')).to.equal('Cash on Delivery');
  });

  // Test Razorpay payment methods
  it('maps upi to UPI', () => {
    expect(mapPaymentMethod('upi')).to.equal('UPI');
  });

  it('maps netbanking to Net Banking', () => {
    expect(mapPaymentMethod('netbanking')).to.equal('Net Banking');
  });

  it('maps wallet to Wallet', () => {
    expect(mapPaymentMethod('wallet')).to.equal('Wallet');
  });

  it('maps razorpay to Razorpay', () => {
    expect(mapPaymentMethod('razorpay')).to.equal('Razorpay');
  });

  it('maps gpay to UPI', () => {
    expect(mapPaymentMethod('gpay')).to.equal('UPI');
  });

  it('accepts UPI and returns UPI', () => {
    expect(mapPaymentMethod('UPI')).to.equal('UPI');
  });
});
