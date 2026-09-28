'use strict';

const http = require('node:http');

const { getConfig, ConfigError } = require('./config');
const logger = require('./logger');
const { createApp } = require('./app');
const { SessionStore } = require('./services/session-store');
const { LoginAttemptStore } = require('./services/login-attempts');
const { TelegramAuthService } = require('./services/telegram-auth');
const { startBot } = require('./bot');

let shuttingDown = false;

async function main() {
  let config;
  try {
    config = getConfig();
  } catch (err) {
    if (err instanceof ConfigError) {
      console.error(`\n[config] ${err.message}\n`);
      process.exit(1);
    }
    throw err;
  }

  logger.setLevel(config.logLevel);

  if (config.trustProxy === true) {
    logger.warn(
      'TRUST_PROXY=true trusts every X-Forwarded-For hop, so clients can spoof their IP ' +
        'and evade rate limiting. Prefer the number of proxy hops (e.g. TRUST_PROXY=1).',
    );
  }

  const sessionStore = new SessionStore({ dataDir: config.dataDir });
  await sessionStore.init();

  const attempts = new LoginAttemptStore({
    ttlMs: config.otpTtlMs,
    maxAttempts: config.otpMaxAttempts,
    resendCooldownMs: config.resendCooldownMs,
  });
  const authService = new TelegramAuthService(config);

  const app = createApp({ config, sessionStore, authService, attempts });
  const server = http.createServer(app);
  server.keepAliveTimeout = 65_000;
  server.headersTimeout = 66_000;

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.port, '0.0.0.0', resolve);
  });

  logger.info(`HTTP server listening on http://0.0.0.0:${config.port}`);
  logger.info(`Sessions live in ${config.dataDir} (${sessionStore.count()} stored)`);
  logger.info(`Users are redirected to ${config.redirectUrl} after login`);

  let bot = null;
  try {
    bot = await startBot(config);
  } catch (err) {
    logger.error(`Could not start the Telegram bot: ${err.message}`);
    logger.error('The WebApp is still being served, but /start will not respond.');
  }

  const shutdown = async (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info(`${signal} received, shutting down…`);

    const forced = setTimeout(() => process.exit(1), 10_000);
    forced.unref();

    try {
      attempts.stop();
      server.close();
      if (bot) await bot.stop('shutdown').catch(() => {});
      logger.info('Goodbye.');
      process.exit(0);
    } catch (err) {
      logger.error(`Unclean shutdown: ${err.message}`);
      process.exit(1);
    }
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('unhandledRejection', (reason) => {
    logger.error('Unhandled promise rejection', reason instanceof Error ? reason.stack : reason);
  });
  process.on('uncaughtException', (err) => {
    logger.error('Uncaught exception', err.stack || err);
    void shutdown('uncaughtException');
  });
}

main().catch((err) => {
  console.error('[fatal]', err);
  process.exit(1);
});
