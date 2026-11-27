import type { Bot } from 'grammy';
import { InlineKeyboard } from 'grammy';
import { isAddress, zeroAddress } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import {
  executeLaunch,
  extractBlockchainError,
  simulateLaunch,
} from '../../blockchain/launcher.js';
import type { BotStore } from '../../storage/store.js';
import type { PartialDecryptedWallets, UserProfile } from '../../types/domain.js';
import {
  buildLaunchConfirmKeyboard,
  buildPostSimulationKeyboard,
} from '../keyboards.js';
import {
  escapeHtml,
  formatLaunchConfirm,
  formatLaunchResult,
  formatSimulationReport,
  formatTxLink,
} from '../messages.js';
import { truncateText } from '../parsers.js';
import type { SessionManager } from '../session.js';
import { answerCallbackSafe, safeEditOrReply } from '../ui.js';

export function getMissingLaunchRequirements(
  profile: UserProfile,
  wallets: PartialDecryptedWallets,
): string[] {
  const missing: string[] = [];

  if (!wallets.sponsorPk) {
    missing.push('Sponsor Wallet Private Key belum diatur');
  }
  if (!wallets.targetPk) {
    missing.push('Target Wallet Private Key belum diatur');
  }

  let sponsorAddr: string | undefined;
  let targetAddr: string | undefined;
  if (wallets.sponsorPk) {
    sponsorAddr = privateKeyToAccount(wallets.sponsorPk).address.toLowerCase();
  }
  if (wallets.targetPk) {
    targetAddr = privateKeyToAccount(wallets.targetPk).address.toLowerCase();
  }
  if (sponsorAddr && targetAddr && sponsorAddr === targetAddr) {
    missing.push('Sponsor Wallet dan Target Wallet tidak boleh sama');
  }

  const feeRecipient = profile.settings.fee.creatorFeeRecipient.trim();
  if (!feeRecipient) {
    missing.push('Creator Fee Wallet (Recipient) WAJIB diisi secara eksplisit');
  } else if (!isAddress(feeRecipient)) {
    missing.push('Creator Fee Wallet bukan alamat EVM yang valid');
  } else if (feeRecipient.toLowerCase() === zeroAddress.toLowerCase()) {
    missing.push('Creator Fee Wallet tidak boleh zero address');
  } else if (targetAddr && feeRecipient.toLowerCase() === targetAddr) {
    missing.push('Creator Fee Wallet tidak boleh sama dengan Target Wallet');
  }

  if (!profile.tokenDraft.name.trim()) {
    missing.push('Nama Token belum diisi');
  }
  if (!profile.tokenDraft.symbol.trim()) {
    missing.push('Symbol Token belum diisi');
  }
  if (!profile.tokenDraft.logo.trim()) {
    missing.push('Logo Token belum diisi');
  }

  return missing;
}

function buildFixRequirementsKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text('👛 Atur Wallet', 'wal:menu')
    .text('🪙 Edit Token', 'tok:menu')
    .row()
    .text('🏠 Menu Utama', 'menu:main');
}

function buildPostLaunchKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text('🧹 Reset Data Launch', 'rst:confirm')
    .text('📡 Cek Saldo', 'rpc:check')
    .row()
    .text('🏠 Menu Utama', 'menu:main');
}

