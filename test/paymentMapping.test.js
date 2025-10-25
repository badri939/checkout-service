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
});
