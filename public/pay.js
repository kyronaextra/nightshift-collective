(function () {
  const form = document.getElementById('pay-form');
  const amountInput = document.getElementById('amount');
  const noteInput = document.getElementById('note');
  const emailInput = document.getElementById('email');
  const formError = document.getElementById('form-error');
  const continueButton = document.getElementById('continue');
  const amountPanel = document.getElementById('amount-panel');
  const checkoutPanel = document.getElementById('checkout-panel');
  const checkoutMount = document.getElementById('checkout');
  const checkoutError = document.getElementById('checkout-error');
  const checkoutSummary = document.getElementById('checkout-summary');
  const statusPanel = document.getElementById('status-panel');
  const statusHeading = document.getElementById('status-heading');
  const statusDetail = document.getElementById('status-detail');
  const statusMeta = document.getElementById('status-meta');
  const statusKicker = document.getElementById('status-kicker');
  const configBanner = document.getElementById('config-banner');
  const noteCount = document.getElementById('note-count');
  const presetButtons = Array.from(document.querySelectorAll('.presets button'));

  let embeddedCheckout = null;
  let publishableKey = '';

  function setError(node, message) {
    node.textContent = message || '';
  }

  function parseAmount(value) {
    const raw = String(value || '').trim().replace(/^\$/, '').replace(/,/g, '').replace(/\s+/g, '');
    if (!raw) return { error: 'Enter a dollar amount, like 25 or 25.00.' };
    if (!/^\d+(\.\d{1,2})?$/.test(raw)) {
      if (/^\d+\.\d{3,}$/.test(raw)) {
        return { error: 'Use at most two decimal places, like 25.00.' };
      }
      return { error: 'Enter a dollar amount, like 25 or 25.00.' };
    }
    const cents = Math.round(Number(raw) * 100);
    if (cents < 100) return { error: 'Minimum payment is $1.00.' };
    if (cents > 1_000_000) return { error: 'Maximum payment is $10,000.00.' };
    return { cents, raw };
  }

  function formatCents(cents, currency) {
    try {
      return new Intl.NumberFormat('en-US', {
        style: 'currency',
        currency: (currency || 'usd').toUpperCase(),
      }).format(cents / 100);
    } catch (err) {
      return '$' + (cents / 100).toFixed(2);
    }
  }

  function syncPresets() {
    const current = amountInput.value.trim().replace(/^\$/, '');
    presetButtons.forEach((button) => {
      button.setAttribute('aria-pressed', button.dataset.amount === current ? 'true' : 'false');
    });
  }

  function updateNoteCount() {
    noteCount.textContent = String(noteInput.value.length);
  }

  presetButtons.forEach((button) => {
    button.addEventListener('click', () => {
      amountInput.value = button.dataset.amount;
      syncPresets();
      setError(formError, '');
      amountInput.focus();
    });
  });

  amountInput.addEventListener('input', () => {
    syncPresets();
    if (formError.textContent) setError(formError, '');
  });
  noteInput.addEventListener('input', updateNoteCount);

  async function loadConfig() {
    try {
      const response = await fetch('/api/config');
      const data = await response.json();
      if (!response.ok) {
        configBanner.hidden = false;
        configBanner.textContent = data.error || 'Payments are not configured on this server yet.';
        return;
      }
      publishableKey = data.publishableKey;
    } catch (err) {
      configBanner.hidden = false;
      configBanner.textContent = 'Could not reach the payment configuration. You can still review the form.';
    }
  }

  async function destroyCheckout() {
    if (embeddedCheckout) {
      embeddedCheckout.destroy();
      embeddedCheckout = null;
    }
    checkoutMount.replaceChildren();
    checkoutMount.setAttribute('aria-busy', 'false');
  }

  function showAmountForm() {
    checkoutPanel.hidden = true;
    statusPanel.hidden = true;
    amountPanel.hidden = false;
    continueButton.disabled = false;
    continueButton.textContent = 'Continue to secure payment';
    setError(checkoutError, '');
    amountInput.focus();
  }

  document.getElementById('start-over').addEventListener('click', async () => {
    await destroyCheckout();
    showAmountForm();
  });

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const amount = parseAmount(amountInput.value);
    const email = emailInput.value.trim();
    if (amount.error) {
      setError(formError, amount.error);
      amountInput.setAttribute('aria-invalid', 'true');
      amountInput.focus();
      return;
    }
    amountInput.removeAttribute('aria-invalid');
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      setError(formError, 'Enter a valid email address, or leave it blank.');
      emailInput.focus();
      return;
    }
    if (noteInput.value.trim().length > 200) {
      setError(formError, 'Note must be 200 characters or fewer.');
      noteInput.focus();
      return;
    }
    setError(formError, '');

    if (!publishableKey) {
      setError(formError, configBanner.textContent || 'Payments are not configured yet.');
      return;
    }
    if (!window.Stripe) {
      setError(formError, 'Stripe.js did not load. Check the connection and try again.');
      return;
    }

    continueButton.disabled = true;
    continueButton.textContent = 'Opening secure payment…';
    await destroyCheckout();

    const payload = {
      amount: amount.raw,
      note: noteInput.value,
      email,
    };

    try {
      const stripe = window.Stripe(publishableKey);
      embeddedCheckout = await stripe.createEmbeddedCheckoutPage({
        fetchClientSecret: async () => {
          const response = await fetch('/api/checkout-session', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
          });
          const data = await response.json().catch(() => ({}));
          if (!response.ok || !data.clientSecret) {
            throw new Error(data.error || 'Unable to start checkout.');
          }
          return data.clientSecret;
        },
      });

      amountPanel.hidden = true;
      checkoutPanel.hidden = false;
      const summary = ['Paying ' + formatCents(amount.cents)];
      if (noteInput.value.trim()) summary.push('Note: ' + noteInput.value.trim());
      if (email) summary.push('Receipt: ' + email);
      checkoutSummary.textContent = summary.join(' · ');
      checkoutMount.setAttribute('aria-busy', 'true');
      embeddedCheckout.mount('#checkout');
      checkoutMount.setAttribute('aria-busy', 'false');
      document.getElementById('checkout-heading').focus();
    } catch (err) {
      await destroyCheckout();
      showAmountForm();
      setError(formError, err && err.message ? err.message : 'Unable to start checkout.');
    }
  });

  const STATUS_COPY = {
    success: {
      kicker: 'Payment received',
      heading: 'Thank you. This payment went through.',
      detail: 'Stripe has confirmed the payment. If you entered an email, the receipt goes there. You do not need to pay again.',
    },
    processing: {
      kicker: 'Payment processing',
      heading: 'The payment is still processing.',
      detail: 'The bank has not finished. This page will not mark it paid until Stripe does. You do not need to submit it again.',
    },
    failed: {
      kicker: 'Payment failed',
      heading: 'This payment did not go through.',
      detail: 'Nothing was collected. You can start over with the same or a different amount.',
    },
    incomplete: {
      kicker: 'Not completed',
      heading: 'This payment was not completed.',
      detail: 'The checkout is still open or was left before payment. You can start over when you are ready.',
    },
  };

  async function showReturn(sessionId) {
    amountPanel.hidden = true;
    checkoutPanel.hidden = true;
    statusPanel.hidden = false;
    statusPanel.dataset.outcome = 'processing';
    statusKicker.textContent = 'Checking payment';
    statusHeading.textContent = 'Looking up this payment…';
    statusDetail.textContent = '';
    statusMeta.textContent = '';

    try {
      const response = await fetch('/api/checkout-session/status?session_id=' + encodeURIComponent(sessionId));
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Unable to check this payment.');

      const copy = STATUS_COPY[data.outcome] || STATUS_COPY.failed;
      statusPanel.dataset.outcome = data.outcome || 'failed';
      statusKicker.textContent = copy.kicker;
      statusHeading.textContent = copy.heading;
      statusDetail.textContent = copy.detail;

      const bits = [];
      if (typeof data.amount_total === 'number') bits.push(formatCents(data.amount_total, data.currency));
      if (data.customer_email) bits.push('Receipt email: ' + data.customer_email);
      if (data.note) bits.push('Note: ' + data.note);
      statusMeta.textContent = bits.join(' · ');
    } catch (err) {
      statusPanel.dataset.outcome = 'failed';
      statusKicker.textContent = 'Payment status';
      statusHeading.textContent = 'We could not confirm this payment.';
      statusDetail.textContent = err && err.message ? err.message : 'Please try again from the payment page.';
    }
    statusHeading.focus();
  }

  const sessionId = new URLSearchParams(window.location.search).get('session_id');
  updateNoteCount();
  if (sessionId) {
    showReturn(sessionId);
  } else {
    loadConfig();
    amountInput.focus();
  }
})();
