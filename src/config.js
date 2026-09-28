'use strict';

const path = require('node:path');
const dotenv = require('dotenv');

dotenv.config();

const LEVELS = ['debug', 'info', 'warn', 'error'];

class ConfigError extends Error {}

function required(name) {
  const value = process.env[name];
  if (!value || !value.trim()) {
    throw new ConfigError(`Missing required environment variable: ${name}`);
  }
  return value.trim();
}

function asInt(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/**
 * `app.set('trust proxy', …)`. Prefer the hop count (typically 1 behind
 * Cloudflare/nginx) or a subnet/CIDR. `true` trusts every X-Forwarded-For
 * entry, which lets anyone spoof their IP and bypass rate limiting.
 */
function asTrustProxy(value) {
  const raw = String(value ?? '').trim();
  if (raw === '') return 1;
  if (/^\d+$/.test(raw)) return Number.parseInt(raw, 10);
  if (/^(true|yes|on)$/i.test(raw)) return true;
  if (/^(false|no|off)$/i.test(raw)) return false;
  return raw; // loopback, linklocal, 10.0.0.0/8, …
}

function normalizeOrigin(value, name, { allowInsecure = false } = {}) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new ConfigError(`${name} is not a valid URL: ${value}`);
  }
  if (url.protocol !== 'https:' && !(allowInsecure && url.protocol === 'http:')) {
    throw new ConfigError(`${name} must use https:// (Telegram refuses insecure WebApp URLs), got: ${value}`);
  }
  return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
}

function load() {
  const botToken = required('BOT_TOKEN');
  if (!/^\d{6,}:[A-Za-z0-9_-]{30,}$/.test(botToken)) {
    throw new ConfigError('BOT_TOKEN does not look like a Telegram bot token (expected "<botId>:<secret>")');
  }

  const apiId = asInt(required('API_ID'), 0);
  if (apiId <= 0) throw new ConfigError('API_ID must be a positive integer');

  const apiHash = required('API_HASH');
  if (!/^[a-f0-9]{32}$/i.test(apiHash)) {
    throw new ConfigError('API_HASH must be a 32 character hexadecimal string');
  }

  // Telegram only loads a WebApp over HTTPS. The escape hatch is for local
  // development against a tunnel-free http://localhost; never set it in prod.
  const allowInsecure = /^(1|true|yes|on)$/i.test(process.env.ALLOW_INSECURE_SERVER_URL || '');
  const serverUrl = normalizeOrigin(required('SERVER_URL'), 'SERVER_URL', { allowInsecure });
  const redirectUrl = normalizeOrigin(
    process.env.REDIRECT_URL?.trim() || serverUrl,
    'REDIRECT_URL',
    { allowInsecure },
  );

  const logLevel = LEVELS.includes((process.env.LOG_LEVEL || '').toLowerCase())
    ? process.env.LOG_LEVEL.toLowerCase()
    : 'info';

  return {
    botToken,
    botId: Number.parseInt(botToken.split(':')[0], 10),
    apiId,
    apiHash,
    serverUrl,
    redirectUrl,
    port: asInt(process.env.PORT, 3000),
    dataDir: path.resolve(process.env.DATA_DIR?.trim() || path.join(__dirname, '..', 'data')),
    trustProxy: asTrustProxy(process.env.TRUST_PROXY),
    logLevel,
    // Login flow tuning
    otpTtlMs: asInt(process.env.OTP_TTL_MS, 10 * 60 * 1000),
    otpMaxAttempts: asInt(process.env.OTP_MAX_ATTEMPTS, 5),
    resendCooldownMs: asInt(process.env.RESEND_COOLDOWN_MS, 60 * 1000),
    // Telegram WebApp initData is signed with this; never trust it unsigned.
    maxInitDataAgeSec: asInt(process.env.MAX_INIT_DATA_AGE_SEC, 86400),
  };
}

let cached = null;

function getConfig() {
  if (!cached) cached = load();
  return cached;
}

module.exports = { getConfig, ConfigError };
