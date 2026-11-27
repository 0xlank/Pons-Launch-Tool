import type { Bot, Context } from 'grammy';
import { privateKeyToAccount } from 'viem/accounts';
import { checkWalletsStatus, extractBlockchainError } from '../../blockchain/launcher.js';
import type { BotStore } from '../../storage/store.js';
import {
  buildCancelInputKeyboard,
  buildWalletClearConfirmKeyboard,
  buildWalletMenuKeyboard,
} from '../keyboards.js';
import { escapeHtml, formatWalletMenu } from '../messages.js';
import { parseEvmAddress, parsePrivateKey, truncateText } from '../parsers.js';
import type { PendingInputState, SessionManager } from '../session.js';
import {
  answerCallbackSafe,
  deleteMessageSafe,
  deriveWalletAddresses,
  renderScreen,
  safeEditOrReply,
} from '../ui.js';

export function registerWalletHandlers(
  bot: Bot,
  store: BotStore,
  session: SessionManager,
): void {
  bot.callbackQuery('wal:menu', async (ctx) => {
    const userId = ctx.from.id;
    session.clearPendingInput(userId);
    await answerCallbackSafe(ctx);
    await renderScreen(ctx, store, userId, 'wallets');
  });

  bot.callbackQuery('wal:refresh', async (ctx) => {
    const userId = ctx.from.id;
    session.clearPendingInput(userId);
    await answerCallbackSafe(ctx, { text: 'Mengambil saldo & status EIP-7702...' });

    const profile = store.getUserProfile(userId);
    const wallets = store.getDecryptedWallets(userId);
    const derived = deriveWalletAddresses(store, userId);

    try {
      const status = await checkWalletsStatus(profile.settings.network, wallets);
      await safeEditOrReply(
        ctx,
        formatWalletMenu(profile, status, derived),
        buildWalletMenuKeyboard(),
      );
    } catch (err: unknown) {
      await safeEditOrReply(
        ctx,
        `${formatWalletMenu(profile, undefined, derived)}\n\n⚠️ <b>Gagal refresh RPC:</b> <code>${escapeHtml(truncateText(extractBlockchainError(err), 600))}</code>`,
        buildWalletMenuKeyboard(),
      );
    }
  });

  bot.callbackQuery('wal:set:sponsor', async (ctx) => {
    const userId = ctx.from.id;
    await answerCallbackSafe(ctx);
    const msgId = await safeEditOrReply(
      ctx,
      [
        '🔑 <b>Set / Ganti Sponsor Wallet Private Key</b>',
        '',
        'Kirim Private Key Sponsor Wallet (64 karakter hex, dengan atau tanpa awalan <code>0x</code>).',
        '<i>🔒 Pesan Anda akan langsung dihapus otomatis dan disimpan terenkripsi AES-256-GCM.</i>',
      ].join('\n'),
      buildCancelInputKeyboard(),
    );

    session.setPendingInput(userId, {
      field: 'wallet_sponsor_pk',
      returnScreen: 'wallets',
      sensitive: true,
      promptMessageId: msgId,
      chatId: ctx.chat?.id,
    });
  });

  bot.callbackQuery('wal:set:target', async (ctx) => {
    const userId = ctx.from.id;
    await answerCallbackSafe(ctx);
    const msgId = await safeEditOrReply(
      ctx,
      [
        '🎯 <b>Set / Ganti Target Wallet Private Key (Token Creator)</b>',
        '',
        'Kirim Private Key Target Wallet (64 karakter hex, dengan atau tanpa awalan <code>0x</code>).',
        'Wallet ini menjadi Creator token di on-chain dan delegasi EIP-7702-nya akan otomatis di-revoke saat launch.',
        '<i>🔒 Pesan Anda akan langsung dihapus otomatis dan disimpan terenkripsi AES-256-GCM.</i>',
      ].join('\n'),
      buildCancelInputKeyboard(),
    );

    session.setPendingInput(userId, {
      field: 'wallet_target_pk',
      returnScreen: 'wallets',
      sensitive: true,
      promptMessageId: msgId,
      chatId: ctx.chat?.id,
    });
  });

  bot.callbackQuery('wal:set:fee_rec', async (ctx) => {
    const userId = ctx.from.id;
    await answerCallbackSafe(ctx);
    const msgId = await safeEditOrReply(
      ctx,
      [
        '💸 <b>Set / Ganti Creator Fee Wallet</b>',
        '',
        'Kirim alamat EVM tujuan penerima creator fee (<code>0x...</code>).',
        '<i>⚠️ Wajib alamat valid, bukan zero address, dan bukan Target Wallet.</i>',
      ].join('\n'),
      buildCancelInputKeyboard(),
    );

    session.setPendingInput(userId, {
      field: 'wallet_creator_fee_recipient',
      returnScreen: 'wallets',
      sensitive: false,
      promptMessageId: msgId,
      chatId: ctx.chat?.id,
    });
  });

  bot.callbackQuery('wal:clear', async (ctx) => {
    const userId = ctx.from.id;
    session.clearPendingInput(userId);
    await answerCallbackSafe(ctx);
    await safeEditOrReply(
      ctx,
      '🗑️ <b>Konfirmasi Hapus Wallet</b>\n\nHapus Sponsor Private Key dan Target Private Key yang tersimpan?',
      buildWalletClearConfirmKeyboard(),
    );
  });

  bot.callbackQuery('wal:clear:yes', async (ctx) => {
    const userId = ctx.from.id;
    if (session.isLaunching(userId)) {
      await answerCallbackSafe(ctx, {
        text: '⏳ Tidak dapat menghapus wallet saat launch sedang berjalan.',
        show_alert: true,
      });
      return;
    }

    await store.clearAllWallets(userId);
    session.clearAllLaunchConfirmations();
    await answerCallbackSafe(ctx, { text: '✅ Sponsor & Target wallet berhasil dihapus.' });
    await renderScreen(ctx, store, userId, 'wallets');
  });
}

