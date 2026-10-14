'use strict';

/**
 * Bakong Relay API client (Node.js >= 18, uses built-in fetch).
 *
 * Retry policy:
 *  - HTTP 429  : always safe to retry (request was rejected, not processed). Waits Retry-After.
 *  - Timeout / network / 502 / 504 : retried ONLY for idempotent calls (image, deeplink, check).
 *    generate_qr is NOT retried on timeout, because the first request may have succeeded
 *    and a retry would create a second QR (and consume quota).
 */

const DEFAULT_BASE_URL = 'https://api.bakongrelay.com/v1';
const MD5_RE = /^[a-f0-9]{32}$/i;
const KNOWN_TX_STATES = new Set(['paid', 'scanned', 'unpaid', 'expired']);

class BakongError extends Error {
  /**
   * kind: 'rate_limit' | 'timeout' | 'network' | 'auth' | 'config' |
   *       'validation' | 'maintenance' | 'api'
   */
  constructor(message, { kind = 'api', httpStatus, errorCode, retryAfterMs, body, cause } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = 'BakongError';
    this.kind = kind;
    this.httpStatus = httpStatus;
    this.errorCode = errorCode;
    this.retryAfterMs = retryAfterMs;
    this.body = body;
  }
}

const sleep = (ms, signal) =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason ?? new Error('Aborted'));
    const t = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(signal.reason ?? new Error('Aborted'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });

function parseRetryAfter(header) {
  if (!header) return 1000;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(header);
  return Number.isNaN(date) ? 1000 : Math.max(0, date - Date.now());
}

const backoff = (attempt) => Math.min(500 * 2 ** attempt, 4000) + Math.floor(Math.random() * 250);

class BakongClient {
  constructor({
    token,
    baseUrl = DEFAULT_BASE_URL,
    timeoutMs = 10_000,
    maxRetries = 2,
    maxRetryWaitMs = 10_000, // never block a request longer than this waiting on Retry-After
  } = {}) {
    if (!token) throw new Error('BakongClient: token (RBK_TOKEN) is required');
    this.token = token;
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.timeoutMs = timeoutMs;
    this.maxRetries = maxRetries;
    this.maxRetryWaitMs = maxRetryWaitMs;
  }

  /** Map a non-2xx gateway response to a typed BakongError. */
  toError(httpStatus, json) {
    const errorCode = json?.errorCode;
    const message = json?.responseMessage || `Gateway error (HTTP ${httpStatus})`;
    let kind = 'api';
    if (httpStatus === 401) kind = 'auth'; // errorCode 6: token invalid/expired/quota exhausted
    else if (httpStatus === 400 && errorCode === 10) kind = 'config'; // Payment Link not configured
    else if (httpStatus === 422) kind = 'validation'; // errorCode 14
    else if (httpStatus === 503) kind = 'maintenance'; // errorCode 99
    return new BakongError(message, { kind, httpStatus, errorCode, body: json });
  }

