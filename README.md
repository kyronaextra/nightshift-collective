# NightShift Collective

Site and custom payment portal for NightShift Collective. Express serves `public/` and a dedicated payment page at `/pay`.

The root `index.html` is not served. `server.js` serves `public/index.html` for the homepage and unknown pages. The root file is left in place.

## Run locally

Node.js 20 or newer is required (Stripe Node SDK 23).

```bash
npm install
npm start
```

The server listens on `0.0.0.0:$PORT` (port 3000 if `PORT` is unset).

```bash
npm test
```

Open `http://localhost:3000/pay`. Without Stripe keys the amount form still renders and validates. Creating a Checkout Session returns a clear configuration error until the variables below are set.

Copy `.env.example` to a local env file if you want, and export the variables in your shell. Do not commit real keys.

## Stripe environment variables

Set these in the Render dashboard for the `nightshift-collective` web service (Environment). Do not put them in git.

| Variable | What to use |
| --- | --- |
| `STRIPE_SECRET_KEY` | A [restricted API key](https://docs.stripe.com/keys) (`rk_test_...` or `rk_live_...`), not a secret key (`sk_...`), if you can. Grant **Checkout Sessions: Write**. Also grant **Payment Intents: Read** so the return page can tell a processing bank payment from a failed one. If that read permission is missing, status still works from the Checkout Session alone. |
| `STRIPE_PUBLISHABLE_KEY` | The matching publishable key (`pk_test_...` or `pk_live_...`). The browser loads this from `GET /api/config`. It is not a secret, and it is still not hardcoded. |
| `STRIPE_WEBHOOK_SECRET` | The signing secret (`whsec_...`) for the webhook endpoint below. |

`RENDER_EXTERNAL_URL` is set by Render and is used for Checkout return URLs. Locally, the server uses the request host. Set `PUBLIC_BASE_URL` (for example `http://localhost:3000`) only if you need to override that.

Use separate test and live keys. Start in test mode. Rotate a key if it is ever pasted into a chat, a log, or a repository.

Store the restricted key in Render’s environment variables. Render does not provide a separate secrets vault; treat the dashboard value as the secret and do not echo it in build logs.

## Webhook

In the Stripe Dashboard (test mode first, then live), add an endpoint:

`https://nightshift-collective.onrender.com/webhook`

Subscribe to:

- `checkout.session.completed`
- `checkout.session.async_payment_succeeded`
- `checkout.session.async_payment_failed`

The route reads the raw body before `express.json()` and rejects requests whose `Stripe-Signature` does not match `STRIPE_WEBHOOK_SECRET`.

Fulfillment belongs in that handler, not on `/pay/return`. A payer can succeed and never reach the return page. Paid sessions (`checkout.session.completed` or `checkout.session.async_payment_succeeded` with `payment_status` other than `unpaid`) hit a TODO hook that logs the session id, amount, and note. `checkout.session.async_payment_failed` hits a separate TODO and does not fulfill. A `completed` event that is still `unpaid` waits for the async success event.

For local webhook forwarding, the Stripe CLI can print a signing secret:

```bash
stripe listen --forward-to localhost:3000/webhook
```

Put that secret in `STRIPE_WEBHOOK_SECRET` while you test.

## Payment page

- `GET /pay` — amount, presets ($25, $50, $100, $250), optional note, optional receipt email, then Stripe Embedded Checkout on the same page.
- `GET /pay/return?session_id={CHECKOUT_SESSION_ID}` — success, processing, failed, or not completed. “Start over” returns to `/pay`.
- `POST /api/checkout-session` — server-side amount check ($1.00 to $10,000.00, at most two decimals). Returns `{ clientSecret }`.
- `GET /api/checkout-session/status?session_id=cs_...` — status for the return page.
- `GET /api/config` — `{ publishableKey }`.
- `POST /create-checkout` — existing hosted Checkout redirect. Still returns `{ url }`. Minimum remains $0.50. The current Stripe API chooses payment methods dynamically, so this route no longer sends `payment_method_types`.

Amounts outside the rules, a note over 200 characters, and a bad email are rejected with a message. Checkout creation is limited to 10 requests per minute per IP.

Embedded Checkout uses `ui_mode: "embedded_page"` and `stripe.createEmbeddedCheckoutPage()`. Stripe renamed `ui_mode: "embedded"` and `initEmbeddedCheckout()` in 2026; those old names fail on the current API.

Card data is entered in Stripe’s frame. NightShift does not receive the card number. Payments are not tax-deductible donations: the foundation initiative is not a recognized 501(c)(3).

## Test cards

Use test keys. Any future expiry, any CVC, and any postal code work. See [Stripe’s testing docs](https://docs.stripe.com/testing).

| Card | Result |
| --- | --- |
| `4242 4242 4242 4242` | Payment succeeds |
| `4000 0000 0000 9995` | Card declined |
| `4000 0025 0000 3155` | Requires authentication (3D Secure) |
| `4000 0000 0000 3220` | 3D Secure 2 required, then succeeds |

A successful test payment should land on `/pay/return` with a success message, and the webhook log should include the amount, session id, and note.

## Render

1. Confirm the service’s Node version is 20 or newer (`NODE_VERSION=22` in the environment if the runtime is older).
2. Set `STRIPE_SECRET_KEY`, `STRIPE_PUBLISHABLE_KEY`, and `STRIPE_WEBHOOK_SECRET`.
3. Deploy. The start command stays `npm start` (`node server.js`), bound to `0.0.0.0:$PORT`.
4. Add the webhook endpoint and events above in the same Stripe mode as the keys.
5. Open `https://nightshift-collective.onrender.com/pay` and pay with a test card before switching the keys to live mode.
