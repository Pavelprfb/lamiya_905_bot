'use strict';

const crypto = require('node:crypto');

class InitDataError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'InitDataError';
    this.code = code;
  }
}

function safeEqual(a, b) {
  const bufA = Buffer.from(String(a), 'utf8');
  const bufB = Buffer.from(String(b), 'utf8');
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

function hmac(key, data) {
  return crypto.createHmac('sha256', key).update(data).digest();
}

function parseQueryString(input) {
  const params = new URLSearchParams(input);
  const result = {};
  for (const [key, value] of params.entries()) result[key] = value;
  return result;
}

function parseUser(value) {
  if (!value) return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

/**
 * Verifies the `X-Telegram-Init-Data` header that Telegram attaches to every
 * WebApp request, then returns the trusted user payload.
 *
 * @see https://core.telegram.org/bots/webapps#validating-data-received-via-the-web-app
 */
function verifyInitData(rawInitData, botToken, { maxAgeSec = 86400, now = Date.now() } = {}) {
  if (!rawInitData || typeof rawInitData !== 'string') {
    throw new InitDataError('init_data_missing', 'Missing Telegram init data.');
  }

  const fields = parseQueryString(rawInitData);
  const hash = fields.hash;
  if (!hash) {
    throw new InitDataError('init_data_hash_missing', 'Telegram init data has no signature.');
  }

  const { hash: _hash, signature: _signature, ...rest } = fields;
  const dataCheckString = Object.keys(rest)
    .sort()
    .map((key) => `${key}=${rest[key]}`)
    .join('\n');

  const secretKey = hmac('WebAppData', botToken);
  const expected = hmac(secretKey, dataCheckString).toString('hex');
  if (!safeEqual(expected, hash)) {
    throw new InitDataError('init_data_signature_invalid', 'Telegram init data signature is invalid.');
  }

  const authDate = Number.parseInt(fields.auth_date, 10);
  if (!Number.isFinite(authDate)) {
    throw new InitDataError('init_data_auth_date_missing', 'Telegram init data has no auth_date.');
  }
  if (maxAgeSec > 0 && (now / 1000 - authDate) > maxAgeSec) {
    throw new InitDataError('init_data_expired', 'Telegram init data expired, please reopen the app.');
  }

  const user = parseUser(fields.user);
  if (!user || !user.id) {
    throw new InitDataError('init_data_user_missing', 'Telegram init data has no user.');
  }

  return {
    user: {
      id: String(user.id),
      firstName: user.first_name || '',
      lastName: user.last_name || '',
      username: user.username || '',
      languageCode: user.language_code || '',
      isPremium: Boolean(user.is_premium),
      allowsWriteToPm: user.allows_write_to_pm !== undefined
        ? Boolean(user.allows_write_to_pm)
        : undefined,
      photoUrl: user.photo_url || '',
    },
    authDate,
    startParam: fields.start_param || '',
    chatType: fields.chat_type || '',
    queryId: fields.query_id || '',
  };
}

module.exports = { verifyInitData, InitDataError };
