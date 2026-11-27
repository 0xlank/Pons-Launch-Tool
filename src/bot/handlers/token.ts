import type { Bot, Context } from 'grammy';
import {
  ALLOWED_IMAGE_MIME_TYPES,
  downloadTelegramFile,
  MAX_PINATA_IMAGE_BYTES,
  uploadImageBufferToPinata,
} from '../../services/pinata.js';
import type { BotStore } from '../../storage/store.js';
import { buildCancelInputKeyboard } from '../keyboards.js';
import { escapeHtml } from '../messages.js';
import {
  applyQuickPastePatch,
  parseBytes32,
  parseLogoUrl,
  parseQuickPasteTemplate,
  parseSocialValue,
  TOKEN_FIELD_LIMITS,
  truncateText,
} from '../parsers.js';
import type { PendingInputField, PendingInputState, ReturnScreen, SessionManager } from '../session.js';
import { answerCallbackSafe, renderScreen, safeEditOrReply } from '../ui.js';

function isTokenPendingField(field: PendingInputField): boolean {
  return (
    field.startsWith('token_') || field === 'preset_save_label'
  );
}

function normalizeClearableText(raw: string): string {
  const trimmed = raw.trim();
  return trimmed === '-' ? '' : trimmed;
}

function guessMimeFromFilename(filename?: string): string | undefined {
  const lower = (filename ?? '').toLowerCase();
  if (lower.endsWith('.png')) return 'image/png';
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg';
  if (lower.endsWith('.webp')) return 'image/webp';
  if (lower.endsWith('.gif')) return 'image/gif';
  return undefined;
}

