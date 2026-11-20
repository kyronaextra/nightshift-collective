'use strict';

// Stable label so embedded sessions can be compared in the Stripe Dashboard.
// The suffix is 8 letters, as required by the current Checkout API.
const INTEGRATION_IDENTIFIER = 'nightshift_embedded_kthwpmxq';

const PORTAL_MIN_CENTS = 100;
const PORTAL_MAX_CENTS = 1_000_000;
const LEGACY_MIN_CENTS = 50;
const NOTE_MAX_LENGTH = 200;

function parseAmountToCents(amount, options = {}) {
  const minCents = options.minCents ?? PORTAL_MIN_CENTS;
  const maxCents = options.maxCents ?? PORTAL_MAX_CENTS;
  const raw = amountToRaw(amount);
  if (raw == null || raw === '') {
    return { error: 'Enter a dollar amount, like 25 or 25.00.' };
  }
  if (!/^\d+(\.\d{1,2})?$/.test(raw)) {
    if (/^\d+\.\d{3,}$/.test(raw)) {
      return { error: 'Use at most two decimal places, like 25.00.' };
    }
    return { error: 'Enter a dollar amount, like 25 or 25.00.' };
  }

  const [dollars, fraction = ''] = raw.split('.');
  const cents = Number(dollars) * 100 + Number((fraction + '00').slice(0, 2));
  if (!Number.isSafeInteger(cents)) {
    return { error: 'Enter a dollar amount, like 25 or 25.00.' };
  }
  if (cents < minCents) {
    return { error: `Minimum payment is ${formatUsd(minCents)}.` };
  }
  if (cents > maxCents) {
    return { error: `Maximum payment is ${formatUsd(maxCents)}.` };
  }
  return { unitAmount: cents };
}

function amountToRaw(amount) {
  if (typeof amount === 'number') {
    if (!Number.isFinite(amount)) return null;
    return amount.toString();
  }
  if (typeof amount === 'string') {
    return amount.trim().replace(/^\$/, '').replace(/,/g, '').replace(/\s+/g, '');
  }
  return null;
}

function formatUsd(cents) {
  const dollars = Math.floor(cents / 100);
  const fraction = String(cents % 100).padStart(2, '0');
  return `$${dollars.toLocaleString('en-US')}.${fraction}`;
}

function sanitizeNote(note) {
  if (note == null || note === '') return { note: '' };
  if (typeof note !== 'string') return { error: 'Note must be text.' };

  const cleaned = note
    .replace(/<[^>]*>/g, '')
    .replace(/[\u0000-\u001F\u007F]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (cleaned.length > NOTE_MAX_LENGTH) {
    return { error: `Note must be ${NOTE_MAX_LENGTH} characters or fewer.` };
  }
  return { note: cleaned };
}

function normalizeEmail(email) {
  if (email == null || email === '') return { email: undefined };
  if (typeof email !== 'string') return { error: 'Enter a valid email address.' };

  const value = email.trim();
  if (!value) return { email: undefined };
  if (value.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) {
    return { error: 'Enter a valid email address.' };
  }
  return { email: value };
}

function productDescription(note) {
  return note || 'Custom amount payment to NightShift Collective.';
}

function buildEmbeddedSessionParams({ unitAmount, note, email, returnUrl }) {
  const description = productDescription(note);
  const params = {
    mode: 'payment',
    ui_mode: 'embedded_page',
    line_items: [
      {
        quantity: 1,
        price_data: {
          currency: 'usd',
          unit_amount: unitAmount,
          product_data: {
            name: 'NightShift payment',
            description,
          },
        },
      },
    ],
    return_url: returnUrl,
    metadata: { note: note || '' },
    payment_intent_data: {
      description,
      metadata: { note: note || '' },
    },
    integration_identifier: INTEGRATION_IDENTIFIER,
  };

  if (email) {
    params.customer_email = email;
    params.payment_intent_data.receipt_email = email;
  }

  return params;
}

function buildHostedSessionParams({ unitAmount, successUrl, cancelUrl }) {
  return {
    mode: 'payment',
    line_items: [
      {
        quantity: 1,
        price_data: {
          currency: 'usd',
          unit_amount: unitAmount,
          product_data: { name: 'Invoice Payment' },
        },
      },
    ],
    success_url: successUrl,
    cancel_url: cancelUrl,
    integration_identifier: 'nightshift_hosted_bvnqrxpw',
  };
}

function checkoutOutcome(session) {
  const paymentIntent =
    session.payment_intent && typeof session.payment_intent === 'object'
      ? session.payment_intent
      : null;
  const intentStatus = paymentIntent ? paymentIntent.status : null;

  if (
    session.payment_status === 'paid' ||
    session.payment_status === 'no_payment_required' ||
    intentStatus === 'succeeded'
  ) {
    return 'success';
  }

  if (
    intentStatus === 'processing' ||
    intentStatus === 'requires_action' ||
    intentStatus === 'requires_confirmation'
  ) {
    return 'processing';
  }

  if (session.status === 'expired') return 'failed';

  if (session.status === 'complete' && session.payment_status === 'unpaid') {
    if (intentStatus === 'canceled' || intentStatus === 'requires_payment_method') {
      return 'failed';
    }
    return 'processing';
  }

  if (session.status === 'open') return 'incomplete';
  return 'failed';
}

function summarizeCheckoutEvent(event) {
  const session = event && event.data && event.data.object ? event.data.object : {};
  const note =
    session.metadata && typeof session.metadata.note === 'string' ? session.metadata.note : '';
  const type = event && event.type;
  const payable =
    type === 'checkout.session.completed' || type === 'checkout.session.async_payment_succeeded';

  return {
    type,
    eventId: event && event.id,
    sessionId: session.id || null,
    amountTotal: Object.prototype.hasOwnProperty.call(session, 'amount_total')
      ? session.amount_total
      : null,
    currency: session.currency || null,
    paymentStatus: session.payment_status || null,
    note,
    fulfill: payable && session.payment_status !== 'unpaid',
    failed: type === 'checkout.session.async_payment_failed',
  };
}

function isCheckoutSessionId(value) {
  return typeof value === 'string' && /^cs_[A-Za-z0-9_]+$/.test(value) && value.length <= 255;
}

function requestBaseUrl(req) {
  const configured = String(process.env.RENDER_EXTERNAL_URL || process.env.PUBLIC_BASE_URL || '')
    .trim()
    .replace(/\/$/, '');
  if (configured) return configured;
  const host = req.get('host');
  const proto = req.get('x-forwarded-proto') || req.protocol || 'http';
  return `${proto}://${host}`;
}

module.exports = {
  INTEGRATION_IDENTIFIER,
  PORTAL_MIN_CENTS,
  PORTAL_MAX_CENTS,
  LEGACY_MIN_CENTS,
  NOTE_MAX_LENGTH,
  parseAmountToCents,
  sanitizeNote,
  normalizeEmail,
  buildEmbeddedSessionParams,
  buildHostedSessionParams,
  checkoutOutcome,
  summarizeCheckoutEvent,
  isCheckoutSessionId,
  requestBaseUrl,
  formatUsd,
};
