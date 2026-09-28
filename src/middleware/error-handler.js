'use strict';

const logger = require('../logger');

class HttpError extends Error {
  constructor(status, code, message, meta) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.code = code;
    this.meta = meta;
  }
}

/** 404 for unmatched API routes. */
function notFound(req, res) {
  res.status(404).json({ ok: false, error: 'not_found', message: `No API route for ${req.method} ${req.path}` });
}

/** body-parser failures surface as `type`, not as an HttpError. */
const BODY_ERRORS = {
  'entity.parse.failed': [400, 'invalid_json', 'The request body was not valid JSON.'],
  'entity.too.large': [413, 'payload_too_large', 'The request body was too large.'],
  'encoding.unsupported': [415, 'unsupported_encoding', 'Unsupported request encoding.'],
  'request.aborted': [400, 'request_aborted', 'The request was aborted.'],
};

function normalizeError(err) {
  const mapped = BODY_ERRORS[err?.type];
  if (!mapped) return err;
  return new HttpError(mapped[0], mapped[1], mapped[2]);
}

/** Terminal error handler: never leak stack traces to the client. */
// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, next) {
  const error = normalizeError(err);
  const status = error.status || error.statusCode || 500;
  const code = error.code || 'internal_error';

  if (status >= 500) {
    logger.error(`${req.method} ${req.originalUrl} -> ${status} ${code}: ${error.message}`, error.stack);
  } else {
    logger.info(`${req.method} ${req.originalUrl} -> ${status} ${code}: ${error.message}`);
  }

  if (res.headersSent) return;

  res.status(status).json({
    ok: false,
    error: code,
    message: status >= 500 ? 'Something went wrong on our side, please try again.' : error.message,
    ...(error.meta ? { meta: error.meta } : {}),
  });
}

/** Wrap an async handler so rejections reach the error handler. */
function asyncHandler(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

module.exports = { HttpError, notFound, errorHandler, asyncHandler };
