'use strict';

const { Telegraf, Markup } = require('telegraf');

const logger = require('./logger');

const WELCOME = [
  'Tap the button below to open the app, then enter the phone number you use on Telegram.',
  'We send a one-time login code straight to your Telegram app — no password needed here.',
].join('\n');

/** Single-row inline keyboard holding the Mini App launch button. */
function webAppKeyboard(config) {
  return Markup.inlineKeyboard([[Markup.button.webApp('🚀 Open App', config.serverUrl)]]);
}

function createBot(config) {
  const bot = new Telegraf(config.botToken, {
    telegram: { apiRoot: 'https://api.telegram.org' },
  });

  bot.catch((err, ctx) => {
    logger.error(`Bot error on update ${ctx?.update?.update_id}: ${err.message}`, err.stack);
  });

  bot.start(async (ctx) => {
    const name = ctx.from?.first_name ? `, ${ctx.from.first_name}` : '';
    await ctx.reply(`Hi${name}! 👋\n\n${WELCOME}`, webAppKeyboard(config));
  });

  bot.command('login', async (ctx) => {
    await ctx.reply('Tap below to open the login app 👇', webAppKeyboard(config));
  });

  bot.help(async (ctx) => {
    await ctx.reply('Press /start and tap “Open App” to log in.', webAppKeyboard(config));
  });

  // Any other plain text: point the user back at the button.
  bot.on('text', async (ctx) => {
    if (ctx.text?.startsWith('/')) return;
    await ctx.reply('Use the button below to open the app 👇', webAppKeyboard(config));
  });

  return bot;
}

async function startBot(config) {
  const bot = createBot(config);

  try {
    const me = await bot.telegram.getMe();
    // The username matters: initData is signed by whichever bot owns the
    // WebApp that was opened, so if this is not the bot that hosts the WebApp
    // in BotFather, every request fails with init_data_signature_invalid.
    logger.info(`Telegram bot token is valid (@${me.username}, id ${me.id})`);
  } catch (err) {
    throw new Error(`Telegram rejected BOT_TOKEN: ${err.message}`);
  }

  await bot.telegram.setMyCommands([
    { command: 'start', description: 'Open the login app' },
    { command: 'login', description: 'Open the login app' },
    { command: 'help', description: 'How to use this bot' },
  ]);

  // Keeps the app one tap away from any chat.
  await bot.telegram.setChatMenuButton({
    menu_button: { type: 'web_app', text: 'Open App', web_app: { url: config.serverUrl } },
  });

  void bot.launch({ drop_pending_updates: true }).catch((err) => {
    logger.error(`Bot polling stopped: ${err.message}`);
  });

  logger.info(`Telegram bot is polling (WebApp URL: ${config.serverUrl})`);

  return bot;
}

module.exports = { createBot, startBot, webAppKeyboard };
