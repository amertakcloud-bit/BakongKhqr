'use strict';

require('dotenv').config();
const path = require('node:path');
const express = require('express');

const { BakongClient, BakongError } = require('./bakongClient');
const { createWebhookHandler } = require('./webhook');
const orders = require('./orders');

const { RBK_TOKEN, RBK_WEBHOOK_SECRET, PORT = 3000 } = process.env;
if (!RBK_TOKEN || !RBK_WEBHOOK_SECRET) {
  console.error('Missing RBK_TOKEN or RBK_WEBHOOK_SECRET in environment');
  process.exit(1);
}

const bakong = new BakongClient({ token: RBK_TOKEN });

const CHECKOUT_TTL_MS = 10 * 60 * 1000; // UI countdown: 10 minutes
const STATUS_MIN_INTERVAL_MS = 3000; // never hit the gateway more than once / 3s per order

// ── Business logic ──────────────────────────────────────────────────────────
async function fulfillOrder(order) {
  // TODO: send confirmation, unlock content, update your real DB, etc.
  console.log(`[order] FULFILLED ${order.orderId} (${order.amount})`);
}

/** Single place that turns an order into "paid" — used by BOTH webhook and polling fallback. */
async function settlePaid(order, data) {
  if (Math.abs(Number(data.amount) - order.amount) > 0.005) {
    orders.setStatus(order.md5, 'amount_mismatch');
    console.error(`[order] amount mismatch for ${order.orderId}: expected ${order.amount}, got ${data.amount}`);
    return;
  }
  if (orders.markPaid(order.md5, data)) await fulfillOrder(order); // runs once only
}

async function handleWebhookEvent({ event, data }) {
  const order = data.md5 ? orders.get(data.md5) : null;
  if (!order) return console.warn(`[webhook] ${event}: unknown md5 ${data.md5}`);
  
  switch (event) {
    case 'payment.success': // also covers late payments (after the 10-min UI window, < 24h)
      return settlePaid(order, data);
    case 'payment.scanned':
      if (order.status === 'unpaid') orders.setStatus(order.md5, 'scanned');
      return;
    case 'payment.expired':
      return void orders.setStatus(order.md5, 'expired');
    default:
      console.warn(`[webhook] unhandled event: ${event}`);
  }
}

/** Refresh from gateway as a fallback (webhook is the primary source of truth). */
async function refreshFromGateway(order) {
  if (['paid', 'amount_mismatch'].includes(order.status)) return;
  if (Date.now() > order.expiresAt) return; // UI window closed; late payments arrive via webhook
  if (Date.now() - order.lastCheckedAt < STATUS_MIN_INTERVAL_MS) return; // throttle / protect shared rate limit
  
  order.lastCheckedAt = Date.now();
  try {
    const result = await bakong.checkTransaction(order.md5);
    if (result.status === 'paid') await settlePaid(order, result);
    else if (result.status === 'scanned') orders.setStatus(order.md5, 'scanned');
    else if (result.status === 'expired') orders.setStatus(order.md5, 'expired');
  } catch (err) {
    // Transient problems: keep serving the last known status instead of breaking the checkout UI
    if (err instanceof BakongError && ['rate_limit', 'timeout', 'network'].includes(err.kind)) return;
    throw err;
  }
}

function publicView(order) {
  const remainingMs = Math.max(0, order.expiresAt - Date.now());
  const uiExpired = order.status !== 'paid' && remainingMs === 0;
  return {
    orderId: order.orderId,
    md5: order.md5,
    status: uiExpired ? 'expired' : order.status,
    remainingSeconds: Math.ceil(remainingMs / 1000),
  };
}

// ── App ─────────────────────────────────────────────────────────────────────
const app = express();
app.set('trust proxy', 1); // Render terminates TLS in front of the app

// CORS: allows the checkout HTML to be hosted separately from this API.
// No cookies/auth are read from the browser, so reflecting the origin is safe.
// Restrict via ALLOWED_ORIGINS="https://your-site.com,https://other.com" in production.
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin && (ALLOWED_ORIGINS.length === 0 || ALLOWED_ORIGINS.includes(origin))) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  }
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// Webhook FIRST, with the RAW body parser (must be registered before express.json()).
app.post(
  '/webhooks/bakong',
  express.raw({ type: '*/*', limit: '100kb' }),
  createWebhookHandler({ secret: RBK_WEBHOOK_SECRET, onEvent: handleWebhookEvent }),
);

app.use(express.json({ limit: '10kb' }));
app.use(express.static(path.join(__dirname, '..', 'public'))); // frontend checkout page

// Create a payment
app.post('/api/payments', async (req, res, next) => {
  try {
    const { orderId, amount } = req.body ?? {};
    if (typeof orderId !== 'string' || !orderId.trim()) {
      return res.status(400).json({ error: 'orderId_required' });
    }
    const payment = await bakong.createPayment(amount);
    const order = orders.create({
      orderId,
      amount: payment.amount,
      md5: payment.md5,
      tranId: payment.tranId,
      expiresAt: Date.now() + CHECKOUT_TTL_MS,
    });
    res.status(201).json({
      orderId,
      md5: payment.md5,
      qr: payment.qr, // render client-side if `image` is null
      image: payment.image, // data:image/png;base64,...
      deeplink: payment.deeplink, // use on mobile: open in banking app
      expiresAt: order.expiresAt,
      pollIntervalMs: 4000,
    });
  } catch (err) {
    next(err);
  }
});

// Status (frontend polls THIS endpoint every ~4s, not the gateway directly)
app.get('/api/payments/:md5/status', async (req, res, next) => {
  try {
    const order = orders.get(req.params.md5);
    if (!order) return res.status(404).json({ error: 'order_not_found' });
    await refreshFromGateway(order);
    res.json(publicView(order));
  } catch (err) {
    next(err);
  }
});

app.get('/healthz', (_req, res) => res.json({ ok: true }));

// ── Error handler ───────────────────────────────────────────────────────────
app.use((err, _req, res, _next) => {
  if (err instanceof BakongError) {
    console.error(`[bakong] ${err.kind} http=${err.httpStatus ?? '-'} code=${err.errorCode ?? '-'}: ${err.message}`);
    switch (err.kind) {
      case 'validation':
        return res.status(400).json({ error: 'invalid_request', message: err.message });
      case 'rate_limit':
        res.set('Retry-After', String(Math.ceil((err.retryAfterMs ?? 1000) / 1000)));
        return res.status(429).json({ error: 'too_many_requests' });
      case 'timeout':
        return res.status(504).json({ error: 'payment_provider_timeout' });
      case 'maintenance':
        return res.status(503).json({ error: 'payment_provider_maintenance' });
      default: // auth, config, network, api → details stay in server logs only
        return res.status(502).json({ error: 'payment_provider_unavailable' });
    }
  }
  if (err?.type === 'entity.parse.failed') return res.status(400).json({ error: 'invalid_json' });
  console.error('[server] unexpected error:', err);
  res.status(500).json({ error: 'internal_error' });
});

// Render injects PORT (default 10000) and requires binding to 0.0.0.0
const server = app.listen(Number(PORT), '0.0.0.0', () => console.log(`KHQR service listening on 0.0.0.0:${PORT}`));

// Graceful shutdown (Render sends SIGTERM on every deploy/restart)
process.on('SIGTERM', () => {
  console.log('SIGTERM received, shutting down...');
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 10_000).unref();
});