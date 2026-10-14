'use strict';

const crypto = require('node:crypto');

const TOLERANCE_MS = 5 * 60 * 1000; // 5 minutes replay window
const HEX_SHA256_RE = /^[a-f0-9]{64}$/i;

/**
 * Verify a Bakong Relay webhook.
 * @param {Buffer} rawBody   EXACT bytes received (do not JSON.parse + stringify)
 * @returns {{ok: true} | {ok: false, reason: string}}
 */
function verifyWebhook({ rawBody, signature, delivery, secret, now = Date.now() }) {
  if (!Buffer.isBuffer(rawBody)) return { ok: false, reason: 'raw_body_unavailable' };
  if (!signature || !HEX_SHA256_RE.test(signature)) return { ok: false, reason: 'bad_signature_format' };
  if (!delivery || !/^\d+$/.test(delivery)) return { ok: false, reason: 'bad_delivery_header' };

  // 1) Replay-attack prevention
  if (Math.abs(now - Number(delivery)) > TOLERANCE_MS) return { ok: false, reason: 'timestamp_out_of_tolerance' };

  // 2) HMAC-SHA256 over RAW body
  const expected = crypto.createHmac('sha256', secret).update(rawBody).digest();
  const provided = Buffer.from(signature, 'hex');

  // 3) Constant-time comparison (lengths are both 32 bytes here)
  if (provided.length !== expected.length || !crypto.timingSafeEqual(provided, expected)) {
    return { ok: false, reason: 'signature_mismatch' };
  }
  return { ok: true };
}

/**
 * Express handler. Mount with express.raw() BEFORE any express.json():
 *   app.post('/webhooks/bakong', express.raw({ type: '*\/*' }), createWebhookHandler({...}))
 */
function createWebhookHandler({ secret, onEvent, logger = console }) {
  if (!secret) throw new Error('createWebhookHandler: secret is required');

  return (req, res) => {
    if (!Buffer.isBuffer(req.body)) {
      logger.error('[webhook] req.body is not a Buffer — express.raw() must run before express.json()');
      return res.status(500).json({ error: 'server_misconfigured' });
    }

    const check = verifyWebhook({
      rawBody: req.body,
      signature: req.get('X-RBK-Signature'),
      delivery: req.get('X-RBK-Delivery'),
      secret,
    });

    if (!check.ok) {
      logger.warn(`[webhook] rejected: ${check.reason}`);
      return res.status(401).json({ error: 'invalid_webhook' });
    }

    let payload;
    try {
      payload = JSON.parse(req.body.toString('utf8'));
    } catch {
      return res.status(400).json({ error: 'invalid_json' });
    }

    const event = req.get('X-RBK-Event') || payload.event;

    // 4) Acknowledge promptly, then process (handlers MUST be idempotent — deliveries may repeat)
    res.status(200).json({ received: true });

    setImmediate(() => {
      Promise.resolve(onEvent({ event, data: payload.data ?? {}, payload })).catch((err) =>
        logger.error(`[webhook] handler failed for ${event}:`, err),
      );
    });
  };
}

module.exports = { verifyWebhook, createWebhookHandler, TOLERANCE_MS };