export function registerTokenHandlers(
  bot: Bot,
  store: BotStore,
  session: SessionManager,
): void {
  const promptField = async (
    ctx: Context,
    field: PendingInputField,
    returnScreen: ReturnScreen,
    promptHtml: string,
  ): Promise<void> => {
    const userId = ctx.from!.id;
    await answerCallbackSafe(ctx);
    const msgId = await safeEditOrReply(ctx, promptHtml, buildCancelInputKeyboard());
    session.setPendingInput(userId, {
      field,
      returnScreen,
      sensitive: false,
      promptMessageId: msgId,
      chatId: ctx.chat?.id,
    });
  };

  bot.callbackQuery('tok:menu', async (ctx) => {
    const userId = ctx.from.id;
    session.clearPendingInput(userId);
    await answerCallbackSafe(ctx);
    await renderScreen(ctx, store, userId, 'token');
  });

  bot.callbackQuery('tok:socials', async (ctx) => {
    const userId = ctx.from.id;
    session.clearPendingInput(userId);
    await answerCallbackSafe(ctx);
    await renderScreen(ctx, store, userId, 'socials');
  });

  bot.callbackQuery('pre:menu', async (ctx) => {
    const userId = ctx.from.id;
    session.clearPendingInput(userId);
    await answerCallbackSafe(ctx);
    await renderScreen(ctx, store, userId, 'presets');
  });

  bot.callbackQuery('tok:edit:name', async (ctx) => {
    await promptField(
      ctx,
      'token_name',
      'token',
      '✏️ <b>Edit Nama Token</b>\n\nKirim nama token (contoh: <code>Pons Super Token</code>).',
    );
  });

  bot.callbackQuery('tok:edit:symbol', async (ctx) => {
    await promptField(
      ctx,
      'token_symbol',
      'token',
      '🏷️ <b>Edit Symbol / Ticker Token</b>\n\nKirim symbol token (contoh: <code>PONS</code>).',
    );
  });

  bot.callbackQuery('tok:edit:logo', async (ctx) => {
    await promptField(
      ctx,
      'token_logo',
      'token',
      [
        '🖼️ <b>Edit Logo Token</b>',
        '',
        'Pilih salah satu cara:',
        '• Kirim <b>URL gambar</b> (contoh: <code>https://.../logo.png</code>)',
        '• Atau kirim <b>Foto / Dokumen gambar</b> (PNG/JPG/WebP/GIF, maks 10 MB) untuk upload otomatis ke Pinata IPFS.',
        '• <i>Bonus:</i> Anda juga bisa menyertakan Quick Paste di caption foto.',
      ].join('\n'),
    );
  });

  bot.callbackQuery('tok:edit:desc', async (ctx) => {
    await promptField(
      ctx,
      'token_description',
      'token',
      '📝 <b>Edit Deskripsi Token</b>\n\nKirim deskripsi token. Kirim <code>-</code> untuk mengosongkan.',
    );
  });

  bot.callbackQuery('tok:edit:salt', async (ctx) => {
    await promptField(
      ctx,
      'token_custom_salt',
      'token',
      '🧂 <b>Edit Custom Salt (Opsional)</b>\n\nKirim bytes32 hex (<code>0x</code> + 64 karakter hex), atau kirim <code>-</code> / <code>auto</code> untuk salt acak otomatis.',
    );
  });

  bot.callbackQuery('tok:quick', async (ctx) => {
    await promptField(
      ctx,
      'token_quick_paste',
      'token',
      [
        '⚡ <b>Quick Paste Data Token</b>',
        '',
        'Kirim teks multi-baris (atau kirim <b>Foto dengan Caption</b> berisi format ini):',
        '<pre>name: Nama Token\nsymbol: TKN\nlogo: https://.../logo.png\ndesc: Deskripsi singkat\ntwitter: https://x.com/...\ntelegram: https://t.me/...\ndiscord: https://discord.gg/...\nwebsite: https://...\ngithub: https://github.com/...\nsalt: auto</pre>',
        '<i>Anda cukup menyertakan field yang ingin diubah saja.</i>',
      ].join('\n'),
    );
  });

  bot.callbackQuery('tok:soc:twitter', async (ctx) => {
    await promptField(
      ctx,
      'token_social_twitter',
      'socials',
      '🐦 <b>Edit Twitter / X</b>\n\nKirim link/handle Twitter/X, atau kirim <code>-</code> untuk mengosongkan.',
    );
  });

  bot.callbackQuery('tok:soc:telegram', async (ctx) => {
    await promptField(
      ctx,
      'token_social_telegram',
      'socials',
      '✈️ <b>Edit Telegram</b>\n\nKirim link grup/channel Telegram, atau kirim <code>-</code> untuk mengosongkan.',
    );
  });

  bot.callbackQuery('tok:soc:discord', async (ctx) => {
    await promptField(
      ctx,
      'token_social_discord',
      'socials',
      '💬 <b>Edit Discord</b>\n\nKirim link invite Discord, atau kirim <code>-</code> untuk mengosongkan.',
    );
  });

  bot.callbackQuery('tok:soc:website', async (ctx) => {
    await promptField(
      ctx,
      'token_social_website',
      'socials',
      '🌐 <b>Edit Website</b>\n\nKirim URL website, atau kirim <code>-</code> untuk mengosongkan.',
    );
  });

  bot.callbackQuery('tok:soc:github', async (ctx) => {
    await promptField(
      ctx,
      'token_social_github',
      'socials',
      '💻 <b>Edit GitHub</b>\n\nKirim URL repositori/organisasi GitHub, atau kirim <code>-</code> untuk mengosongkan.',
    );
  });

  bot.callbackQuery('tok:clear', async (ctx) => {
    const userId = ctx.from.id;
    await store.clearTokenDraft(userId);
    session.clearAllLaunchConfirmations();
    await answerCallbackSafe(ctx, { text: '✅ Draft token dikosongkan.' });
    await renderScreen(ctx, store, userId, 'token');
  });

  bot.callbackQuery('pre:save', async (ctx) => {
    await promptField(
      ctx,
      'preset_save_label',
      'presets',
      '💾 <b>Simpan Draft ke Preset</b>\n\nKirim nama label untuk preset ini (contoh: <code>Launch Meme V1</code>). Jika nama sudah ada, preset tersebut akan diperbarui.',
    );
  });

  bot.callbackQuery(/^pre:load:([0-9a-f]+)$/, async (ctx) => {
    const userId = ctx.from.id;
    const presetId = ctx.match[1];
    try {
      await store.loadPresetToDraft(userId, presetId);
      session.clearAllLaunchConfirmations();
      await answerCallbackSafe(ctx, { text: '✅ Preset dimuat ke draft aktif.' });
      await renderScreen(ctx, store, userId, 'token');
    } catch {
      await answerCallbackSafe(ctx, { text: '❌ Preset tidak ditemukan.', show_alert: true });
      await renderScreen(ctx, store, userId, 'presets');
    }
  });

  bot.callbackQuery(/^pre:del:([0-9a-f]+)$/, async (ctx) => {
    const userId = ctx.from.id;
    const presetId = ctx.match[1];
    const deleted = await store.deletePreset(userId, presetId);
    await answerCallbackSafe(ctx, {
      text: deleted ? '✅ Preset dihapus.' : '❌ Preset tidak ditemukan.',
    });
    await renderScreen(ctx, store, userId, 'presets');
  });
}