  /**
   * @param {object} opts
   * @param {boolean} opts.idempotent  safe to retry on timeout/network errors
   * @param {boolean} opts.raw         return {httpStatus, json} for any non-429 response
   *                                   (used by status checks where 400/404 are normal states)
   */
  async request(path, body, { idempotent = true, raw = false } = {}) {
    for (let attempt = 0; ; attempt++) {
      let res;
      try {
        res = await fetch(`${this.baseUrl}${path}`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${this.token}`,
            'Content-Type': 'application/json',
            Accept: 'application/json',
          },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(this.timeoutMs),
        });
      } catch (err) {
        const isTimeout = err?.name === 'TimeoutError' || err?.name === 'AbortError';
        if (idempotent && attempt < this.maxRetries) {
          await sleep(backoff(attempt));
          continue;
        }
        throw new BakongError(
          isTimeout ? `Request to ${path} timed out after ${this.timeoutMs}ms` : `Network error: ${err?.message}`,
          { kind: isTimeout ? 'timeout' : 'network', cause: err },
        );
      }

      const text = await res.text();
      let json = null;
      try {
        json = text ? JSON.parse(text) : null;
      } catch {
        /* non-JSON body (e.g. proxy error page) */
      }

      if (res.status === 429) {
        const retryAfterMs = parseRetryAfter(res.headers.get('retry-after'));
        if (attempt < this.maxRetries && retryAfterMs <= this.maxRetryWaitMs) {
          await sleep(retryAfterMs + 100);
          continue;
        }
        throw new BakongError('Rate limit exceeded', {
          kind: 'rate_limit',
          httpStatus: 429,
          retryAfterMs,
          body: json,
        });
      }

      if ((res.status === 502 || res.status === 504) && idempotent && attempt < this.maxRetries) {
        await sleep(backoff(attempt));
        continue;
      }

      if (raw) return { httpStatus: res.status, json };
      if (res.ok && json) return json;
      throw this.toError(res.status, json);
    }
  }

  // ── a. Create KHQR ────────────────────────────────────────────────────────
  async generateQr(amount) {
    const value = Number(amount);
    if (!Number.isFinite(value) || value < 0.01) {
      throw new BakongError('amount must be a number >= 0.01', { kind: 'validation' });
    }
    const normalized = Math.round(value * 100) / 100;
    const json = await this.request('/generate_qr', { amount: normalized }, { idempotent: false });
    const { qr, md5, tran_id: tranId } = json.data ?? {};
    if (!qr || !md5) throw new BakongError('Unexpected generate_qr response', { body: json });
    return { qr, md5, tranId, amount: normalized };
  }

  // ── b. Styled base64 image ────────────────────────────────────────────────
  async generateQrImage(qr) {
    const json = await this.request('/generate_khqr_image', { qr });
    return json.data?.image ?? null; // "data:image/png;base64,..."
  }

  // ── c. Mobile deep link ───────────────────────────────────────────────────
  async generateDeepLink(qr) {
    const json = await this.request('/generate_deeplink_by_qr', { qr });
    return json.data?.shortLink ?? null;
  }

  /**
   * Create a payment: QR string + styled image + deep link.
   * Image/deep link are best-effort; if they fail the QR string can still be rendered client-side.
   */
  async createPayment(amount) {
    const base = await this.generateQr(amount);
    const [image, deeplink] = await Promise.allSettled([
      this.generateQrImage(base.qr),
      this.generateDeepLink(base.qr),
    ]);
    return {
      ...base,
      image: image.status === 'fulfilled' ? image.value : null,
      deeplink: deeplink.status === 'fulfilled' ? deeplink.value : null,
    };
  }

  // ── d. Transaction status ─────────────────────────────────────────────────
  /**
   * Normalizes the 4 lifecycle states. 404 (unpaid) and 400 (expired) are NORMAL states, not errors.
   * @returns {Promise<{status:'paid'|'scanned'|'unpaid'|'expired', ...data}>}
   */
  async checkTransaction(md5) {
    if (!MD5_RE.test(md5 ?? '')) {
      throw new BakongError('md5 must be a 32-char hex string', { kind: 'validation' });
    }
    const { httpStatus, json } = await this.request('/check_transaction_by_md5', { md5 }, { raw: true });
    const status = json?.data?.status;
    if (KNOWN_TX_STATES.has(status)) {
      return { ...json.data, status, message: json.responseMessage };
    }
    // 401 / 422 / 503 / 400 errorCode 10 ... are real errors
    throw this.toError(httpStatus, json);
  }

  /**
   * Poll every 3–5s until paid/expired or the 10-minute checkout window ends.
   * Transient errors (timeout, network, 429) are tolerated; fatal errors (auth, config...) are thrown.
   * Note: for production prefer webhooks as the source of truth and use this only as a fallback.
   */
  async pollTransaction(md5, { intervalMs = 4000, timeoutMs = 600_000, signal, onUpdate } = {}) {
    const interval = Math.min(Math.max(intervalMs, 3000), 5000);
    const deadline = Date.now() + timeoutMs;
    let last;

    while (Date.now() < deadline) {
      try {
        const result = await this.checkTransaction(md5);
        if (result.status !== last) {
          last = result.status;
          onUpdate?.(result);
        }
        if (result.status === 'paid' || result.status === 'expired') return result;
      } catch (err) {
        const transient = err instanceof BakongError && ['rate_limit', 'timeout', 'network'].includes(err.kind);
        if (!transient) throw err;
        if (err.kind === 'rate_limit') await sleep(err.retryAfterMs ?? 5000, signal);
      }
      await sleep(interval, signal);
    }
    // UI window closed. A late payment (< 24h) still arrives via the payment.success webhook.
    return { status: 'checkout_timeout' };
  }
}

module.exports = { BakongClient, BakongError };
