import type { Bot, Context } from 'grammy';
import { parseEther } from 'viem';
import { evictPublicClient } from '../../blockchain/client.js';
import {
  createDefaultContractSettings,
  createDefaultExecutionSettings,
  createDefaultNetworkSettings,
} from '../../config/defaults.js';
import { testPinataAuth } from '../../services/pinata.js';
import type { BotStore } from '../../storage/store.js';
import type { EnvBootstrapDefaults } from '../../types/domain.js';
import { buildCancelInputKeyboard } from '../keyboards.js';
import { escapeHtml } from '../messages.js';
import {
  assertPublicHttpsUrl,
  parseBps,
  parseBytes32,
  parseEthAmount,
  parseEvmAddress,
  parseExplorerUrl,
  parseMultiplierToBps,
  parseNonNegativeBigInt,
  parsePositiveInt,
  parseRpcUrl,
  truncateText,
} from '../parsers.js';
import type { PendingInputField, PendingInputState, ReturnScreen, SessionManager } from '../session.js';
import {
  answerCallbackSafe,
  deleteMessageSafe,
  deriveWalletAddresses,
  renderScreen,
  safeEditOrReply,
} from '../ui.js';

function isSettingsPendingField(field: PendingInputField): boolean {
  return field.startsWith('set_');
}

