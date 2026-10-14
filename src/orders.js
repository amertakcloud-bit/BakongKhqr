'use strict';

/**
 * In-memory order store — for demo only.
 * In production use a database (Postgres/MongoDB/Redis) with a UNIQUE index on md5,
 * and make markPaid an atomic conditional update:
 *   UPDATE orders SET status='paid' WHERE md5=$1 AND status <> 'paid'  -- check affected rows
 */

const store = new Map();

module.exports = {
  create(order) {
    const record = { status: 'unpaid', lastCheckedAt: 0, createdAt: Date.now(), ...order };
    store.set(record.md5.toLowerCase(), record);
    return record;
  },

  get(md5) {
    return store.get(String(md5).toLowerCase());
  },

  /** Returns true only on the FIRST transition to paid (idempotent fulfillment guard). */
  markPaid(md5, data = {}) {
    const order = this.get(md5);
    if (!order || order.status === 'paid') return false;
    order.status = 'paid';
    order.paidAt = data.paid_at || new Date().toISOString();
    order.hash = data.hash;
    return true;
  },

  setStatus(md5, status) {
    const order = this.get(md5);
    if (order && order.status !== 'paid') order.status = status;
    return order;
  },
};
