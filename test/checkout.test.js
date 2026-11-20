'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const Stripe = require('stripe');
const checkout = require('../lib/checkout');

test('portal amount accepts dollars and cents inside the limits', () => {
  assert.deepEqual(checkout.parseAmountToCents('25'), { unitAmount: 2500 });
  assert.deepEqual(checkout.parseAmountToCents('$1,000.50'), { unitAmount: 100050 });
  assert.deepEqual(checkout.parseAmountToCents(1), { unitAmount: 100 });
  assert.deepEqual(checkout.parseAmountToCents('10000'), { unitAmount: 1_000_000 });
});

test('portal amount rejects values under $1, over $10,000, and extra decimals', () => {
  assert.equal(checkout.parseAmountToCents('0.50').error, 'Minimum payment is $1.00.');
  assert.equal(checkout.parseAmountToCents('10000.01').error, 'Maximum payment is $10,000.00.');
  assert.match(checkout.parseAmountToCents('10.999').error, /two decimal places/);
  assert.match(checkout.parseAmountToCents('25abc').error, /dollar amount|two decimal/);
  assert.match(checkout.parseAmountToCents('').error, /dollar amount/);
});

test('legacy checkout keeps the $0.50 minimum and the same maximum', () => {
  const parsed = checkout.parseAmountToCents('0.50', { minCents: checkout.LEGACY_MIN_CENTS });
  assert.equal(parsed.unitAmount, 50);
  assert.match(checkout.parseAmountToCents('0.49', { minCents: 50 }).error, /\$0\.50/);
});

test('notes are sanitized and length limited', () => {
  assert.deepEqual(checkout.sanitizeNote('  Studio <b>invoice</b>\nMarch  '), { note: 'Studio invoice March' });
  assert.deepEqual(checkout.sanitizeNote(''), { note: '' });
  assert.match(checkout.sanitizeNote('a'.repeat(201)).error, /200/);
  assert.match(checkout.sanitizeNote(12).error, /text/);
});

test('email is optional and checked', () => {
  assert.deepEqual(checkout.normalizeEmail(''), { email: undefined });
  assert.deepEqual(checkout.normalizeEmail(' payer@example.com '), { email: 'payer@example.com' });
  assert.match(checkout.normalizeEmail('not-an-email').error, /email/);
});

test('embedded session params omit payment method types and carry the note', () => {
  const params = checkout.buildEmbeddedSessionParams({
    unitAmount: 2500,
    note: 'March retainer',
    email: 'payer@example.com',
    returnUrl: 'https://nightshift-collective.onrender.com/pay/return?session_id={CHECKOUT_SESSION_ID}',
  });
  assert.equal(params.ui_mode, 'embedded_page');
  assert.equal(params.payment_method_types, undefined);
  assert.equal(params.metadata.note, 'March retainer');
  assert.equal(params.line_items[0].price_data.product_data.description, 'March retainer');
  assert.equal(params.customer_email, 'payer@example.com');
  assert.equal(params.payment_intent_data.receipt_email, 'payer@example.com');
  assert.equal(params.return_url.includes('{CHECKOUT_SESSION_ID}'), true);
});

test('checkout outcomes distinguish success, processing, failure, and an open session', () => {
  assert.equal(checkout.checkoutOutcome({ payment_status: 'paid', status: 'complete' }), 'success');
  assert.equal(
    checkout.checkoutOutcome({
      payment_status: 'unpaid',
      status: 'complete',
      payment_intent: { status: 'processing' },
    }),
    'processing'
  );
  assert.equal(
    checkout.checkoutOutcome({
      payment_status: 'unpaid',
      status: 'complete',
      payment_intent: { status: 'canceled' },
    }),
    'failed'
  );
  assert.equal(checkout.checkoutOutcome({ payment_status: 'unpaid', status: 'expired' }), 'failed');
  assert.equal(checkout.checkoutOutcome({ payment_status: 'unpaid', status: 'open' }), 'incomplete');
});

test('webhook summary fulfills only paid sessions and keeps the note', () => {
  const paid = checkout.summarizeCheckoutEvent({
    id: 'evt_1',
    type: 'checkout.session.completed',
    data: {
      object: {
        id: 'cs_test_123',
        amount_total: 2500,
        currency: 'usd',
        payment_status: 'paid',
        metadata: { note: 'March retainer' },
      },
    },
  });
  assert.equal(paid.fulfill, true);
  assert.equal(paid.note, 'March retainer');
  assert.equal(paid.amountTotal, 2500);

  const waiting = checkout.summarizeCheckoutEvent({
    id: 'evt_2',
    type: 'checkout.session.completed',
    data: { object: { id: 'cs_test_456', amount_total: 5000, currency: 'usd', payment_status: 'unpaid' } },
  });
  assert.equal(waiting.fulfill, false);

  const failed = checkout.summarizeCheckoutEvent({
    id: 'evt_3',
    type: 'checkout.session.async_payment_failed',
    data: { object: { id: 'cs_test_789', amount_total: 5000, payment_status: 'unpaid', metadata: { note: 'ACH' } } },
  });
  assert.equal(failed.failed, true);
  assert.equal(failed.fulfill, false);
  assert.equal(failed.note, 'ACH');
});

function listen(app) {
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => resolve(server));
  });
}

function request(server, { method = 'GET', path = '/', headers = {}, body }) {
  return new Promise((resolve, reject) => {
    const payload = body == null ? null : Buffer.from(body);
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port: server.address().port,
        method,
        path,
        headers: {
          ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': payload.length } : {}),
          ...headers,
        },
      },
      (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let json = null;
          try { json = JSON.parse(text); } catch (err) { json = null; }
          resolve({ status: res.statusCode, headers: res.headers, text, json });
        });
      }
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