export function registerSettingsHandlers(
  bot: Bot,
  store: BotStore,
  session: SessionManager,
  bootstrapDefaults?: EnvBootstrapDefaults,
): void {
  const promptField = async (
    ctx: Context,
    field: PendingInputField,
    returnScreen: ReturnScreen,
    promptHtml: string,
    sensitive = false,
  ): Promise<void> => {
    const userId = ctx.from!.id;
    await answerCallbackSafe(ctx);
    const msgId = await safeEditOrReply(ctx, promptHtml, buildCancelInputKeyboard());
    session.setPendingInput(userId, {
      field,
      returnScreen,
      sensitive,
      promptMessageId: msgId,
      chatId: ctx.chat?.id,
    });
  };

  // Top-level & sub-menu navigation
  bot.callbackQuery('set:menu', async (ctx) => {
    const userId = ctx.from.id;
    session.clearPendingInput(userId);
    await answerCallbackSafe(ctx);
    await renderScreen(ctx, store, userId, 'settings');
  });

  bot.callbackQuery('set:net:menu', async (ctx) => {
    const userId = ctx.from.id;
    session.clearPendingInput(userId);
    await answerCallbackSafe(ctx);
    await renderScreen(ctx, store, userId, 'set_network');
  });

  bot.callbackQuery('set:fac:menu', async (ctx) => {
    const userId = ctx.from.id;
    session.clearPendingInput(userId);
    await answerCallbackSafe(ctx);
    await renderScreen(ctx, store, userId, 'set_factory');
  });

  bot.callbackQuery('set:fee:menu', async (ctx) => {
    const userId = ctx.from.id;
    session.clearPendingInput(userId);
    await answerCallbackSafe(ctx);
    await renderScreen(ctx, store, userId, 'set_fee');
  });

  bot.callbackQuery('set:spd:menu', async (ctx) => {
    const userId = ctx.from.id;
    session.clearPendingInput(userId);
    await answerCallbackSafe(ctx);
    await renderScreen(ctx, store, userId, 'set_speed');
  });

  bot.callbackQuery('set:pin:menu', async (ctx) => {
    const userId = ctx.from.id;
    session.clearPendingInput(userId);
    await answerCallbackSafe(ctx);
    await renderScreen(ctx, store, userId, 'set_pinata');
  });

  // Network settings
  bot.callbackQuery('set:net:rpc', async (ctx) => {
    await promptField(
      ctx,
      'set_rpc_url',
      'set_network',
      '🔗 <b>Ubah RPC URL</b>\n\nKirim URL RPC publik berbasis <code>https://</code>, contoh:\n<code>https://rpc.mainnet.chain.robinhood.com</code>',
    );
  });

  bot.callbackQuery('set:net:chainid', async (ctx) => {
    await promptField(
      ctx,
      'set_chain_id',
      'set_network',
      '🔢 <b>Ubah Chain ID</b>\n\nKirim angka Chain ID (contoh: <code>4663</code>).',
    );
  });

  bot.callbackQuery('set:net:name', async (ctx) => {
    await promptField(
      ctx,
      'set_chain_name',
      'set_network',
      '🏷️ <b>Ubah Chain Name</b>\n\nKirim nama jaringan (contoh: <code>Robinhood</code>).',
    );
  });

  bot.callbackQuery('set:net:explorer', async (ctx) => {
    await promptField(
      ctx,
      'set_explorer_url',
      'set_network',
      '🔍 <b>Ubah Explorer URL</b>\n\nKirim base URL explorer (contoh: <code>https://robin.etherscan.io</code>).',
    );
  });

  bot.callbackQuery('set:net:reset', async (ctx) => {
    const userId = ctx.from.id;
    const prevNetwork = store.getUserProfile(userId).settings.network;
    await store.updateUserSettings(userId, (s) => {
      s.network = createDefaultNetworkSettings(bootstrapDefaults);
    });
    evictPublicClient(prevNetwork);
    await answerCallbackSafe(ctx, { text: '✅ Network dikembalikan ke default.' });
    await renderScreen(ctx, store, userId, 'set_network');
  });

  // Factory & Contract settings
  bot.callbackQuery('set:fac:addr', async (ctx) => {
    await promptField(
      ctx,
      'set_factory_address',
      'set_factory',
      '🏭 <b>Ubah Factory Address</b>\n\nKirim alamat kontrak Pons V2 Factory (<code>0x...</code>).',
    );
  });

  bot.callbackQuery('set:fac:cfg', async (ctx) => {
    await promptField(
      ctx,
      'set_launch_config_id',
      'set_factory',
      '🆔 <b>Ubah Launch Config ID</b>\n\nKirim angka non-negatif (default: <code>0</code>).',
    );
  });

  bot.callbackQuery('set:fac:pair', async (ctx) => {
    await promptField(
      ctx,
      'set_pair_token',
      'set_factory',
      '🪙 <b>Ubah Pair Token</b>\n\nKirim alamat EVM pair token (<code>0x0000000000000000000000000000000000000000</code> untuk native ETH).',
    );
  });

  bot.callbackQuery('set:fac:buyback', async (ctx) => {
    const userId = ctx.from.id;
    const updated = await store.updateUserSettings(userId, (s) => {
      s.contract.buybackEnabled = !s.contract.buybackEnabled;
    });
    await answerCallbackSafe(ctx, {
      text: `Buyback: ${updated.contract.buybackEnabled ? 'AKTIF' : 'NONAKTIF'}`,
    });
    await renderScreen(ctx, store, userId, 'set_factory');
  });

  bot.callbackQuery('set:fac:econ', async (ctx) => {
    await promptField(
      ctx,
      'set_expected_economics',
      'set_factory',
      '🧬 <b>Ubah Expected Economics</b>\n\nKirim bytes32 hex (<code>0x</code> + 64 karakter hex).',
    );
  });

  bot.callbackQuery('set:fac:reset', async (ctx) => {
    const userId = ctx.from.id;
    await store.updateUserSettings(userId, (s) => {
      s.contract = createDefaultContractSettings();
    });
    await answerCallbackSafe(ctx, { text: '✅ Contract dikembalikan ke default.' });
    await renderScreen(ctx, store, userId, 'set_factory');
  });

  // Fee & Funding settings
  bot.callbackQuery('set:fee:fund', async (ctx) => {
    await promptField(
      ctx,
      'set_fund_amount',
      'set_fee',
      '💵 <b>Ubah Fund Amount (ETH)</b>\n\nKirim jumlah ETH yang ditransfer dari Sponsor ke Target (contoh: <code>0.001</code>).',
    );
  });

  bot.callbackQuery('set:fee:rec', async (ctx) => {
    await promptField(
      ctx,
      'set_creator_fee_recipient',
      'set_fee',
      '💸 <b>Ubah Creator Fee Wallet</b>\n\nKirim alamat EVM penerima creator fee (<code>0x...</code>). Wajib valid, bukan zero address, dan bukan Target Wallet.',
    );
  });

  bot.callbackQuery('set:fee:tax', async (ctx) => {
    await promptField(
      ctx,
      'set_creator_tax_bps',
      'set_fee',
      '📊 <b>Ubah Creator Tax (BPS)</b>\n\nKirim angka integer <code>0</code> – <code>10000</code> (contoh: <code>300</code> = 3%).',
    );
  });

  // Speed & Gas tuning
  bot.callbackQuery('set:spd:gpm', async (ctx) => {
    await promptField(
      ctx,
      'set_gas_price_mult',
      'set_speed',
      '⛽ <b>Ubah Gas Price Multiplier</b>\n\nKirim multiplier <code>1.0</code> – <code>10.0</code> (contoh: <code>1.5</code> untuk 1.5x).',
    );
  });

  bot.callbackQuery('set:spd:glm', async (ctx) => {
    await promptField(
      ctx,
      'set_gas_limit_mult',
      'set_speed',
      '📐 <b>Ubah Gas Limit Multiplier</b>\n\nKirim multiplier <code>1.0</code> – <code>10.0</code> (contoh: <code>1.2</code> untuk 1.2x).',
    );
  });

  bot.callbackQuery('set:spd:prio', async (ctx) => {
    await promptField(
      ctx,
      'set_priority_fee',
      'set_speed',
      '⚡ <b>Ubah Max Priority Fee (wei)</b>\n\nKirim angka wei non-negatif (default: <code>1</code>).',
    );
  });

  bot.callbackQuery('set:spd:retries', async (ctx) => {
    await promptField(
      ctx,
      'set_launch_retries',
      'set_speed',
      '🔁 <b>Ubah Burst Launch Retries</b>\n\nKirim jumlah percobaan burst (<code>1</code> – <code>1000</code>, default: <code>400</code>).',
    );
  });

  bot.callbackQuery('set:spd:interval', async (ctx) => {
    await promptField(
      ctx,
      'set_retry_interval',
      'set_speed',
      '⏱️ <b>Ubah Burst Retry Interval (ms)</b>\n\nKirim jeda antar burst dalam milidetik (<code>5</code> – <code>1000</code>, default: <code>10</code>).',
    );
  });

  bot.callbackQuery('set:spd:buffer', async (ctx) => {
    await promptField(
      ctx,
      'set_safety_buffer',
      'set_speed',
      '🛡️ <b>Ubah Safety Buffer Target (ETH)</b>\n\nKirim jumlah ETH buffer keamanan di Target Wallet (default: <code>0.00005</code>).',
    );
  });

  bot.callbackQuery('set:spd:reserve', async (ctx) => {
    await promptField(
      ctx,
      'set_sponsor_reserve',
      'set_speed',
      '🏦 <b>Ubah Sponsor Gas Reserve (ETH)</b>\n\nKirim cadangan gas minimum di Sponsor Wallet (default: <code>0.0001</code>).',
    );
  });

  bot.callbackQuery('set:spd:revgas', async (ctx) => {
    await promptField(
      ctx,
      'set_revoke_gas_limit',
      'set_speed',
      '🔓 <b>Ubah Revoke Gas Limit</b>\n\nKirim gas limit TX revoke EIP-7702 (default: <code>300000</code>).',
    );
  });

  bot.callbackQuery('set:spd:fundgas', async (ctx) => {
    await promptField(
      ctx,
      'set_fund_gas_limit',
      'set_speed',
      '💸 <b>Ubah Fund Gas Limit</b>\n\nKirim gas limit TX transfer fund Sponsor → Target (default: <code>100000</code>).',
    );
  });

  bot.callbackQuery('set:spd:poll', async (ctx) => {
    await promptField(
      ctx,
      'set_receipt_polling',
      'set_speed',
      '⏳ <b>Ubah Receipt Polling (ms)</b>\n\nKirim interval cek receipt dalam ms (<code>50</code> – <code>10000</code>, default: <code>100</code>).',
    );
  });

  bot.callbackQuery('set:spd:timeout', async (ctx) => {
    await promptField(
      ctx,
      'set_receipt_timeout',
      'set_speed',
      '⌛ <b>Ubah Receipt Timeout (ms)</b>\n\nKirim batas waktu tunggu receipt dalam ms (<code>5000</code> – <code>120000</code>, default: <code>60000</code>).',
    );
  });

  bot.callbackQuery('set:spd:reset', async (ctx) => {
    const userId = ctx.from.id;
    await store.updateUserSettings(userId, (s) => {
      s.execution = createDefaultExecutionSettings();
    });
    await answerCallbackSafe(ctx, { text: '✅ Speed & Gas dikembalikan ke default.' });
    await renderScreen(ctx, store, userId, 'set_speed');
  });

  // Pinata IPFS settings
  bot.callbackQuery('set:pin:jwt', async (ctx) => {
    await promptField(
      ctx,
      'set_pinata_jwt',
      'set_pinata',
      '🔑 <b>Set / Ganti Pinata JWT</b>\n\nKirim Pinata API JWT Anda.\n<i>🔒 Pesan akan langsung dihapus otomatis dan disimpan terenkripsi AES-256-GCM.</i>',
      true,
    );
  });

  bot.callbackQuery('set:pin:gw', async (ctx) => {
    await promptField(
      ctx,
      'set_pinata_gateway',
      'set_pinata',
      '🌐 <b>Ubah IPFS Gateway URL</b>\n\nKirim URL gateway IPFS (contoh: <code>https://gateway.pinata.cloud/ipfs</code>).',
    );
  });

  bot.callbackQuery('set:pin:test', async (ctx) => {
    const userId = ctx.from.id;
    const jwt = store.getDecryptedPinataJwt(userId);
    if (!jwt) {
      await answerCallbackSafe(ctx, { text: '❌ Pinata JWT belum diatur.', show_alert: true });
      return;
    }

    await answerCallbackSafe(ctx, { text: 'Menguji autentikasi Pinata...' });
    const res = await testPinataAuth(jwt);
    await ctx.reply(
      res.ok
        ? `✅ <b>Autentikasi Pinata Berhasil!</b>\nRespon: <code>${escapeHtml(truncateText(res.message, 600))}</code>`
        : `❌ <b>Autentikasi Pinata Gagal!</b>\nDetail: <code>${escapeHtml(truncateText(res.message, 600))}</code>`,
      { parse_mode: 'HTML' },
    );
  });

  bot.callbackQuery('set:pin:clear', async (ctx) => {
    const userId = ctx.from.id;
    await store.clearPinataJwt(userId);
    await answerCallbackSafe(ctx, { text: '✅ Pinata JWT berhasil dihapus.' });
    await renderScreen(ctx, store, userId, 'set_pinata');
  });
}