export function registerLaunchHandlers(
  bot: Bot,
  store: BotStore,
  session: SessionManager,
): void {
  bot.callbackQuery('launch:sim', async (ctx) => {
    const userId = ctx.from.id;
    session.clearPendingInput(userId);

    const profile = store.getUserProfile(userId);
    const wallets = store.getDecryptedWallets(userId);
    const missing = getMissingLaunchRequirements(profile, wallets);

    if (missing.length > 0) {
      await answerCallbackSafe(ctx, {
        text: '⚠️ Data launch belum lengkap.',
        show_alert: true,
      });
      await safeEditOrReply(
        ctx,
        [
          '⚠️ <b>Simulasi Tidak Dapat Dijalankan</b>',
          '',
          'Lengkapi persyaratan berikut terlebih dahulu:',
          ...missing.map((item) => `• ${escapeHtml(item)}`),
        ].join('\n'),
        buildFixRequirementsKeyboard(),
      );
      return;
    }

    await answerCallbackSafe(ctx, { text: 'Menjalankan simulasi on-chain...' });
    await safeEditOrReply(
      ctx,
      '🧪 <b>Menjalankan Simulasi (Dry Run)...</b>\nMengecek saldo, delegasi EIP-7702, gas, dan simulasi <code>launchToken</code> dengan state override...',
    );

    try {
      const sim = await simulateLaunch(profile.settings, wallets, profile.tokenDraft);
      await safeEditOrReply(
        ctx,
        formatSimulationReport(sim, profile.settings.network, profile.tokenDraft),
        buildPostSimulationKeyboard(),
      );
    } catch (err: unknown) {
      await safeEditOrReply(
        ctx,
        [
          '❌ <b>Simulasi Launch Gagal</b>',
          '',
          `<code>${escapeHtml(truncateText(extractBlockchainError(err), 800))}</code>`,
        ].join('\n'),
        buildFixRequirementsKeyboard(),
      );
    }
  });

  bot.callbackQuery('launch:prepare', async (ctx) => {
    const userId = ctx.from.id;
    session.clearPendingInput(userId);

    if (session.isLaunching(userId)) {
      await answerCallbackSafe(ctx, {
        text: '⏳ Proses launch sedang berlangsung. Harap tunggu hingga selesai.',
        show_alert: true,
      });
      return;
    }

    const profile = store.getUserProfile(userId);
    const wallets = store.getDecryptedWallets(userId);
    const missing = getMissingLaunchRequirements(profile, wallets);

    if (missing.length > 0) {
      await answerCallbackSafe(ctx, {
        text: '⚠️ Data launch belum lengkap.',
        show_alert: true,
      });
      await safeEditOrReply(
        ctx,
        [
          '⚠️ <b>Launch Diblokir — Persyaratan Belum Lengkap</b>',
          '',
          ...missing.map((item) => `• ${escapeHtml(item)}`),
        ].join('\n'),
        buildFixRequirementsKeyboard(),
      );
      return;
    }

    await answerCallbackSafe(ctx, { text: 'Memverifikasi pre-flight...' });
    await safeEditOrReply(
      ctx,
      '⏳ <b>Menyiapkan Konfirmasi Launch...</b>\nMenjalankan pre-flight simulasi terbaru untuk mengunci salt dan memprediksi alamat Token &amp; Curve...',
    );

    try {
      const sim = await simulateLaunch(profile.settings, wallets, profile.tokenDraft);
      const confirmation = session.createLaunchConfirmation(userId, {
        chatId: ctx.chat?.id,
        salt: sim.salt,
        predictedToken: sim.predictedToken,
        predictedCurve: sim.predictedCurve,
        launchFeeWei: sim.fee,
        fundWei: sim.fundWei,
        creatorFeeRecipient: sim.creatorFeeRecipient,
      });

      await safeEditOrReply(
        ctx,
        formatLaunchConfirm(sim, profile),
        buildLaunchConfirmKeyboard(confirmation.confirmId),
      );
    } catch (err: unknown) {
      await safeEditOrReply(
        ctx,
        [
          '❌ <b>Pre-Flight Launch Gagal</b>',
          '',
          `<code>${escapeHtml(truncateText(extractBlockchainError(err), 800))}</code>`,
        ].join('\n'),
        buildFixRequirementsKeyboard(),
      );
    }
  });

  // Legacy static callback guard for old confirmation messages
  bot.callbackQuery('launch:exec', async (ctx) => {
    await answerCallbackSafe(ctx, {
      text: '⚠️ Tombol konfirmasi lama sudah kedaluwarsa. Klik Launch Token untuk simulasi ulang.',
      show_alert: true,
    });
  });

  bot.callbackQuery(/^launch:exec:([0-9a-f]{12})$/, async (ctx) => {
    const userId = ctx.from.id;
    const confirmId = ctx.match[1];
    const chatId = ctx.chat?.id;
    session.clearPendingInput(userId);

    // Atomically consume single-use confirmation token BEFORE any await
    const confirmed = session.consumeLaunchConfirmation(userId, confirmId, chatId);
    if (!confirmed) {
      await answerCallbackSafe(ctx, {
        text: '⚠️ Konfirmasi sudah terpakai atau kedaluwarsa (>90 dtk). Klik Launch Token untuk simulasi baru.',
        show_alert: true,
      });
      return;
    }

    if (!session.tryAcquireLaunchLock(userId)) {
      await answerCallbackSafe(ctx, {
        text: '⏳ Launch sudah sedang berjalan! Jangan klik ganda.',
        show_alert: true,
      });
      return;
    }

    const profile = store.getUserProfile(userId);
    const wallets = store.getDecryptedWallets(userId);
    const missing = getMissingLaunchRequirements(profile, wallets);

    if (missing.length > 0) {
      session.releaseLaunchLock(userId);
      await answerCallbackSafe(ctx, {
        text: '⚠️ Data launch belum lengkap.',
        show_alert: true,
      });
      await safeEditOrReply(
        ctx,
        [
          '⚠️ <b>Eksekusi Launch Dibatalkan</b>',
          '',
          ...missing.map((item) => `• ${escapeHtml(item)}`),
        ].join('\n'),
        buildFixRequirementsKeyboard(),
      );
      return;
    }

    await answerCallbackSafe(ctx, { text: '🚀 Memulai eksekusi launch!' });

    const progressMsgId = await safeEditOrReply(
      ctx,
      [
        '🚀 <b>Eksekusi Launch Dimulai...</b>',
        '',
        '1️⃣ Menjalankan pre-flight &amp; pre-signing 3 transaksi lokal (Revoke EIP-7702, Fund, Launch)...',
        '<i>Mohon tunggu — jalur hot-path berjalan tanpa hambatan.</i>',
      ].join('\n'),
    );

    const api = ctx.api;
    const signal = session.getLaunchAbortSignal(userId);

    // Run launch execution detached so grammY sequential polling never freezes for Owners or other users
    void (async () => {
      let finalized = false;
      let editChain: Promise<void> = Promise.resolve();

      const enqueueProgressEdit = (html: string): Promise<void> => {
        if (!chatId || !progressMsgId || finalized) {
          return Promise.resolve();
        }
        editChain = editChain.then(async () => {
          if (finalized) {
            return;
          }
          try {
            await api.editMessageText(chatId, progressMsgId, html, {
              parse_mode: 'HTML',
              link_preview_options: { is_disabled: true },
            });
          } catch {
            // Ignore non-critical progress UI update failures
          }
        });
        return editChain;
      };

      const deliverFinalMessage = async (
        html: string,
        replyMarkup: InlineKeyboard,
      ): Promise<void> => {
        finalized = true;
        // Wait for any in-flight progress edit to finish so it can never overwrite the final card
        await editChain.catch(() => undefined);

        const safeHtml = html.length > 4000 ? `${html.slice(0, 3980)}\n...` : html;
        if (chatId && progressMsgId) {
          try {
            await api.editMessageText(chatId, progressMsgId, safeHtml, {
              parse_mode: 'HTML',
              link_preview_options: { is_disabled: true },
              reply_markup: replyMarkup,
            });
            return;
          } catch {
            // Fall through to sendMessage
          }
        }
        if (chatId) {
          await api
            .sendMessage(chatId, safeHtml, {
              parse_mode: 'HTML',
              link_preview_options: { is_disabled: true },
              reply_markup: replyMarkup,
            })
            .catch(() => undefined);
        }
      };

      try {
        const explorerUrl = profile.settings.network.explorerUrl;
        const result = await executeLaunch(
          profile.settings,
          wallets,
          profile.tokenDraft,
          {
            onRevokeSent: (revokeHash) => {
              // Non-blocking notification fired during hot path (serialized via editChain + finalized guard)
              void enqueueProgressEdit(
                [
                  '⚡ <b>Hot-Path Aktif!</b>',
                  '',
                  `• Revoke EIP-7702 terkirim: ${formatTxLink(explorerUrl, revokeHash)}`,
                  '• Menjalankan Fund + Burst Launch secara paralel...',
                ].join('\n'),
              );
            },
            onBroadcastComplete: async (summary) => {
              await enqueueProgressEdit(
                [
                  '📡 <b>Broadcast Selesai — Menunggu Konfirmasi Block...</b>',
                  '',
                  `• Revoke TX: ${formatTxLink(explorerUrl, summary.revokeHash)}`,
                  `• Fund TX: ${summary.fundHash ? formatTxLink(explorerUrl, summary.fundHash) : escapeHtml(truncateText(summary.fundError ?? '-', 200))}`,
                  `• Launch TX: ${formatTxLink(explorerUrl, summary.launchHash)}`,
                  `• Burst: <code>${summary.attempts}</code> kali dalam <code>${summary.broadcastDurationMs} ms</code>`,
                ].join('\n'),
              );
            },
          },
          undefined,
          {
            preparedSalt: confirmed.salt,
            expectedLaunchFeeWei: confirmed.launchFeeWei,
            signal,
            checkAuthorized: () => store.isAuthorized(userId),
          },
        );

        await deliverFinalMessage(
          formatLaunchResult(result, profile.tokenDraft),
          buildPostLaunchKeyboard(),
        );
      } catch (err: unknown) {
        const errorHtml = [
          '❌ <b>Eksekusi Launch Gagal</b>',
          '',
          `<code>${escapeHtml(truncateText(extractBlockchainError(err), 800))}</code>`,
        ].join('\n');

        await deliverFinalMessage(errorHtml, buildFixRequirementsKeyboard());
      } finally {
        session.releaseLaunchLock(userId);
      }
    })();
  });
}
