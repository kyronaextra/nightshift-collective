'use strict';

const express = require('express');
const Stripe = require('stripe');
const path = require('path');
const {
  PORTAL_MIN_CENTS,
  PORTAL_MAX_CENTS,
  LEGACY_MIN_CENTS,
  parseAmountToCents,
  sanitizeNote,
  normalizeEmail,
  buildEmbeddedSessionParams,
  buildHostedSessionParams,
  checkoutOutcome,
  summarizeCheckoutEvent,
  isCheckoutSessionId,
  requestBaseUrl,
} = require('./lib/checkout');

const PORT = process.env.PORT || 3000;
const JSON_LIMIT = '16kb';
const CHECKOUT_RATE = { windowMs: 60_000, max: 10 };
const STATUS_RATE = { windowMs: 60_000, max: 30 };

const PAY_CSP = [
  "default-src 'self'",
  "base-uri 'self'",
  "object-src 'none'",
  "frame-ancestors 'self'",
  "form-action 'self'",
  "script-src 'self' https://js.stripe.com https://*.js.stripe.com https://checkout.stripe.com",
  "frame-src https://js.stripe.com https://*.js.stripe.com https://hooks.stripe.com https://checkout.stripe.com https://connect-js.stripe.com https://*.link.com https://link.com",
  "connect-src 'self' https://api.stripe.com https://checkout.stripe.com https://*.stripe.com https://*.link.com https://link.com",
  "img-src 'self' data: https://*.stripe.com https://*.link.com",
  "style-src 'self' https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com",
].join('; ');

let stripeCache = null;

function getStripe() {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) {
    const error = new Error('STRIPE_SECRET_KEY is not set.');
    error.statusCode = 503;
    error.publicMessage =
      'Payments are not configured yet. Set STRIPE_SECRET_KEY (a restricted key with Checkout Sessions write) and restart.';
    throw error;
  }
  if (!stripeCache || stripeCache.key !== key) {
    stripeCache = { key, client: new Stripe(key) };
  }
  return stripeCache.client;
}

function missingStripeEnv() {
  return ['STRIPE_SECRET_KEY', 'STRIPE_PUBLISHABLE_KEY', 'STRIPE_WEBHOOK_SECRET'].filter(
    (name) => !process.env[name]
  );
}

function publicErrorMessage(err) {
  if (err && err.publicMessage) return err.publicMessage;
  if (err && typeof err.type === 'string' && err.type.startsWith('Stripe') && typeof err.message === 'string') {
    if (!/sk_|rk_|whsec_|pk_/.test(err.message)) return err.message;
  }
  return 'Something went wrong. Please try again.';
}

function sendError(res, err) {
  const status = err.statusCode || err.status || 500;
  if (status >= 500) {
    console.error(JSON.stringify({ error: err.message, type: err.type || 'Error' }));
  }
  res.status(status).json({ error: publicErrorMessage(err) });
}

function rateLimit({ windowMs, max }) {
  const hits = new Map();
  return function limit(req, res, next) {
    const now = Date.now();
    const key = req.ip || 'unknown';
    const recent = (hits.get(key) || []).filter((timestamp) => now - timestamp < windowMs);
    if (recent.length >= max) {
      const retryAfter = Math.max(1, Math.ceil((windowMs - (now - recent[0])) / 1000));
      res.set('Retry-After', String(retryAfter));
      return res.status(429).json({
        error: 'Too many requests. Please wait a moment and try again.',
      });
    }
    recent.push(now);
    hits.set(key, recent);
    if (hits.size > 5000) {
      for (const [bucketKey, stamps] of hits) {
        if (stamps.every((timestamp) => now - timestamp >= windowMs)) hits.delete(bucketKey);
      }
    }
    return next();
  };
}

function readCheckoutInput(body, { minCents, maxCents, allowNote, allowEmail }) {
  const source = body && typeof body === 'object' ? body : {};
  const amount = parseAmountToCents(source.amount, { minCents, maxCents });
  if (amount.error) return amount;

  let note = '';
  if (allowNote) {
    const parsedNote = sanitizeNote(source.note);
    if (parsedNote.error) return parsedNote;
    note = parsedNote.note;
  }

  let email;
  if (allowEmail) {
    const parsedEmail = normalizeEmail(source.email);
    if (parsedEmail.error) return parsedEmail;
    email = parsedEmail.email;
  }

  return { unitAmount: amount.unitAmount, note, email };
}

