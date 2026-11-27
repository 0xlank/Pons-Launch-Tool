import type { Bot } from 'grammy';
import { checkRpcHealth, checkWalletsStatus } from '../../blockchain/launcher.js';
import type { BotStore } from '../../storage/store.js';
import {
  buildBackToMainKeyboard,
  buildResetConfirmKeyboard,
} from '../keyboards.js';
import { formatResetConfirm, formatRpcHealthReport } from '../messages.js';
import type { SessionManager } from '../session.js';
import { answerCallbackSafe, renderScreen, safeEditOrReply } from '../ui.js';

export function registerMenuHandlers(
  bot: Bot,
  store: BotStore,
  session: SessionManager,
): void {
  bot.command(['start', 'menu'], async (ctx) => {
    const userId = ctx.from?.id;
    if (!userId) {
      return;
    }
    session.clearPendingInput(userId);
    await renderScreen(ctx, store, userId, 'main', { forceReply: true });
  });

  bot.command('cancel', async (ctx) => {
    const userId = ctx.from?.id;
    if (!userId) {
      return;
    }
    const pending = session.getPendingInput(userId);
    session.clearPendingInput(userId);
    if (pending) {
      await ctx.reply('✅ Input dibatalkan.');
      await renderScreen(ctx, store, userId, pending.returnScreen, { forceReply: true });
    } else {
      await ctx.reply('ℹ️ Tidak ada input yang sedang berlangsung.');
    }
  });

  bot.command('status', async (ctx) => {
    const userId = ctx.from?.id;
    if (!userId) {
      return;
    }
    const profile = store.getUserProfile(userId);
    const wallets = store.getDecryptedWallets(userId);
    const loadingMsg = await ctx.reply('📡 Mengecek koneksi RPC, gas, dan saldo wallet...');

    const [health, walletStatus] = await Promise.all([
      checkRpcHealth(profile.settings.network, profile.settings.contract),
      checkWalletsStatus(profile.settings.network, wallets).catch(() => ({})),
    ]);

    const report = formatRpcHealthReport(
      health,
      walletStatus,
      profile.settings.fee,
      profile.settings.network,
    );

    try {
      await ctx.api.editMessageText(ctx.chat.id, loadingMsg.message_id, report, {
        parse_mode: 'HTML',
        link_preview_options: { is_disabled: true },
        reply_markup: buildBackToMainKeyboard(),
      });
    } catch {
      await ctx.reply(report, {
        parse_mode: 'HTML',
        link_preview_options: { is_disabled: true },
        reply_markup: buildBackToMainKeyboard(),
      });
    }
  });

  bot.callbackQuery('menu:main', async (ctx) => {
    const userId = ctx.from.id;
    session.clearPendingInput(userId);
    await answerCallbackSafe(ctx);
    await renderScreen(ctx, store, userId, 'main');
  });

  bot.callbackQuery('input:cancel', async (ctx) => {
    const userId = ctx.from.id;
    const pending = session.getPendingInput(userId);
    session.clearPendingInput(userId);
    await answerCallbackSafe(ctx, { text: 'Input dibatalkan.' });
    await renderScreen(ctx, store, userId, pending?.returnScreen ?? 'main');
  });

  bot.callbackQuery('rpc:check', async (ctx) => {
    const userId = ctx.from.id;
    session.clearPendingInput(userId);
    await answerCallbackSafe(ctx, { text: 'Mengecek RPC & saldo...' });

    const profile = store.getUserProfile(userId);
    const wallets = store.getDecryptedWallets(userId);

    const [health, walletStatus] = await Promise.all([
      checkRpcHealth(profile.settings.network, profile.settings.contract),
      checkWalletsStatus(profile.settings.network, wallets).catch(() => ({})),
    ]);

    const report = formatRpcHealthReport(
      health,
      walletStatus,
      profile.settings.fee,
      profile.settings.network,
    );

    await safeEditOrReply(ctx, report, buildBackToMainKeyboard());
  });

  bot.callbackQuery('rst:confirm', async (ctx) => {
    const userId = ctx.from.id;
    session.clearPendingInput(userId);
    await answerCallbackSafe(ctx);
    await safeEditOrReply(ctx, formatResetConfirm(), buildResetConfirmKeyboard());
  });

  bot.callbackQuery('rst:exec', async (ctx) => {
    const userId = ctx.from.id;
    if (session.isLaunching(userId)) {
      await answerCallbackSafe(ctx, {
        text: '⏳ Tidak dapat reset saat proses launch sedang berjalan.',
        show_alert: true,
      });
      return;
    }

    session.clearPendingInput(userId);
    session.clearAllLaunchConfirmations();
    await store.resetLaunchData(userId);
    await answerCallbackSafe(ctx, {
      text: '✅ Data launch berhasil di-reset (pengaturan, Pinata & preset tetap aman).',
      show_alert: true,
    });
    await renderScreen(ctx, store, userId, 'main');
  });
}
