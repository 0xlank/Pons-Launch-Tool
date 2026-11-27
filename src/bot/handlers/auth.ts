import type { Context, MiddlewareFn } from 'grammy';
import type { BotStore } from '../../storage/store.js';
import { escapeHtml } from '../messages.js';
import { answerCallbackSafe } from '../ui.js';

export function createAuthMiddleware(store: BotStore): MiddlewareFn<Context> {
  return async (ctx, next) => {
    // Strictly restrict all bot interactions to private DMs so secrets never leak in groups
    if (ctx.chat && ctx.chat.type !== 'private') {
      if (ctx.callbackQuery) {
        await answerCallbackSafe(ctx, {
          text: '⛔ Bot hanya dapat digunakan di chat pribadi (DM).',
          show_alert: true,
        });
      }
      return;
    }

    const userId = ctx.from?.id;
    if (!userId || !store.isAuthorized(userId)) {
      if (ctx.callbackQuery) {
        await answerCallbackSafe(ctx, {
          text: '⛔ Akses ditolak. Akun Anda tidak memiliki izin.',
          show_alert: true,
        });
        return;
      }

      if (ctx.chat?.type === 'private') {
        const idText = userId ? `<code>${escapeHtml(String(userId))}</code>` : '<i>tidak diketahui</i>';
        await ctx.reply(
          `⛔ <b>Akses Ditolak</b>\nTelegram User ID Anda (${idText}) belum terdaftar.\nHubungi Owner bot untuk meminta izin akses.`,
          { parse_mode: 'HTML' },
        );
      }
      return;
    }

    await store.ensureUserProfile(userId);
    await next();
  };
}

export async function requireOwner(ctx: Context, store: BotStore): Promise<boolean> {
  const userId = ctx.from?.id;
  if (userId && store.isOwner(userId)) {
    return true;
  }

  if (ctx.callbackQuery) {
    await answerCallbackSafe(ctx, {
      text: '⛔ Hanya Root Owner yang dapat mengakses menu ini.',
      show_alert: true,
    });
  } else {
    await ctx.reply('⛔ <b>Khusus Root Owner</b>\nAnda tidak memiliki izin untuk menjalankan aksi ini.', {
      parse_mode: 'HTML',
    });
  }
  return false;
}