test('pay routes render the amount page and the catch-all still serves the homepage', async () => {
  process.env.STRIPE_PUBLISHABLE_KEY = '';
  const { createApp } = require('../server');
  const server = await listen(createApp());
  try {
    const pay = await request(server, { path: '/pay' });
    assert.equal(pay.status, 200);
    assert.match(pay.text, /Dollar amount/);
    assert.match(pay.headers['content-security-policy'], /js\.stripe\.com/);

    const ret = await request(server, { path: '/pay/return' });
    assert.equal(ret.status, 200);
    assert.match(ret.text, /id="status-panel"/);

    const home = await request(server, { path: '/' });
    assert.equal(home.status, 200);
    assert.match(home.text, /Payments & Tools/);
    assert.match(home.text, /href="\/pay"/);
    assert.doesNotMatch(home.text, /Dollar amount/);
  } finally {
    server.close();
  }
});

test('checkout creation validates on the server and fails clearly without a secret key', async () => {
  delete process.env.STRIPE_SECRET_KEY;
  process.env.STRIPE_PUBLISHABLE_KEY = 'pk_test_example';
  const { createApp } = require('../server');
  const server = await listen(createApp());
  try {
    const low = await request(server, {
      method: 'POST',
      path: '/api/checkout-session',
      headers: { 'X-Forwarded-For': '203.0.113.10' },
      body: JSON.stringify({ amount: '0.25', note: '<b>hi</b>', email: 'a@b.com' }),
    });
    assert.equal(low.status, 400);
    assert.match(low.json.error, /\$1\.00/);

    const decimals = await request(server, {
      method: 'POST',
      path: '/api/checkout-session',
      headers: { 'X-Forwarded-For': '203.0.113.11' },
      body: JSON.stringify({ amount: '12.345' }),
    });
    assert.equal(decimals.status, 400);

    const ready = await request(server, {
      method: 'POST',
      path: '/api/checkout-session',
      headers: { 'X-Forwarded-For': '203.0.113.12' },
      body: JSON.stringify({ amount: '25.00', note: 'Retainer', email: 'payer@example.com' }),
    });
    assert.equal(ready.status, 503);
    assert.match(ready.json.error, /STRIPE_SECRET_KEY/);

    const legacy = await request(server, {
      method: 'POST',
      path: '/create-checkout',
      headers: { 'X-Forwarded-For': '203.0.113.13' },
      body: JSON.stringify({ amount: '0.50' }),
    });
    assert.equal(legacy.status, 503);
    assert.match(legacy.json.error, /STRIPE_SECRET_KEY/);

    const config = await request(server, { path: '/api/config' });
    assert.equal(config.status, 200);
    assert.equal(config.json.publishableKey, 'pk_test_example');
    assert.equal(config.json.secret, undefined);
  } finally {
    server.close();
  }
});

test('status endpoint rejects a bad session id and rate limits repeated checkout attempts', async () => {
  delete process.env.STRIPE_SECRET_KEY;
  const { createApp } = require('../server');
  const server = await listen(createApp());
  try {
    const bad = await request(server, {
      path: '/api/checkout-session/status?session_id=not-a-session',
      headers: { 'X-Forwarded-For': '203.0.113.20' },
    });
    assert.equal(bad.status, 400);

    let last;
    for (let i = 0; i < 11; i += 1) {
      last = await request(server, {
        method: 'POST',
        path: '/api/checkout-session',
        headers: { 'X-Forwarded-For': '203.0.113.21' },
        body: JSON.stringify({ amount: 'nope' }),
      });
    }
    assert.equal(last.status, 429);
    assert.ok(last.headers['retry-after']);
  } finally {
    server.close();
  }
});

test('webhook verifies the signature and logs a paid session before fulfillment', async () => {
  process.env.STRIPE_SECRET_KEY = 'sk_test_placeholder';
  process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test_secret';
  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
  const payload = JSON.stringify({
    id: 'evt_test_paid',
    object: 'event',
    type: 'checkout.session.completed',
    data: {
      object: {
        id: 'cs_test_paid',
        object: 'checkout.session',
        amount_total: 5000,
        currency: 'usd',
        payment_status: 'paid',
        metadata: { note: 'Workshop' },
      },
    },
  });
  const signature = stripe.webhooks.generateTestHeaderString({
    payload,
    secret: process.env.STRIPE_WEBHOOK_SECRET,
  });

  const logs = [];
  const original = console.log;
  console.log = (line) => logs.push(line);
  const { createApp } = require('../server');
  const server = await listen(createApp());
  try {
    const ok = await request(server, {
      method: 'POST',
      path: '/webhook',
      headers: { 'stripe-signature': signature },
      body: payload,
    });
    assert.equal(ok.status, 200);
    assert.equal(ok.json.received, true);
    const joined = logs.join('\n');
    assert.match(joined, /cs_test_paid/);
    assert.match(joined, /Workshop/);
    assert.match(joined, /fulfill-checkout-session/);

    const bad = await request(server, {
      method: 'POST',
      path: '/webhook',
      headers: { 'stripe-signature': 't=1,v1=deadbeef' },
      body: payload,
    });
    assert.equal(bad.status, 400);
  } finally {
    console.log = original;
    server.close();
    delete process.env.STRIPE_SECRET_KEY;
    delete process.env.STRIPE_WEBHOOK_SECRET;
  }
});