async function handleImageUpload(
  ctx: Context,
  store: BotStore,
  botToken: string,
  userId: number,
): Promise<{ ok: true; cid: string; url: string } | { ok: false; error: string }> {
  const message = ctx.message;
  if (!message) {
    return { ok: false, error: 'Pesan tidak valid.' };
  }

  let fileId: string | undefined;
  let filename = 'logo.jpg';
  let mimeType = 'image/jpeg';

  if (message.photo && message.photo.length > 0) {
    const largest = message.photo[message.photo.length - 1];
    if (largest.file_size !== undefined && largest.file_size > MAX_PINATA_IMAGE_BYTES) {
      return {
        ok: false,
        error: 'Ukuran foto melebihi batas maksimum 10 MB.',
      };
    }
    fileId = largest.file_id;
    filename = `logo-${largest.file_unique_id}.jpg`;
    mimeType = 'image/jpeg';
  } else if (message.document) {
    const doc = message.document;
    if (doc.file_size !== undefined && doc.file_size > MAX_PINATA_IMAGE_BYTES) {
      return {
        ok: false,
        error: 'Ukuran file melebihi batas maksimum 10 MB.',
      };
    }
    const docMime = (doc.mime_type ?? guessMimeFromFilename(doc.file_name) ?? '').toLowerCase();
    if (!ALLOWED_IMAGE_MIME_TYPES.has(docMime)) {
      return {
        ok: false,
        error: 'Format file tidak didukung. Kirim gambar PNG, JPEG, WebP, atau GIF (maks 10 MB).',
      };
    }
    fileId = doc.file_id;
    filename = doc.file_name ?? `logo-${doc.file_unique_id}.png`;
    mimeType = docMime;
  } else {
    return { ok: false, error: 'Tidak ada gambar ditemukan.' };
  }

  const jwt = store.getDecryptedPinataJwt(userId);
  if (!jwt) {
    return {
      ok: false,
      error:
        'Pinata JWT belum diatur. Atur dulu di Settings → Pinata IPFS, atau tempel URL logo secara langsung.',
    };
  }

  const profile = store.getUserProfile(userId);
  const statusMsg = await ctx.reply('⏳ Mengunduh gambar dan mengunggah ke Pinata IPFS...');

  try {
    const tgFile = await ctx.api.getFile(fileId);
    if (tgFile.file_size !== undefined && tgFile.file_size > MAX_PINATA_IMAGE_BYTES) {
      throw new Error('Image exceeds maximum allowed size of 10 MB');
    }
    if (!tgFile.file_path) {
      throw new Error('Telegram file_path is unavailable');
    }
    const bytes = await downloadTelegramFile(botToken, tgFile.file_path);
    const uploaded = await uploadImageBufferToPinata(
      bytes,
      filename,
      mimeType,
      jwt,
      profile.settings.ipfs.pinataGateway,
    );

    try {
      await ctx.api.deleteMessage(ctx.chat!.id, statusMsg.message_id);
    } catch {
      // Ignore delete error
    }

    return { ok: true, cid: uploaded.cid, url: uploaded.url };
  } catch (err: unknown) {
    const rawMsg = err instanceof Error ? err.message : String(err);
    const safeMsg = truncateText(
      rawMsg.replaceAll(botToken, '***').replace(/\/bot\d+:[A-Za-z0-9_-]+/g, '/bot***'),
      500,
    );
    try {
      await ctx.api.deleteMessage(ctx.chat!.id, statusMsg.message_id);
    } catch {
      // Ignore
    }
    return { ok: false, error: `Gagal upload ke Pinata IPFS: ${safeMsg}` };
  }
}