export async function handleSettingsPendingInput(
  ctx: Context,
  store: BotStore,
  session: SessionManager,
  pending: PendingInputState,
): Promise<boolean> {
  if (!isSettingsPendingField(pending.field)) {
    return false;
  }

  const userId = ctx.from!.id;
  const text = ctx.message?.text?.trim() ?? '';

  if (pending.field === 'set_pinata_jwt') {
    const deleted = await deleteMessageSafe(ctx);
    const deleteNote = deleted
      ? '<i>Pesan Anda sudah dihapus otomatis.</i>'
      : '<i>⚠️ Bot gagal menghapus pesan otomatis — segera hapus pesan Pinata JWT Anda secara manual!</i>';

    if (text.length < 20) {
      await ctx.reply(
        `❌ Pinata JWT tidak valid (terlalu pendek).\n${deleteNote}`,
        { parse_mode: 'HTML', reply_markup: buildCancelInputKeyboard() },
      );
      return true;
    }
    await store.setPinataJwt(userId, text);
    session.clearPendingInput(userId);
    await ctx.reply(
      `✅ <b>Pinata JWT tersimpan (terenkripsi AES-256-GCM)!</b>\n${deleteNote}`,
      { parse_mode: 'HTML' },
    );
    await renderScreen(ctx, store, userId, pending.returnScreen, { forceReply: true });
    return true;
  }

  if (!text) {
    await ctx.reply('❌ Kirim nilai teks yang valid.', {
      parse_mode: 'HTML',
      reply_markup: buildCancelInputKeyboard(),
    });
    return true;
  }

  const fail = async (errorMsg: string): Promise<true> => {
    await ctx.reply(`❌ ${escapeHtml(errorMsg)}`, {
      parse_mode: 'HTML',
      reply_markup: buildCancelInputKeyboard(),
    });
    return true;
  };

  switch (pending.field) {
    case 'set_rpc_url': {
      const parsed = parseRpcUrl(text);
      if (!parsed.ok) return fail(parsed.error);
      const ssrfCheck = await assertPublicHttpsUrl(parsed.value);
      if (!ssrfCheck.ok) return fail(ssrfCheck.error);
      const prevNetwork = store.getUserProfile(userId).settings.network;
      await store.updateUserSettings(userId, (s) => {
        s.network.rpcUrl = parsed.value;
      });
      evictPublicClient(prevNetwork);
      break;
    }
    case 'set_chain_id': {
      const parsed = parsePositiveInt(text, { min: 1, label: 'Chain ID' });
      if (!parsed.ok) return fail(parsed.error);
      const prevNetwork = store.getUserProfile(userId).settings.network;
      await store.updateUserSettings(userId, (s) => {
        s.network.chainId = parsed.value;
      });
      evictPublicClient(prevNetwork);
      break;
    }
    case 'set_chain_name': {
      const prevNetwork = store.getUserProfile(userId).settings.network;
      await store.updateUserSettings(userId, (s) => {
        s.network.chainName = text.slice(0, 64);
      });
      evictPublicClient(prevNetwork);
      break;
    }
    case 'set_explorer_url': {
      const parsed = parseExplorerUrl(text);
      if (!parsed.ok) return fail(parsed.error);
      const ssrfCheck = await assertPublicHttpsUrl(parsed.value);
      if (!ssrfCheck.ok) return fail(ssrfCheck.error);
      const prevNetwork = store.getUserProfile(userId).settings.network;
      await store.updateUserSettings(userId, (s) => {
        s.network.explorerUrl = parsed.value;
      });
      evictPublicClient(prevNetwork);
      break;
    }
    case 'set_factory_address': {
      const parsed = parseEvmAddress(text, { allowZero: false });
      if (!parsed.ok) return fail(parsed.error);
      await store.updateUserSettings(userId, (s) => {
        s.contract.factoryAddress = parsed.value;
      });
      break;
    }
    case 'set_launch_config_id': {
      const parsed = parseNonNegativeBigInt(text, { label: 'Launch Config ID' });
      if (!parsed.ok) return fail(parsed.error);
      await store.updateUserSettings(userId, (s) => {
        s.contract.launchConfigId = parsed.value.toString();
      });
      break;
    }
    case 'set_pair_token': {
      const parsed = parseEvmAddress(text, { allowZero: true });
      if (!parsed.ok) return fail(parsed.error);
      await store.updateUserSettings(userId, (s) => {
        s.contract.pairToken = parsed.value;
      });
      break;
    }
    case 'set_expected_economics': {
      const parsed = parseBytes32(text, { allowEmpty: false });
      if (!parsed.ok || parsed.value === '') {
        return fail(parsed.ok ? 'Expected Economics wajib bytes32 valid.' : parsed.error);
      }
      const hexVal = parsed.value;
      await store.updateUserSettings(userId, (s) => {
        s.contract.expectedEconomics = hexVal;
      });
      break;
    }
    case 'set_fund_amount': {
      const parsed = parseEthAmount(text, { allowZero: false, maxWei: parseEther('10') });
      if (!parsed.ok) return fail(parsed.error);
      await store.updateUserSettings(userId, (s) => {
        s.fee.fundAmountEth = parsed.value.eth;
      });
      break;
    }
    case 'set_creator_fee_recipient': {
      const parsed = parseEvmAddress(text, { allowZero: false });
      if (!parsed.ok) return fail(parsed.error);
      const derived = deriveWalletAddresses(store, userId);
      if (
        derived.targetAddress &&
        derived.targetAddress.toLowerCase() === parsed.value.toLowerCase()
      ) {
        return fail('Creator Fee Wallet tidak boleh sama dengan Target Wallet (Token Creator).');
      }
      await store.updateUserSettings(userId, (s) => {
        s.fee.creatorFeeRecipient = parsed.value;
      });
      break;
    }
    case 'set_creator_tax_bps': {
      const parsed = parseBps(text, { min: 0, max: 10_000 });
      if (!parsed.ok) return fail(parsed.error);
      await store.updateUserSettings(userId, (s) => {
        s.fee.creatorTaxBps = parsed.value;
      });
      break;
    }
    case 'set_gas_price_mult': {
      const parsed = parseMultiplierToBps(text);
      if (!parsed.ok) return fail(parsed.error);
      await store.updateUserSettings(userId, (s) => {
        s.execution.gasPriceMultiplierBps = parsed.value;
      });
      break;
    }
    case 'set_gas_limit_mult': {
      const parsed = parseMultiplierToBps(text);
      if (!parsed.ok) return fail(parsed.error);
      await store.updateUserSettings(userId, (s) => {
        s.execution.gasLimitMultiplierBps = parsed.value;
      });
      break;
    }
    case 'set_priority_fee': {
      const parsed = parseNonNegativeBigInt(text, {
        min: 0n,
        max: 100_000_000_000n,
        label: 'Max Priority Fee (maks 100 Gwei)',
      });
      if (!parsed.ok) return fail(parsed.error);
      await store.updateUserSettings(userId, (s) => {
        s.execution.maxPriorityFeeWei = parsed.value.toString();
      });
      break;
    }
    case 'set_revoke_gas_limit': {
      const parsed = parseNonNegativeBigInt(text, {
        min: 21_000n,
        max: 2_000_000n,
        label: 'Revoke Gas Limit',
      });
      if (!parsed.ok) return fail(parsed.error);
      await store.updateUserSettings(userId, (s) => {
        s.execution.revokeGasLimit = parsed.value.toString();
      });
      break;
    }
    case 'set_fund_gas_limit': {
      const parsed = parseNonNegativeBigInt(text, {
        min: 21_000n,
        max: 500_000n,
        label: 'Fund Gas Limit',
      });
      if (!parsed.ok) return fail(parsed.error);
      await store.updateUserSettings(userId, (s) => {
        s.execution.fundGasLimit = parsed.value.toString();
      });
      break;
    }
    case 'set_sponsor_reserve': {
      const parsed = parseEthAmount(text, { allowZero: true, maxWei: parseEther('1') });
      if (!parsed.ok) return fail(parsed.error);
      await store.updateUserSettings(userId, (s) => {
        s.execution.sponsorGasReserveEth = parsed.value.eth;
      });
      break;
    }
    case 'set_safety_buffer': {
      const parsed = parseEthAmount(text, { allowZero: true, maxWei: parseEther('1') });
      if (!parsed.ok) return fail(parsed.error);
      await store.updateUserSettings(userId, (s) => {
        s.execution.safetyBufferEth = parsed.value.eth;
      });
      break;
    }
    case 'set_launch_retries': {
      const parsed = parsePositiveInt(text, { min: 1, max: 1000, label: 'Launch Retries' });
      if (!parsed.ok) return fail(parsed.error);
      await store.updateUserSettings(userId, (s) => {
        s.execution.launchRetries = parsed.value;
      });
      break;
    }
    case 'set_retry_interval': {
      const parsed = parsePositiveInt(text, { min: 5, max: 1000, label: 'Retry Interval (ms)' });
      if (!parsed.ok) return fail(parsed.error);
      await store.updateUserSettings(userId, (s) => {
        s.execution.launchRetryIntervalMs = parsed.value;
      });
      break;
    }
    case 'set_receipt_polling': {
      const parsed = parsePositiveInt(text, { min: 50, max: 10_000, label: 'Receipt Polling (ms)' });
      if (!parsed.ok) return fail(parsed.error);
      await store.updateUserSettings(userId, (s) => {
        s.execution.receiptPollingMs = parsed.value;
      });
      break;
    }
    case 'set_receipt_timeout': {
      const parsed = parsePositiveInt(text, { min: 5000, max: 120_000, label: 'Receipt Timeout (ms)' });
      if (!parsed.ok) return fail(parsed.error);
      await store.updateUserSettings(userId, (s) => {
        s.execution.receiptTimeoutMs = parsed.value;
      });
      break;
    }
    case 'set_pinata_gateway': {
      const parsed = parseExplorerUrl(text);
      if (!parsed.ok) return fail(parsed.error);
      const ssrfCheck = await assertPublicHttpsUrl(parsed.value);
      if (!ssrfCheck.ok) return fail(ssrfCheck.error);
      await store.updateUserSettings(userId, (s) => {
        s.ipfs.pinataGateway = parsed.value;
      });
      break;
    }
    default:
      return false;
  }

  session.clearPendingInput(userId);
  await renderScreen(ctx, store, userId, pending.returnScreen, { forceReply: true });
  return true;
}
