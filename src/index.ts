import { resolve } from 'node:path';
import { Bot } from 'grammy';
import { handleAccessPendingInput, registerAccessHandlers } from './bot/handlers/access.js';
import { createAuthMiddleware } from './bot/handlers/auth.js';
import { registerLaunchHandlers } from './bot/handlers/launch.js';
import { registerMenuHandlers } from './bot/handlers/menu.js';
import { handleSettingsPendingInput, registerSettingsHandlers } from './bot/handlers/settings.js';
import { handleTokenPendingInput, registerTokenHandlers } from './bot/handlers/token.js';
import { handleWalletPendingInput, registerWalletHandlers } from './bot/handlers/wallets.js';
import { looksLikeSensitiveSecret } from './bot/parsers.js';
import { SessionManager } from './bot/session.js';
import { answerCallbackSafe, deleteMessageSafe } from './bot/ui.js';
import { loadEnv } from './config/env.js';
import { BotStore } from './storage/store.js';

function redactBotToken(message: string, botToken: string): string {
  return message
    .replaceAll(botToken, '***')
    .replace(/\/bot\d+:[A-Za-z0-9_-]+/g, '/bot***');
}

async function main(): Promise<void> {
  const env = loadEnv();
  const storePath = resolve(process.cwd(), 'data', 'store.json');

  const store = new BotStore({
    filePath: storePath,
    encryptionKey: env.encryptionKey,
    ownerIds: env.ownerTelegramIds,
    initialAllowedIds: env.allowedTelegramIds,
    bootstrapDefaults: env.bootstrapDefaults,
  });
  await store.init();

  const session = new SessionManager();
  const bot = new Bot(env.botToken);

  bot.catch((err) => {
    const rawMsg = err.error instanceof Error ? err.error.message : String(err.error);
    const message = redactBotToken(rawMsg, env.botToken);
    console.error(`[${new Date().toISOString()}] Bot handler error (update ${err.ctx.update.update_id}): ${message}`);
  });

  // Strict private-chat + authorization gate for all updates
  bot.use(createAuthMiddleware(store));

  // Clear stale pendingInput before any non-cancel callback action to avoid misrouting secrets
  bot.use(async (ctx, next) => {
    if (ctx.callbackQuery?.data && ctx.callbackQuery.data !== 'input:cancel' && ctx.from?.id) {
      session.clearPendingInput(ctx.from.id);
    }
    await next();
  });

  // Register modular command and callback handlers
  registerMenuHandlers(bot, store, session);
  registerWalletHandlers(bot, store, session);
  registerTokenHandlers(bot, store, session);
  registerSettingsHandlers(bot, store, session, env.bootstrapDefaults);
  registerAccessHandlers(bot, store, session);
  registerLaunchHandlers(bot, store, session);

  // Catch-all for unknown or stale inline buttons so Telegram spinner stops cleanly
  bot.on('callback_query:data', async (ctx) => {
    await answerCallbackSafe(ctx, {
      text: '⚠️ Tombol sudah usang. Ketik /menu untuk membuka panel terbaru.',
    });
  });

  // Unified message router for active pending input states
  bot.on('message', async (ctx) => {
    const userId = ctx.from?.id;
    if (!userId) {
      return;
    }

    // Ignore slash commands not handled above
    if (ctx.message.text?.startsWith('/')) {
      return;
    }

    const pending = session.getPendingInput(userId, ctx.chat?.id);
    if (!pending) {
      // Defense-in-depth: immediately delete stray Private Keys or JWTs sent without an active prompt (e.g. after bot restart)
      if (ctx.message.text && looksLikeSensitiveSecret(ctx.message.text)) {
        const deleted = await deleteMessageSafe(ctx);
        const warning = deleted
          ? '🔒 Pesan yang tampak seperti Private Key / JWT terdeteksi tanpa sesi input aktif dan langsung dihapus otomatis.\nGunakan /menu lalu pilih tombol Set terlebih dahulu.'
          : '⚠️ Pesan yang tampak seperti Private Key / JWT terdeteksi tanpa sesi input aktif dan gagal dihapus otomatis — segera hapus pesan Anda secara manual!';
        await ctx.reply(warning);
        return;
      }

      await ctx.reply('ℹ️ Gunakan /menu untuk membuka panel kontrol utama.');
      return;
    }

    if (await handleAccessPendingInput(ctx, store, session, pending)) {
      return;
    }
    if (await handleWalletPendingInput(ctx, store, session, pending)) {
      return;
    }
    if (await handleTokenPendingInput(ctx, store, session, pending, env.botToken)) {
      return;
    }
    if (await handleSettingsPendingInput(ctx, store, session, pending)) {
      return;
    }
  });

  await bot.api.setMyCommands([
    { command: 'start', description: 'Buka menu utama Pons Launch Tool' },
    { command: 'menu', description: 'Tampilkan panel kontrol utama' },
    { command: 'status', description: 'Cek kesehatan RPC, gas, dan saldo wallet' },
    { command: 'cancel', description: 'Batalkan input yang sedang aktif' },
  ]);

  let stopping = false;
  const shutdown = (signal: string): void => {
    if (stopping) {
      return;
    }
    stopping = true;
    console.log(`[${new Date().toISOString()}] Received ${signal}, shutting down gracefully...`);
    void bot.stop();
  };

  process.once('SIGINT', () => shutdown('SIGINT'));
  process.once('SIGTERM', () => shutdown('SIGTERM'));

  console.log(
    `[${new Date().toISOString()}] Pons Launch Tool starting (owners=${store.listOwnerIds().length}, authorizedUsers=${store.listAuthorizedUsers().length})`,
  );

  await bot.start({
    onStart: (botInfo) => {
      console.log(
        `[${new Date().toISOString()}] Bot online as @${botInfo.username} (id=${botInfo.id})`,
      );
    },
  });
}

main().catch((err: unknown) => {
  const rawMsg = err instanceof Error ? err.message : String(err);
  const safeMsg = rawMsg.replace(/\/bot\d+:[A-Za-z0-9_-]+/g, '/bot***');
  console.error(`[${new Date().toISOString()}] Fatal startup error: ${safeMsg}`);
  process.exitCode = 1;
});