export async function handleTokenPendingInput(
  ctx: Context,
  store: BotStore,
  session: SessionManager,
  pending: PendingInputState,
  botToken: string,
): Promise<boolean> {
  if (!isTokenPendingField(pending.field)) {
    return false;
  }

  const userId = ctx.from!.id;
  const message = ctx.message;
  if (!message) {
    return true;
  }

  const hasImage = Boolean((message.photo && message.photo.length > 0) || message.document);

  // Handle photo/document upload for token_logo and token_quick_paste
  if ((pending.field === 'token_logo' || pending.field === 'token_quick_paste') && hasImage) {
    const uploadResult = await handleImageUpload(ctx, store, botToken, userId);
    if (!uploadResult.ok) {
      await ctx.reply(`❌ ${escapeHtml(uploadResult.error)}`, {
        parse_mode: 'HTML',
        reply_markup: buildCancelInputKeyboard(),
      });
      return true;
    }

    const caption = message.caption?.trim() ?? '';
    let captionSummary = '';

    if (caption.length > 0) {
      const parsedCaption = parseQuickPasteTemplate(caption);
      if (parsedCaption.ok) {
        await store.updateTokenDraft(userId, (draft) => {
          const merged = applyQuickPastePatch(draft, parsedCaption.value);
          merged.logo = uploadResult.url;
          return merged;
        });
        captionSummary = `\n✅ Field caption terpasang: <code>${escapeHtml(parsedCaption.value.matchedFields.join(', '))}</code>`;
      } else {
        await store.updateTokenDraft(userId, (draft) => {
          draft.logo = uploadResult.url;
        });
        captionSummary = `\n⚠️ <i>Caption tidak dapat diparse (${escapeHtml(truncateText(parsedCaption.error, 200))}) — hanya logo yang disimpan.</i>`;
      }
    } else {
      await store.updateTokenDraft(userId, (draft) => {
        draft.logo = uploadResult.url;
      });
    }

    session.clearPendingInput(userId);
    session.clearAllLaunchConfirmations();
    await ctx.reply(
      `✅ <b>Logo berhasil diunggah ke IPFS!</b>\n• CID: <code>${escapeHtml(uploadResult.cid)}</code>\n• URL: <code>${escapeHtml(uploadResult.url)}</code>${captionSummary}`,
      { parse_mode: 'HTML' },
    );
    await renderScreen(ctx, store, userId, 'token', { forceReply: true });
    return true;
  }

  const text = message.text?.trim() ?? '';
  if (!text) {
    await ctx.reply('❌ Kirim input teks yang valid (atau gambar untuk logo).', {
      parse_mode: 'HTML',
      reply_markup: buildCancelInputKeyboard(),
    });
    return true;
  }

  switch (pending.field) {
    case 'token_name': {
      if (text.length > TOKEN_FIELD_LIMITS.name) {
        await ctx.reply(`❌ Nama token terlalu panjang (maksimal ${TOKEN_FIELD_LIMITS.name} karakter).`, {
          parse_mode: 'HTML',
          reply_markup: buildCancelInputKeyboard(),
        });
        return true;
      }
      await store.updateTokenDraft(userId, (draft) => {
        draft.name = text;
      });
      session.clearPendingInput(userId);
      session.clearAllLaunchConfirmations();
      await renderScreen(ctx, store, userId, 'token', { forceReply: true });
      return true;
    }
    case 'token_symbol': {
      if (text.length > TOKEN_FIELD_LIMITS.symbol) {
        await ctx.reply(`❌ Symbol token terlalu panjang (maksimal ${TOKEN_FIELD_LIMITS.symbol} karakter).`, {
          parse_mode: 'HTML',
          reply_markup: buildCancelInputKeyboard(),
        });
        return true;
      }
      await store.updateTokenDraft(userId, (draft) => {
        draft.symbol = text;
      });
      session.clearPendingInput(userId);
      session.clearAllLaunchConfirmations();
      await renderScreen(ctx, store, userId, 'token', { forceReply: true });
      return true;
    }
    case 'token_logo': {
      const parsedLogo = parseLogoUrl(text);
      if (!parsedLogo.ok) {
        await ctx.reply(`❌ ${escapeHtml(parsedLogo.error)}`, {
          parse_mode: 'HTML',
          reply_markup: buildCancelInputKeyboard(),
        });
        return true;
      }
      await store.updateTokenDraft(userId, (draft) => {
        draft.logo = parsedLogo.value;
      });
      session.clearPendingInput(userId);
      session.clearAllLaunchConfirmations();
      await renderScreen(ctx, store, userId, 'token', { forceReply: true });
      return true;
    }
    case 'token_description': {
      const clean = normalizeClearableText(text);
      if (clean.length > TOKEN_FIELD_LIMITS.description) {
        await ctx.reply(`❌ Deskripsi terlalu panjang (maksimal ${TOKEN_FIELD_LIMITS.description} karakter).`, {
          parse_mode: 'HTML',
          reply_markup: buildCancelInputKeyboard(),
        });
        return true;
      }
      await store.updateTokenDraft(userId, (draft) => {
        draft.description = clean;
      });
      session.clearPendingInput(userId);
      session.clearAllLaunchConfirmations();
      await renderScreen(ctx, store, userId, 'token', { forceReply: true });
      return true;
    }
    case 'token_social_twitter':
    case 'token_social_telegram':
    case 'token_social_discord':
    case 'token_social_website':
    case 'token_social_github': {
      const parsedSocial = parseSocialValue(text);
      if (!parsedSocial.ok) {
        await ctx.reply(`❌ ${escapeHtml(parsedSocial.error)}`, {
          parse_mode: 'HTML',
          reply_markup: buildCancelInputKeyboard(),
        });
        return true;
      }
      const socialKeyMap = {
        token_social_twitter: 'twitter',
        token_social_telegram: 'telegram',
        token_social_discord: 'discord',
        token_social_website: 'website',
        token_social_github: 'github',
      } as const;
      const key = socialKeyMap[pending.field];
      await store.updateTokenDraft(userId, (draft) => {
        draft.socials[key] = parsedSocial.value;
      });
      session.clearPendingInput(userId);
      session.clearAllLaunchConfirmations();
      await renderScreen(ctx, store, userId, 'socials', { forceReply: true });
      return true;
    }
    case 'token_custom_salt': {
      const parsed = parseBytes32(text, { allowEmpty: true });
      if (!parsed.ok) {
        await ctx.reply(`❌ ${escapeHtml(parsed.error)}`, {
          parse_mode: 'HTML',
          reply_markup: buildCancelInputKeyboard(),
        });
        return true;
      }
      await store.updateTokenDraft(userId, (draft) => {
        draft.customSalt = parsed.value;
      });
      session.clearPendingInput(userId);
      session.clearAllLaunchConfirmations();
      await renderScreen(ctx, store, userId, 'token', { forceReply: true });
      return true;
    }
    case 'token_quick_paste': {
      const parsed = parseQuickPasteTemplate(text);
      if (!parsed.ok) {
        await ctx.reply(`❌ ${escapeHtml(parsed.error)}`, {
          parse_mode: 'HTML',
          reply_markup: buildCancelInputKeyboard(),
        });
        return true;
      }
      await store.updateTokenDraft(userId, (draft) => applyQuickPastePatch(draft, parsed.value));
      session.clearPendingInput(userId);
      session.clearAllLaunchConfirmations();
      await ctx.reply(
        `✅ <b>Quick Paste berhasil!</b>\nField diperbarui: <code>${escapeHtml(parsed.value.matchedFields.join(', '))}</code>`,
        { parse_mode: 'HTML' },
      );
      await renderScreen(ctx, store, userId, 'token', { forceReply: true });
      return true;
    }
    case 'preset_save_label': {
      try {
        const saved = await store.savePreset(userId, text);
        session.clearPendingInput(userId);
        await ctx.reply(
          `✅ Preset <b>${escapeHtml(saved.label)}</b> berhasil disimpan.`,
          { parse_mode: 'HTML' },
        );
        await renderScreen(ctx, store, userId, 'presets', { forceReply: true });
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        await ctx.reply(`❌ ${escapeHtml(msg)}`, {
          parse_mode: 'HTML',
          reply_markup: buildCancelInputKeyboard(),
        });
      }
      return true;
    }
    default:
      return false;
  }
}
