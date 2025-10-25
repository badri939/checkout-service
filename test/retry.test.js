const { expect } = require('chai');
const nock = require('nock');

// Set env before requiring server so STRAPI_BASE and token are picked up
process.env.STRAPI_API_TOKEN = 'testtoken';
process.env.STRAPI_BASE_URL = 'http://strapi.test';

const { postToStrapi } = require('../server');

describe('postToStrapi retry/backoff', function () {
  afterEach(() => {
    nock.cleanAll();
  });

  it('retries on transient 500 and succeeds', async function () {
    const scope = nock('http://strapi.test')
      .post('/api/orders')
      .reply(500, { error: 'server error' })
      .post('/api/orders')
      .reply(200, { data: { id: 42 } });

    const payload = { foo: 'bar' };
    const res = await postToStrapi(payload, 'idem-key-test', 3);
    expect(res).to.have.property('data');
    expect(res.data).to.have.property('data');
    expect(res.data.data.id).to.equal(42);
    expect(scope.isDone()).to.be.true;
  });

  it('gives up after max retries and throws', async function () {
    const scope = nock('http://strapi.test')
      .post('/api/orders')
      .times(3)
      .reply(500, { error: 'server error' });

    const payload = { foo: 'bar' };
    let thrown = false;
    try {
      await postToStrapi(payload, 'idem-key-test', 2);
    } catch (err) {
      thrown = true;
      expect(err).to.exist;
    }
    expect(thrown).to.be.true;
    expect(scope.isDone()).to.be.true;
  });
});
