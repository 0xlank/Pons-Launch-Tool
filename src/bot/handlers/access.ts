import type { Bot, Context } from 'grammy';
import type { BotStore } from '../../storage/store.js';
import {
  buildAccessClearConfirmKeyboard,
  buildCancelInputKeyboard,
} from '../keyboards.js';
import { escapeHtml } from '../messages.js';
import { parseTelegramUserInput } from '../parsers.js';
import type { PendingInputState, SessionManager } from '../session.js';
import { answerCallbackSafe, renderScreen, safeEditOrReply } from '../ui.js';
import { requireOwner } from './auth.js';

export function registerAccessHandlers(
  bot: Bot,
  store: BotStore,
  session: SessionManager,
): void {
  bot.callbackQuery('set:access:menu', async (ctx) => {
    if (!(await requireOwner(ctx, store))) {
      return;
    }
    const userId = ctx.from.id;
    session.clearPendingInput(userId);
    await answerCallbackSafe(ctx);
    await renderScreen(ctx, store, userId, 'set_access');
  });

  bot.callbackQuery('set:access:add', async (ctx) => {
    if (!(await requireOwner(ctx, store))) {
      return;
    }
    const userId = ctx.from.id;
    await answerCallbackSafe(ctx);
    const promptMsgId = await safeEditOrReply(
      ctx,
      [
        '➕ <b>Tambah Authorized User</b>',
        '',
        'Pilih salah satu cara:',
        '1. Ketik <code>&lt;TelegramUserID&gt; [Label Opsional]</code>',
        '   Contoh: <code>123456789 Operator A</code>',
        '2. <b>Forward</b> pesan dari user target langsung ke chat ini.',
        '',
        '<i>Catatan: User baru akan langsung berbagi workspace bersama (wallet, Pinata JWT, settings, draft &amp; preset), kecuali menu Kelola Akses.</i>',
      ].join('\n'),
      buildCancelInputKeyboard(),
    );

    session.setPendingInput(userId, {
      field: 'access_add_user',
      returnScreen: 'set_access',
      sensitive: false,
      promptMessageId: promptMsgId,
      chatId: ctx.chat?.id,
    });
  });

  bot.callbackQuery(/^set:access:del:(\d+)$/, async (ctx) => {
    if (!(await requireOwner(ctx, store))) {
      return;
    }
    const ownerId = ctx.from.id;
    const targetId = Number(ctx.match[1]);

    try {
      const removed = await store.removeAuthorizedUser(ownerId, targetId);
      if (removed) {
        session.revokeUserSession(targetId);
        await answerCallbackSafe(ctx, { text: `✅ Akses user ${targetId} dicabut.` });
      } else {
        await answerCallbackSafe(ctx, { text: `User ${targetId} tidak ditemukan.` });
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      await answerCallbackSafe(ctx, {
        text: `❌ Gagal menghapus user: ${msg}`,
        show_alert: true,
      });
    }

    await renderScreen(ctx, store, ownerId, 'set_access');
  });

  bot.callbackQuery('set:access:clear', async (ctx) => {
    if (!(await requireOwner(ctx, store))) {
      return;
    }
    await answerCallbackSafe(ctx);
    const count = store.listAuthorizedUsers().length;
    await safeEditOrReply(
      ctx,
      [
        '🧹 <b>Konfirmasi Hapus Semua Non-Owner</b>',
        '',
        `Terdapat <b>${count}</b> authorized user non-owner.`,
        'Seluruh user non-owner akan langsung dicabut aksesnya dan sesi aktifnya dihentikan.',
        '<i>Root Owner di .env tidak akan terpengaruh.</i>',
      ].join('\n'),
      buildAccessClearConfirmKeyboard(),
    );
  });

  bot.callbackQuery('set:access:clear:confirm', async (ctx) => {
    if (!(await requireOwner(ctx, store))) {
      return;
    }
    const ownerId = ctx.from.id;
    const removedIds = await store.clearAuthorizedUsersWithIds(ownerId);

    for (const removedId of removedIds) {
      session.revokeUserSession(removedId);
    }

    await answerCallbackSafe(ctx, {
      text: `✅ ${removedIds.length} user non-owner berhasil dihapus.`,
    });
    await renderScreen(ctx, store, ownerId, 'set_access');
  });
}

export async function handleAccessPendingInput(
  ctx: Context,
  store: BotStore,
  session: SessionManager,
  pending: PendingInputState,
): Promise<boolean> {
  if (pending.field !== 'access_add_user') {
    return false;
  }

  if (!(await requireOwner(ctx, store))) {
    if (ctx.from?.id) {
      session.clearPendingInput(ctx.from.id);
    }
    return true;
  }

  const ownerId = ctx.from!.id;
  const message = ctx.message;
  if (!message) {
    return true;
  }

  let targetId: number | undefined;
  let label: string | undefined;

  if (message.forward_origin) {
    const origin = message.forward_origin;
    if (origin.type === 'user') {
      targetId = origin.sender_user.id;
      const parts = [origin.sender_user.first_name, origin.sender_user.last_name].filter(Boolean);
      label = origin.sender_user.username
        ? `@${origin.sender_user.username}`
        : parts.join(' ').trim() || undefined;
    } else {
      await ctx.reply(
        '⚠️ <b>Akun Pengirim Tersembunyi</b>\nPengguna menyembunyikan profilnya pada pesan forward. Silakan ketik <code>TelegramUserID</code> secara manual (contoh: <code>123456789 Nama</code>).',
        { parse_mode: 'HTML', reply_markup: buildCancelInputKeyboard() },
      );
      return true;
    }
  } else if (message.text) {
    const parsed = parseTelegramUserInput(message.text);
    if (!parsed.ok) {
      await ctx.reply(`❌ ${escapeHtml(parsed.error)}`, {
        parse_mode: 'HTML',
        reply_markup: buildCancelInputKeyboard(),
      });
      return true;
    }
    targetId = parsed.value.userId;
    label = parsed.value.label;
  } else {
    await ctx.reply(
      '❌ Kirim angka Telegram User ID atau forward pesan dari user yang ingin diberi akses.',
      { parse_mode: 'HTML', reply_markup: buildCancelInputKeyboard() },
    );
    return true;
  }

  if (store.isOwner(targetId)) {
    await ctx.reply(
      `ℹ️ User <code>${targetId}</code> sudah menjadi Root Owner permanen di <code>.env</code>.`,
      { parse_mode: 'HTML' },
    );
    session.clearPendingInput(ownerId);
    await renderScreen(ctx, store, ownerId, 'set_access', { forceReply: true });
    return true;
  }

  try {
    const added = await store.addAuthorizedUser(ownerId, targetId, label);
    session.clearPendingInput(ownerId);
    const labelText = added.label ? ` (${escapeHtml(added.label)})` : '';
    await ctx.reply(
      `✅ User <code>${added.userId}</code>${labelText} berhasil diberi akses ke bot.`,
      { parse_mode: 'HTML' },
    );
    await renderScreen(ctx, store, ownerId, 'set_access', { forceReply: true });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    await ctx.reply(`❌ Gagal menambahkan user: ${escapeHtml(msg)}`, {
      parse_mode: 'HTML',
      reply_markup: buildCancelInputKeyboard(),
    });
  }

  return true;
}
