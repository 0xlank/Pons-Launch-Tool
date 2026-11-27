import type { Context, InlineKeyboard } from 'grammy';
import type { Address } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import type { BotStore } from '../storage/store.js';
import { truncateText } from './parsers.js';
import type { ReturnScreen } from './session.js';
import {
  buildAccessMenuKeyboard,
  buildFactorySettingsKeyboard,
  buildFeeSettingsKeyboard,
  buildMainMenuKeyboard,
  buildNetworkSettingsKeyboard,
  buildPinataSettingsKeyboard,
  buildPresetsMenuKeyboard,
  buildSettingsMenuKeyboard,
  buildSocialsMenuKeyboard,
  buildSpeedSettingsKeyboard,
  buildTokenMenuKeyboard,
  buildWalletMenuKeyboard,
} from './keyboards.js';
import {
  formatAccessMenu,
  formatFactorySettings,
  formatFeeSettings,
  formatMainMenu,
  formatNetworkSettings,
  formatPinataSettings,
  formatPresetsMenu,
  formatSettingsMenu,
  formatSocialsMenu,
  formatSpeedSettings,
  formatTokenMenu,
  formatWalletMenu,
} from './messages.js';

export function deriveWalletAddresses(
  store: BotStore,
  userId: number,
): { sponsorAddress?: Address; targetAddress?: Address } {
  try {
    const wallets = store.getDecryptedWallets(userId);
    return {
      ...(wallets.sponsorPk ? { sponsorAddress: privateKeyToAccount(wallets.sponsorPk).address } : {}),
      ...(wallets.targetPk ? { targetAddress: privateKeyToAccount(wallets.targetPk).address } : {}),
    };
  } catch {
    return {};
  }
}

export async function answerCallbackSafe(
  ctx: Context,
  options?: { text?: string; show_alert?: boolean },
): Promise<void> {
  if (!ctx.callbackQuery) {
    return;
  }
  const safeOptions = options?.text
    ? { ...options, text: truncateText(options.text, 195) }
    : options;
  try {
    await ctx.answerCallbackQuery(safeOptions);
  } catch {
    // Ignore stale callback query errors
  }
}

export async function deleteMessageSafe(ctx: Context): Promise<boolean> {
  try {
    await ctx.deleteMessage();
    return true;
  } catch {
    // Return false so callers can warn the user if secret deletion failed
    return false;
  }
}

export async function safeEditOrReply(
  ctx: Context,
  text: string,
  replyMarkup?: InlineKeyboard,
  options?: { forceReply?: boolean },
): Promise<number | undefined> {
  const safeText = text.length > 4000 ? `${text.slice(0, 3980)}\n...` : text;
  const extra = {
    parse_mode: 'HTML' as const,
    link_preview_options: { is_disabled: true },
    ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
  };

  if (!options?.forceReply && ctx.callbackQuery?.message) {
    try {
      const edited = await ctx.editMessageText(safeText, extra);
      if (typeof edited === 'object' && 'message_id' in edited) {
        return edited.message_id;
      }
      return ctx.callbackQuery.message.message_id;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/message is not modified/i.test(msg)) {
        return ctx.callbackQuery.message.message_id;
      }
      // Fall through to reply if message cannot be edited (e.g., deleted or media message)
    }
  }

  const sent = await ctx.reply(safeText, extra);
  return sent.message_id;
}

export async function renderScreen(
  ctx: Context,
  store: BotStore,
  userId: number,
  screen: ReturnScreen,
  options?: { forceReply?: boolean },
): Promise<void> {
  const profile = store.getUserProfile(userId);
  const isOwner = store.isOwner(userId);

  switch (screen) {
    case 'main': {
      const derived = deriveWalletAddresses(store, userId);
      await safeEditOrReply(
        ctx,
        formatMainMenu(profile, derived, isOwner),
        buildMainMenuKeyboard(),
        options,
      );
      return;
    }
    case 'wallets': {
      const derived = deriveWalletAddresses(store, userId);
      await safeEditOrReply(
        ctx,
        formatWalletMenu(profile, undefined, derived),
        buildWalletMenuKeyboard(),
        options,
      );
      return;
    }
    case 'token': {
      await safeEditOrReply(
        ctx,
        formatTokenMenu(profile.tokenDraft, Boolean(profile.settings.ipfs.pinataJwtEnc)),
        buildTokenMenuKeyboard(),
        options,
      );
      return;
    }
    case 'socials': {
      await safeEditOrReply(
        ctx,
        formatSocialsMenu(profile.tokenDraft.socials),
        buildSocialsMenuKeyboard(),
        options,
      );
      return;
    }
    case 'presets': {
      await safeEditOrReply(
        ctx,
        formatPresetsMenu(profile.presets),
        buildPresetsMenuKeyboard(profile.presets),
        options,
      );
      return;
    }
    case 'settings': {
      await safeEditOrReply(
        ctx,
        formatSettingsMenu(profile.settings, isOwner),
        buildSettingsMenuKeyboard(isOwner),
        options,
      );
      return;
    }
    case 'set_network': {
      await safeEditOrReply(
        ctx,
        formatNetworkSettings(profile.settings.network),
        buildNetworkSettingsKeyboard(),
        options,
      );
      return;
    }
    case 'set_factory': {
      await safeEditOrReply(
        ctx,
        formatFactorySettings(profile.settings.contract),
        buildFactorySettingsKeyboard(profile.settings.contract.buybackEnabled),
        options,
      );
      return;
    }
    case 'set_fee': {
      await safeEditOrReply(
        ctx,
        formatFeeSettings(profile.settings.fee),
        buildFeeSettingsKeyboard(),
        options,
      );
      return;
    }
    case 'set_speed': {
      await safeEditOrReply(
        ctx,
        formatSpeedSettings(profile.settings.execution),
        buildSpeedSettingsKeyboard(),
        options,
      );
      return;
    }
    case 'set_pinata': {
      await safeEditOrReply(
        ctx,
        formatPinataSettings(profile.settings.ipfs),
        buildPinataSettingsKeyboard(Boolean(profile.settings.ipfs.pinataJwtEnc)),
        options,
      );
      return;
    }
    case 'set_access': {
      if (!isOwner) {
        await safeEditOrReply(
          ctx,
          formatSettingsMenu(profile.settings, false),
          buildSettingsMenuKeyboard(false),
          options,
        );
        return;
      }
      const owners = store.listOwnerIds();
      const users = store.listAuthorizedUsers();
      await safeEditOrReply(
        ctx,
        formatAccessMenu(owners, users),
        buildAccessMenuKeyboard(users),
        options,
      );
      return;
    }
  }
}