export async function handleWalletPendingInput(
  ctx: Context,
  store: BotStore,
  session: SessionManager,
  pending: PendingInputState,
): Promise<boolean> {
  if (
    pending.field !== 'wallet_sponsor_pk' &&
    pending.field !== 'wallet_target_pk' &&
    pending.field !== 'wallet_creator_fee_recipient'
  ) {
    return false;
  }

  const userId = ctx.from!.id;
  const text = ctx.message?.text ?? '';

  if (pending.field === 'wallet_sponsor_pk' || pending.field === 'wallet_target_pk') {
    // Always delete the incoming sensitive chat message immediately
    const deleted = await deleteMessageSafe(ctx);
    const deleteNote = deleted
      ? '<i>Pesan berisi private key sudah dihapus otomatis.</i>'
      : '<i>⚠️ Bot gagal menghapus pesan secara otomatis — segera hapus pesan private key Anda secara manual!</i>';

    const parsed = parsePrivateKey(text);
    if (!parsed.ok) {
      await ctx.reply(`❌ ${escapeHtml(parsed.error)}\n${deleteNote}`, {
        parse_mode: 'HTML',
        reply_markup: buildCancelInputKeyboard(),
      });
      return true;
    }

    let account: ReturnType<typeof privateKeyToAccount>;
    try {
      account = privateKeyToAccount(parsed.value);
    } catch {
      await ctx.reply(
        `❌ Private key tidak dapat diproses menjadi akun EVM valid.\n${deleteNote}`,
        { parse_mode: 'HTML', reply_markup: buildCancelInputKeyboard() },
      );
      return true;
    }

    const derived = deriveWalletAddresses(store, userId);

    if (
      pending.field === 'wallet_sponsor_pk' &&
      derived.targetAddress &&
      derived.targetAddress.toLowerCase() === account.address.toLowerCase()
    ) {
      await ctx.reply(
        `❌ Sponsor Wallet tidak boleh sama dengan Target Wallet. Gunakan 2 wallet berbeda.\n${deleteNote}`,
        { parse_mode: 'HTML', reply_markup: buildCancelInputKeyboard() },
      );
      return true;
    }

    if (
      pending.field === 'wallet_target_pk' &&
      derived.sponsorAddress &&
      derived.sponsorAddress.toLowerCase() === account.address.toLowerCase()
    ) {
      await ctx.reply(
        `❌ Target Wallet tidak boleh sama dengan Sponsor Wallet. Gunakan 2 wallet berbeda.\n${deleteNote}`,
        { parse_mode: 'HTML', reply_markup: buildCancelInputKeyboard() },
      );
      return true;
    }

    if (pending.field === 'wallet_target_pk') {
      const currentRecipient = store.getUserProfile(userId).settings.fee.creatorFeeRecipient.trim();
      if (currentRecipient && currentRecipient.toLowerCase() === account.address.toLowerCase()) {
        await ctx.reply(
          `❌ Target Wallet tidak boleh sama dengan Creator Fee Wallet yang sedang aktif (<code>${escapeHtml(currentRecipient)}</code>). Ganti Creator Fee Wallet terlebih dahulu atau gunakan Target Wallet lain.\n${deleteNote}`,
          { parse_mode: 'HTML', reply_markup: buildCancelInputKeyboard() },
        );
        return true;
      }
    }

    if (pending.field === 'wallet_sponsor_pk') {
      await store.setSponsorPrivateKey(userId, parsed.value);
      session.clearPendingInput(userId);
      session.clearAllLaunchConfirmations();
      await ctx.reply(
        `✅ <b>Sponsor Wallet tersimpan!</b>\nAlamat: <code>${escapeHtml(account.address)}</code>\n${deleteNote}`,
        { parse_mode: 'HTML' },
      );
    } else {
      await store.setTargetPrivateKey(userId, parsed.value);
      session.clearPendingInput(userId);
      session.clearAllLaunchConfirmations();
      await ctx.reply(
        `✅ <b>Target Wallet tersimpan!</b>\nAlamat: <code>${escapeHtml(account.address)}</code>\n${deleteNote}`,
        { parse_mode: 'HTML' },
      );
    }

    await renderScreen(ctx, store, userId, pending.returnScreen, { forceReply: true });
    return true;
  }

  // wallet_creator_fee_recipient
  const parsedAddr = parseEvmAddress(text, { allowZero: false });
  if (!parsedAddr.ok) {
    await ctx.reply(`❌ ${escapeHtml(parsedAddr.error)}`, {
      parse_mode: 'HTML',
      reply_markup: buildCancelInputKeyboard(),
    });
    return true;
  }

  const derived = deriveWalletAddresses(store, userId);
  if (
    derived.targetAddress &&
    derived.targetAddress.toLowerCase() === parsedAddr.value.toLowerCase()
  ) {
    await ctx.reply(
      '❌ Creator Fee Wallet tidak boleh sama dengan Target Wallet (Token Creator).',
      { parse_mode: 'HTML', reply_markup: buildCancelInputKeyboard() },
    );
    return true;
  }

  await store.updateUserSettings(userId, (settings) => {
    settings.fee.creatorFeeRecipient = parsedAddr.value;
  });
  session.clearPendingInput(userId);
  session.clearAllLaunchConfirmations();
  await ctx.reply(
    `✅ <b>Creator Fee Wallet tersimpan!</b>\nAlamat: <code>${escapeHtml(parsedAddr.value)}</code>`,
    { parse_mode: 'HTML' },
  );
  await renderScreen(ctx, store, userId, pending.returnScreen, { forceReply: true });
  return true;
}
