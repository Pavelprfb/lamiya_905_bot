'use strict';

const { verifyInitData, InitDataError } = require('../utils/telegram-init-data');
const logger = require('../logger');

const HEADER = 'x-telegram-init-data';

/**
 * Rejects any request that does not carry a validly signed Telegram WebApp
 * initData payload, and exposes the trusted user as `req.telegramUser`.
 */
function requireTelegramAuth(config) {
  return function telegramAuth(req, res, next) {
    const raw =
      req.get(HEADER) ||
      req.query.__initData ||
      (req.get('authorization') || '').replace(/^Bearer\s+/i, '');

    if (!raw) {
      res.status(401).json({
        ok: false,
        error: 'unauthorized',
        message: 'This endpoint must be called from inside the Telegram Mini App.',
      });
      return;
    }

    try {
      const payload = verifyInitData(raw, config.botToken, { maxAgeSec: config.maxInitDataAgeSec });
      req.telegram = payload;
      req.telegramUser = payload.user;
      next();
    } catch (err) {
      const known = err instanceof InitDataError;
      logger.warn(`Rejected a WebApp request: ${known ? err.code : 'unknown_error'}`);
      res.status(401).json({
        ok: false,
        error: known ? err.code : 'unauthorized',
        message: known ? err.message : 'Could not verify your Telegram session.',
      });
    }
  };
}

module.exports = { requireTelegramAuth, INIT_DATA_HEADER: HEADER };
