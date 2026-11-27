import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import type { Context, InlineKeyboard } from 'grammy';
import { createAuthMiddleware, requireOwner } from '../src/bot/handlers/auth.js';
import * as keyboards from '../src/bot/keyboards.js';
import { SessionManager } from '../src/bot/session.js';
import { parseEnv } from '../src/config/env.js';
import { BotStore, StoreAuthorizationError } from '../src/storage/store.js';
import type { AuthorizedUserEntry, TokenPreset } from '../src/types/domain.js';

const ROOT_OWNER_1 = 100001;
const ROOT_OWNER_2 = 100002;
const AUTH_USER_1 = 200001;
const AUTH_USER_2 = 200002;
const UNAUTH_USER = 999999;

const TEST_ENCRYPTION_KEY = 'access-control-test-master-key-32-chars';
const createdDirs: string[] = [];

async function createAccessStore(): Promise<BotStore> {
  const dir = await mkdtemp(join(tmpdir(), 'pons-access-test-'));
  createdDirs.push(dir);

  const env = parseEnv({
    BOT_TOKEN: '123456:DUMMY_BOT_TOKEN',
    OWNER_TELEGRAM_IDS: `${ROOT_OWNER_1},${ROOT_OWNER_2}`,
    ALLOWED_TELEGRAM_IDS: `${AUTH_USER_1}`,
    ENCRYPTION_KEY: TEST_ENCRYPTION_KEY,
  });

  const store = new BotStore({
    filePath: join(dir, 'store.json'),
    encryptionKey: env.encryptionKey,
    ownerIds: env.ownerTelegramIds,
    initialAllowedIds: env.allowedTelegramIds,
    bootstrapDefaults: env.bootstrapDefaults,
  });
  await store.init();
  return store;
}

function collectCallbackData(kb: InlineKeyboard): string[] {
  const data: string[] = [];
  for (const row of kb.inline_keyboard) {
    for (const button of row) {
      if ('callback_data' in button && typeof button.callback_data === 'string') {
        data.push(button.callback_data);
      }
    }
  }
  return data;
}

function createMockContext(options: {
  userId?: number;
  isCallback?: boolean;
  chatType?: 'private' | 'group';
}): {
  ctx: Context;
  replies: string[];
  callbackAnswers: Array<{ text?: string; show_alert?: boolean } | undefined>;
} {
  const replies: string[] = [];
  const callbackAnswers: Array<{ text?: string; show_alert?: boolean } | undefined> = [];

  const ctx = {
    from: options.userId !== undefined ? { id: options.userId } : undefined,
    chat: { id: options.userId ?? 1, type: options.chatType ?? 'private' },
    callbackQuery: options.isCallback ? { id: 'cb-1', data: 'set:access:menu' } : undefined,
    reply: async (text: string) => {
      replies.push(text);
      return { message_id: 1 };
    },
    answerCallbackQuery: async (payload?: { text?: string; show_alert?: boolean }) => {
      callbackAnswers.push(payload);
      return true;
    },
  } as unknown as Context;

  return { ctx, replies, callbackAnswers };
}