function publicSessionStatus(session) {
  return {
    outcome: checkoutOutcome(session),
    status: session.status,
    payment_status: session.payment_status,
    amount_total: session.amount_total,
    currency: session.currency,
    customer_email: session.customer_details && session.customer_details.email
      ? session.customer_details.email
      : session.customer_email || null,
    note: session.metadata && typeof session.metadata.note === 'string' ? session.metadata.note : '',
  };
}

// TODO hook: fulfillment stays here, never on the return page. A customer can
// pay and never land on /pay/return. Only fulfill when payment_status is not unpaid.
function fulfillCheckoutSession(summary) {
  console.log(JSON.stringify({
    todo: 'fulfill-checkout-session',
    message: 'TODO: record the paid Checkout Session and notify the operator.',
    sessionId: summary.sessionId,
    amountTotal: summary.amountTotal,
    currency: summary.currency,
    note: summary.note,
  }));
}

function recordCheckoutFailure(summary) {
  console.log(JSON.stringify({
    todo: 'record-checkout-failure',
    message: 'TODO: record the failed asynchronous payment. Do not fulfill.',
    sessionId: summary.sessionId,
    amountTotal: summary.amountTotal,
    currency: summary.currency,
    note: summary.note,
  }));
}

function handleCheckoutEvent(event) {
  const summary = summarizeCheckoutEvent(event);
  console.log(JSON.stringify({
    source: 'stripe-webhook',
    type: summary.type,
    eventId: summary.eventId,
    sessionId: summary.sessionId,
    amountTotal: summary.amountTotal,
    currency: summary.currency,
    paymentStatus: summary.paymentStatus,
    note: summary.note,
  }));

  if (summary.failed) recordCheckoutFailure(summary);
  else if (summary.fulfill) fulfillCheckoutSession(summary);
  else if (
    summary.type === 'checkout.session.completed' &&
    summary.paymentStatus === 'unpaid'
  ) {
    console.log(JSON.stringify({
      source: 'stripe-webhook',
      message: 'Checkout completed with an unpaid session. Waiting for async_payment_succeeded before fulfillment.',
      sessionId: summary.sessionId,
    }));
  }

  return summary;
}

function sendPayPage(req, res) {
  res.set('Content-Security-Policy', PAY_CSP);
  res.sendFile(path.join(__dirname, 'public', 'pay.html'));
}

