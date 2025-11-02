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
});