describe('Access Control, Owner ACL, Session Cleanup & Keyboard Limits', () => {
  after(async () => {
    await Promise.all(createdDirs.map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it('allows Root Owners from OWNER_TELEGRAM_IDS to add, list, remove, and clear additional authorized users', async () => {
    const store = await createAccessStore();

    assert.deepEqual(store.listOwnerIds(), [ROOT_OWNER_1, ROOT_OWNER_2]);
    assert.equal(store.isOwner(ROOT_OWNER_1), true);
    assert.equal(store.isOwner(ROOT_OWNER_2), true);
    assert.equal(store.isOwner(AUTH_USER_1), false);
    assert.equal(store.isAuthorized(AUTH_USER_1), true);

    // Add new user with label
    const added = await store.addAuthorizedUser(ROOT_OWNER_1, AUTH_USER_2, 'Launch Operator');
    assert.equal(added.userId, AUTH_USER_2);
    assert.equal(added.label, 'Launch Operator');
    assert.equal(added.addedBy, ROOT_OWNER_1);
    assert.equal(store.isAuthorized(AUTH_USER_2), true);
    assert.equal(store.listAuthorizedUsers().length, 2);

    // Remove individual user
    assert.equal(await store.removeAuthorizedUser(ROOT_OWNER_2, AUTH_USER_2), true);
    assert.equal(store.isAuthorized(AUTH_USER_2), false);
    assert.equal(await store.removeAuthorizedUser(ROOT_OWNER_2, AUTH_USER_2), false);

    // Re-add and clear all non-owners
    await store.addAuthorizedUser(ROOT_OWNER_1, AUTH_USER_2, 'Temp Operator');
    assert.equal(store.listAuthorizedUsers().length, 2);

    const clearedCount = await store.clearAuthorizedUsers(ROOT_OWNER_1);
    assert.equal(clearedCount, 2);
    assert.equal(store.listAuthorizedUsers().length, 0);
    assert.equal(store.isAuthorized(AUTH_USER_1), false);
    assert.equal(store.isAuthorized(AUTH_USER_2), false);
  });

  it('keeps Root Owners immutable so they can never be removed or cleared', async () => {
    const store = await createAccessStore();

    await assert.rejects(
      () => store.removeAuthorizedUser(ROOT_OWNER_1, ROOT_OWNER_1),
      StoreAuthorizationError,
    );
    await assert.rejects(
      () => store.removeAuthorizedUser(ROOT_OWNER_1, ROOT_OWNER_2),
      StoreAuthorizationError,
    );
    await assert.rejects(
      () => store.addAuthorizedUser(ROOT_OWNER_1, ROOT_OWNER_2, 'Attempted Downgrade'),
      /immutable root owner/i,
    );

    await store.clearAuthorizedUsers(ROOT_OWNER_1);
    assert.equal(store.isOwner(ROOT_OWNER_1), true);
    assert.equal(store.isOwner(ROOT_OWNER_2), true);
    assert.equal(store.isAuthorized(ROOT_OWNER_1), true);
    assert.equal(store.isAuthorized(ROOT_OWNER_2), true);
  });

  it('rejects non-owner authorized users on mutating ACL methods, hides Owner Access button, and fails requireOwner()', async () => {
    const store = await createAccessStore();

    // Non-owner authorized user must be rejected on all mutating ACL store methods
    await assert.rejects(
      () => store.addAuthorizedUser(AUTH_USER_1, AUTH_USER_2, 'Escalation'),
      StoreAuthorizationError,
    );
    await assert.rejects(
      () => store.removeAuthorizedUser(AUTH_USER_1, AUTH_USER_1),
      StoreAuthorizationError,
    );
    await assert.rejects(
      () => store.clearAuthorizedUsers(AUTH_USER_1),
      StoreAuthorizationError,
    );

    // Settings keyboard visibility check
    const nonOwnerCallbacks = collectCallbackData(keyboards.buildSettingsMenuKeyboard(false));
    const ownerCallbacks = collectCallbackData(keyboards.buildSettingsMenuKeyboard(true));
    assert.equal(nonOwnerCallbacks.includes('set:access:menu'), false);
    assert.equal(ownerCallbacks.includes('set:access:menu'), true);

    // requireOwner() check for callbackQuery and message contexts
    const ownerMock = createMockContext({ userId: ROOT_OWNER_1, isCallback: true });
    assert.equal(await requireOwner(ownerMock.ctx, store), true);
    assert.equal(ownerMock.callbackAnswers.length, 0);

    const nonOwnerCb = createMockContext({ userId: AUTH_USER_1, isCallback: true });
    assert.equal(await requireOwner(nonOwnerCb.ctx, store), false);
    assert.equal(nonOwnerCb.callbackAnswers.length, 1);
    assert.equal(nonOwnerCb.callbackAnswers[0]?.show_alert, true);

    const nonOwnerMsg = createMockContext({ userId: AUTH_USER_1, isCallback: false });
    assert.equal(await requireOwner(nonOwnerMsg.ctx, store), false);
    assert.equal(nonOwnerMsg.replies.length, 1);
  });

  it('denies unauthorized users in store.isAuthorized() and createAuthMiddleware()', async () => {
    const store = await createAccessStore();
    assert.equal(store.isAuthorized(UNAUTH_USER), false);

    const middleware = createAuthMiddleware(store);

    // Unauthorized callback query blocked
    const unauthCb = createMockContext({ userId: UNAUTH_USER, isCallback: true });
    let nextCalled = false;
    await middleware(unauthCb.ctx, async () => {
      nextCalled = true;
    });
    assert.equal(nextCalled, false);
    assert.equal(unauthCb.callbackAnswers.length, 1);
    assert.equal(unauthCb.callbackAnswers[0]?.show_alert, true);

    // Unauthorized private message blocked with denial reply
    const unauthMsg = createMockContext({ userId: UNAUTH_USER, isCallback: false, chatType: 'private' });
    nextCalled = false;
    await middleware(unauthMsg.ctx, async () => {
      nextCalled = true;
    });
    assert.equal(nextCalled, false);
    assert.equal(unauthMsg.replies.length, 1);
    assert.ok(unauthMsg.replies[0].includes(String(UNAUTH_USER)));

    // Authorized user passes middleware in private DM and gets an isolated profile created
    const authMsg = createMockContext({ userId: AUTH_USER_1, isCallback: false, chatType: 'private' });
    nextCalled = false;
    await middleware(authMsg.ctx, async () => {
      nextCalled = true;
    });
    assert.equal(nextCalled, true);
    assert.equal(authMsg.replies.length, 0);

    // Non-private group updates are strictly ignored even for Root Owners
    const ownerGroupMsg = createMockContext({ userId: ROOT_OWNER_1, isCallback: false, chatType: 'group' });
    nextCalled = false;
    await middleware(ownerGroupMsg.ctx, async () => {
      nextCalled = true;
    });
    assert.equal(nextCalled, false);
    assert.equal(ownerGroupMsg.replies.length, 0);
  });

  it('enforces chatId binding on pendingInput, single-use launch confirmation replay protection, and abort-on-revoke', () => {
    const session = new SessionManager();

    session.setPendingInput(AUTH_USER_1, {
      field: 'wallet_sponsor_pk',
      returnScreen: 'wallets',
      sensitive: true,
      promptMessageId: 42,
      chatId: AUTH_USER_1,
    });
    assert.ok(session.getPendingInput(AUTH_USER_1, AUTH_USER_1));
    assert.equal(session.getPendingInput(AUTH_USER_1, 777777), undefined);

    // One-time confirmation token prevents double-tap / replay launches
    const snap = session.createLaunchConfirmation(AUTH_USER_1, {
      chatId: AUTH_USER_1,
      salt: `0x${'ab'.repeat(32)}`,
      predictedToken: '0x2222222222222222222222222222222222222222',
      predictedCurve: '0x3333333333333333333333333333333333333333',
      launchFeeWei: 200000000000000n,
      fundWei: 1000000000000000n,
      creatorFeeRecipient: '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC',
    });
    assert.ok(session.consumeLaunchConfirmation(AUTH_USER_1, snap.confirmId, AUTH_USER_1));
    assert.equal(
      session.consumeLaunchConfirmation(AUTH_USER_1, snap.confirmId, AUTH_USER_1),
      undefined,
      'Second consumption of the same confirmId must fail (replay protection)',
    );

    // Workspace-wide shared launch lock blocks concurrent launches across different users
    assert.equal(session.tryAcquireLaunchLock(AUTH_USER_1), true);
    assert.equal(session.tryAcquireLaunchLock(AUTH_USER_2), false);
    assert.equal(session.isLaunching(AUTH_USER_2), true);
    assert.equal(session.getActiveLaunchUserId(), AUTH_USER_1);

    // Only lock owner can release it
    session.releaseLaunchLock(AUTH_USER_2);
    assert.equal(session.isLaunching(), true);

    // revokeUserSession aborts in-flight signal and clears pending input WITHOUT prematurely dropping launch lock
    const signal = session.getLaunchAbortSignal(AUTH_USER_1);
    assert.equal(signal?.aborted, false);

    session.revokeUserSession(AUTH_USER_1);
    assert.equal(session.getPendingInput(AUTH_USER_1), undefined);
    assert.equal(signal?.aborted, true);
    assert.equal(session.isLaunching(AUTH_USER_1), true);

    session.releaseLaunchLock(AUTH_USER_1);
    assert.equal(session.isLaunching(AUTH_USER_1), false);

    // clearAllLaunchConfirmations invalidates pending confirmations across all users
    const snapA = session.createLaunchConfirmation(AUTH_USER_1, {
      chatId: AUTH_USER_1,
      salt: `0x${'ab'.repeat(32)}`,
      predictedToken: '0x2222222222222222222222222222222222222222',
      predictedCurve: '0x3333333333333333333333333333333333333333',
      launchFeeWei: 200000000000000n,
      fundWei: 1000000000000000n,
      creatorFeeRecipient: '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC',
    });
    session.clearAllLaunchConfirmations();
    assert.equal(session.consumeLaunchConfirmation(AUTH_USER_1, snapA.confirmId, AUTH_USER_1), undefined);

    // clearUserSession clears pending input and lock completely
    session.setPendingInput(AUTH_USER_1, {
      field: 'wallet_sponsor_pk',
      returnScreen: 'wallets',
      sensitive: true,
      chatId: AUTH_USER_1,
    });
    assert.equal(session.tryAcquireLaunchLock(AUTH_USER_1), true);
    session.clearUserSession(AUTH_USER_1);
    assert.equal(session.getPendingInput(AUTH_USER_1), undefined);
    assert.equal(session.isLaunching(AUTH_USER_1), false);
    assert.equal(session.tryAcquireLaunchLock(AUTH_USER_1), true);
  });

  it('ensures every inline keyboard callback_data across src/bot/keyboards.ts is <= 64 UTF-8 bytes', () => {
    const samplePresets: TokenPreset[] = [
      {
        id: 'deadbeef',
        label: 'A Very Long Preset Label That Gets Truncated In Display',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
        draft: {
          name: 'Sample',
          symbol: 'SMP',
          logo: 'https://example.com/logo.png',
          description: '',
          socials: { twitter: '', telegram: '', discord: '', website: '', github: '' },
          customSalt: '',
        },
      },
    ];

    const sampleUsers: AuthorizedUserEntry[] = [
      {
        userId: Number.MAX_SAFE_INTEGER,
        label: 'Maximum Length Telegram User Label Example',
        addedBy: ROOT_OWNER_1,
        addedAt: '2026-01-01T00:00:00.000Z',
      },
    ];

    const builtKeyboards: Array<{ name: string; kb: InlineKeyboard }> = [
      { name: 'buildMainMenuKeyboard', kb: keyboards.buildMainMenuKeyboard() },
      { name: 'buildWalletMenuKeyboard', kb: keyboards.buildWalletMenuKeyboard() },
      { name: 'buildWalletClearConfirmKeyboard', kb: keyboards.buildWalletClearConfirmKeyboard() },
      { name: 'buildResetConfirmKeyboard', kb: keyboards.buildResetConfirmKeyboard() },
      { name: 'buildTokenMenuKeyboard', kb: keyboards.buildTokenMenuKeyboard() },
      { name: 'buildSocialsMenuKeyboard', kb: keyboards.buildSocialsMenuKeyboard() },
      { name: 'buildPresetsMenuKeyboard', kb: keyboards.buildPresetsMenuKeyboard(samplePresets) },
      { name: 'buildSettingsMenuKeyboard(true)', kb: keyboards.buildSettingsMenuKeyboard(true) },
      { name: 'buildSettingsMenuKeyboard(false)', kb: keyboards.buildSettingsMenuKeyboard(false) },
      { name: 'buildNetworkSettingsKeyboard', kb: keyboards.buildNetworkSettingsKeyboard() },
      { name: 'buildFactorySettingsKeyboard(true)', kb: keyboards.buildFactorySettingsKeyboard(true) },
      { name: 'buildFactorySettingsKeyboard(false)', kb: keyboards.buildFactorySettingsKeyboard(false) },
      { name: 'buildFeeSettingsKeyboard', kb: keyboards.buildFeeSettingsKeyboard() },
      { name: 'buildSpeedSettingsKeyboard', kb: keyboards.buildSpeedSettingsKeyboard() },
      { name: 'buildPinataSettingsKeyboard(true)', kb: keyboards.buildPinataSettingsKeyboard(true) },
      { name: 'buildPinataSettingsKeyboard(false)', kb: keyboards.buildPinataSettingsKeyboard(false) },
      { name: 'buildAccessMenuKeyboard', kb: keyboards.buildAccessMenuKeyboard(sampleUsers) },
      { name: 'buildAccessClearConfirmKeyboard', kb: keyboards.buildAccessClearConfirmKeyboard() },
      { name: 'buildLaunchConfirmKeyboard', kb: keyboards.buildLaunchConfirmKeyboard('a1b2c3d4e5f6') },
      { name: 'buildPostSimulationKeyboard', kb: keyboards.buildPostSimulationKeyboard() },
      { name: 'buildBackToMainKeyboard', kb: keyboards.buildBackToMainKeyboard() },
      { name: 'buildCancelInputKeyboard', kb: keyboards.buildCancelInputKeyboard() },
    ];

    // Confirm we covered every exported keyboard builder in src/bot/keyboards.ts
    const exportedBuilderNames = Object.keys(keyboards).filter((k) => k.startsWith('build'));
    for (const fnName of exportedBuilderNames) {
      assert.ok(
        builtKeyboards.some((entry) => entry.name.startsWith(fnName)),
        `Keyboard builder "${fnName}" must be audited for 64-byte callback_data limit`,
      );
    }

    let totalChecked = 0;
    for (const { name, kb } of builtKeyboards) {
      const callbacks = collectCallbackData(kb);
      assert.ok(callbacks.length > 0, `Expected ${name} to contain at least one callback button`);
      for (const cb of callbacks) {
        totalChecked += 1;
        const byteLen = Buffer.byteLength(cb, 'utf8');
        assert.ok(byteLen > 0, `Empty callback_data found in ${name}`);
        assert.ok(
          byteLen <= 64,
          `callback_data "${cb}" in ${name} is ${byteLen} bytes (exceeds Telegram 64-byte limit)`,
        );
      }
    }

    assert.ok(totalChecked >= 60);
  });
});