function createApp() {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1);

  // Webhook signature verification needs the raw body. Register this before express.json.
  app.post(
    '/webhook',
    express.raw({ type: 'application/json', limit: '1mb' }),
    async (req, res) => {
      const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
      if (!webhookSecret) {
        return res.status(500).json({
          error: 'Webhook secret not configured. Set STRIPE_WEBHOOK_SECRET.',
        });
      }

      let event;
      try {
        const stripe = getStripe();
        event = stripe.webhooks.constructEvent(
          req.body,
          req.headers['stripe-signature'],
          webhookSecret
        );
      } catch (err) {
        if (err.statusCode === 503) return sendError(res, err);
        return res.status(400).json({ error: 'Webhook signature verification failed.' });
      }

      const tracked = new Set([
        'checkout.session.completed',
        'checkout.session.async_payment_succeeded',
        'checkout.session.async_payment_failed',
      ]);
      if (tracked.has(event.type)) {
        handleCheckoutEvent(event);
      } else {
        console.log(JSON.stringify({ source: 'stripe-webhook', type: event.type, eventId: event.id }));
      }

      return res.json({ received: true });
    }
  );

  app.use(express.json({ limit: JSON_LIMIT }));
  app.use((err, req, res, next) => {
    if (err.type === 'entity.too.large') {
      return res.status(413).json({ error: 'Request is too large.' });
    }
    if (err instanceof SyntaxError && err.status === 400 && Object.prototype.hasOwnProperty.call(err, 'body')) {
      return res.status(400).json({ error: 'Request body must be valid JSON.' });
    }
    return next(err);
  });

  app.use(express.static(path.join(__dirname, 'public')));

  app.get('/api/config', (req, res) => {
    const publishableKey = process.env.STRIPE_PUBLISHABLE_KEY;
    if (!publishableKey) {
      return res.status(503).json({
        error: 'Stripe publishable key is not configured. Set STRIPE_PUBLISHABLE_KEY.',
      });
    }
    if (!/^pk_(test|live)_/.test(publishableKey)) {
      return res.status(503).json({
        error: 'STRIPE_PUBLISHABLE_KEY must be a publishable key (pk_test_ or pk_live_).',
      });
    }
    return res.json({ publishableKey });
  });

  const limitCheckout = rateLimit(CHECKOUT_RATE);
  const limitStatus = rateLimit(STATUS_RATE);

  app.post('/api/checkout-session', limitCheckout, async (req, res) => {
    try {
      const input = readCheckoutInput(req.body, {
        minCents: PORTAL_MIN_CENTS,
        maxCents: PORTAL_MAX_CENTS,
        allowNote: true,
        allowEmail: true,
      });
      if (input.error) return res.status(400).json({ error: input.error });

      const stripe = getStripe();
      const returnUrl = `${requestBaseUrl(req)}/pay/return?session_id={CHECKOUT_SESSION_ID}`;
      const session = await stripe.checkout.sessions.create(
        buildEmbeddedSessionParams({
          unitAmount: input.unitAmount,
          note: input.note,
          email: input.email,
          returnUrl,
        })
      );

      if (!session.client_secret) {
        return res.status(502).json({ error: 'Stripe did not return a client secret.' });
      }
      return res.json({ clientSecret: session.client_secret });
    } catch (err) {
      return sendError(res, err);
    }
  });

  app.get('/api/checkout-session/status', limitStatus, async (req, res) => {
    try {
      const sessionId = req.query.session_id;
      if (!isCheckoutSessionId(sessionId)) {
        return res.status(400).json({ error: 'A valid Checkout Session id is required.' });
      }

      const stripe = getStripe();
      let session;
      try {
        session = await stripe.checkout.sessions.retrieve(sessionId, {
          expand: ['payment_intent'],
        });
      } catch (err) {
        if (err && (err.code === 'resource_missing' || err.statusCode === 404)) {
          return res.status(404).json({ error: "We couldn't find that payment session." });
        }
        // A Checkout-only restricted key may not be allowed to expand PaymentIntents.
        session = await stripe.checkout.sessions.retrieve(sessionId);
      }

      return res.json(publicSessionStatus(session));
    } catch (err) {
      if (err && (err.code === 'resource_missing' || err.statusCode === 404)) {
        return res.status(404).json({ error: "We couldn't find that payment session." });
      }
      return sendError(res, err);
    }
  });

  // Legacy hosted Checkout. Response shape is unchanged: { url } or { error }.
  app.post('/create-checkout', limitCheckout, async (req, res) => {
    try {
      const input = readCheckoutInput(req.body, {
        minCents: LEGACY_MIN_CENTS,
        maxCents: PORTAL_MAX_CENTS,
        allowNote: false,
        allowEmail: false,
      });
      if (input.error) return res.status(400).json({ error: input.error });

      const stripe = getStripe();
      const base = requestBaseUrl(req);
      const session = await stripe.checkout.sessions.create(
        buildHostedSessionParams({
          unitAmount: input.unitAmount,
          successUrl: `${base}/?success=true`,
          cancelUrl: `${base}/?canceled=true`,
        })
      );

      if (!session.url) {
        return res.status(502).json({ error: 'Stripe did not return a checkout URL.' });
      }
      return res.json({ url: session.url });
    } catch (err) {
      return sendError(res, err);
    }
  });

  // Registered before the catch-all so /pay is not replaced by the homepage.
  app.get('/pay', sendPayPage);
  app.get('/pay/return', sendPayPage);

  app.use('/api', (req, res) => {
    res.status(404).json({ error: 'Not found.' });
  });

  app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
  });

  return app;
}

if (require.main === module) {
  const missing = missingStripeEnv();
  if (missing.length) {
    console.error(
      `Stripe is not fully configured. Missing: ${missing.join(', ')}. Payment routes will fail until these are set.`
    );
  } else {
    console.log('Stripe environment variables are set.');
  }

  const app = createApp();
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`NightShift Collective listening on 0.0.0.0:${PORT}`);
  });
}

module.exports = {
  createApp,
  handleCheckoutEvent,
  getStripe,
};
