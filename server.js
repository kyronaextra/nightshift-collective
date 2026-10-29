const express = require('express');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

app.post('/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  const sig = req.headers['stripe-signature'];
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!webhookSecret) return res.status(500).send('Webhook secret not configured');
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, webhookSecret);
  } catch (err) {
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }
  console.log('Event:', event.type);
  res.json({ received: true });
});

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.post('/create-checkout', async (req, res) => {
  try {
    const { amount } = req.body;
    const unitAmount = Math.round(parseFloat(amount) * 100);
    if (!unitAmount || unitAmount < 50) return res.status(400).json({ error: 'Minimum $0.50' });
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      line_items: [{ price_data: { currency: 'usd', product_data: { name: 'Invoice Payment' }, unit_amount: unitAmount }, quantity: 1 }],
      mode: 'payment',
      success_url: `${process.env.RENDER_EXTERNAL_URL || ''}/?success=true`,
      cancel_url: `${process.env.RENDER_EXTERNAL_URL || ''}/?canceled=true`
    });
    res.json({ url: session.url });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => console.log(`Running on ${PORT}`));
