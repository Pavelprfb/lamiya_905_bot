'use strict';

const crypto = require('node:crypto');

const logger = require('../logger');

const SWEEP_INTERVAL_MS = 30 * 1000;

/** Simple per-key mutex so one phone number can only be in one login flow. */
class KeyedLock {
  #tails = new Map();

  async run(key, fn) {
    const previous = this.#tails.get(key) ?? Promise.resolve();
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const tail = previous.then(() => gate, () => gate);
    this.#tails.set(key, tail);

    await previous.catch(() => {});
    try {
      return await fn();
    } finally {
      release();
      if (this.#tails.get(key) === tail) this.#tails.delete(key);
    }
  }
}

/**
 * In-memory state for OTP logins that are mid-flight.
 *
 * Each attempt owns a live (but not yet authorized) MTProto client, because the
 * MTProto connection that requested the code is the one that must consume it.
 * Attempts are disposable: nothing sensitive but the phone number and the
 * phoneCodeHash is kept, and everything is wiped on TTL expiry or on success.
 */
class LoginAttemptStore {
  #phoneIndex = new Map();

  constructor({ ttlMs = 10 * 60 * 1000, maxAttempts = 5, resendCooldownMs = 60 * 1000 } = {}) {
    this.ttlMs = ttlMs;
    this.maxAttempts = maxAttempts;
    this.resendCooldownMs = resendCooldownMs;
    this.attempts = new Map();
    this.lock = new KeyedLock();
    this.timer = setInterval(() => this.sweep(), SWEEP_INTERVAL_MS);
    this.timer.unref?.();
  }

  static createId() {
    return crypto.randomBytes(16).toString('hex');
  }

  #isExpired(attempt) {
    return Date.now() > attempt.expiresAt;
  }

  create({ phoneDigits, e164, telegramUserId }) {
    const id = LoginAttemptStore.createId();
    const now = Date.now();
    const attempt = {
      id,
      phoneDigits,
      e164,
      telegramUserId: String(telegramUserId),
      client: null,
      phoneCodeHash: '',
      hint: '',
      needsPassword: false,
      remainingAttempts: this.maxAttempts,
      lastSentAt: now,
      createdAt: now,
      expiresAt: now + this.ttlMs,
    };
    this.attempts.set(id, attempt);
    this.#indexByPhone(phoneDigits, id);
    return attempt;
  }

  #indexByPhone(phoneDigits, id) {
    const existing = this.#phoneIndex.get(phoneDigits);
    if (existing && existing !== id) this.#destroy(existing);
    this.#phoneIndex.set(phoneDigits, id);
  }

  get(id) {
    const attempt = this.attempts.get(id);
    if (!attempt) return null;
    if (this.#isExpired(attempt)) {
      this.#destroy(id);
      return null;
    }
    return attempt;
  }

  getByPhone(phoneDigits) {
    const id = this.#phoneIndex.get(phoneDigits);
    return id ? this.get(id) : null;
  }

  /** Milliseconds left before another code may be requested for this number. */
  resendCooldownRemaining(phoneDigits) {
    const attempt = this.getByPhone(phoneDigits);
    if (!attempt) return 0;
    return Math.max(0, attempt.lastSentAt + this.resendCooldownMs - Date.now());
  }

  markSent(attempt) {
    attempt.lastSentAt = Date.now();
    attempt.expiresAt = Date.now() + this.ttlMs;
  }

  consumeAttempt(attempt) {
    attempt.remainingAttempts -= 1;
    return attempt.remainingAttempts > 0;
  }

  #destroy(id) {
    const attempt = this.attempts.get(id);
    if (!attempt) return;
    this.attempts.delete(id);
    if (this.#phoneIndex.get(attempt.phoneDigits) === id) this.#phoneIndex.delete(attempt.phoneDigits);
    attempt.phoneCodeHash = '';
    if (attempt.client) {
      attempt.client.disconnect().catch((err) => {
        logger.debug(`Failed to disconnect a stale login client: ${err.message}`);
      });
      attempt.client = null;
    }
  }

  destroy(id) {
    this.#destroy(id);
  }

  sweep() {
    for (const id of [...this.attempts.keys()]) {
      if (this.#isExpired(this.attempts.get(id))) {
        logger.debug(`Expired a stale login attempt (${id.slice(0, 8)}…)`);
        this.#destroy(id);
      }
    }
  }

  stop() {
    clearInterval(this.timer);
    for (const id of [...this.attempts.keys()]) this.#destroy(id);
  }
}

module.exports = { LoginAttemptStore, KeyedLock };
