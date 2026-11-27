import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, beforeEach, describe, it } from 'node:test';
import type { Hex } from 'viem';
import { BotStore } from '../src/storage/store.js';

// Deterministic well-known Anvil / Hardhat test private keys (NEVER real funds)
const SPONSOR_PK_1: Hex = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const TARGET_PK_1: Hex = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';
const SPONSOR_PK_2: Hex = '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a';
const TARGET_PK_2: Hex = '0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6';
const FEE_RECIPIENT = '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC';
const CUSTOM_FACTORY = '0x1111111111111111111111111111111111111111';
const CUSTOM_PAIR = '0x2222222222222222222222222222222222222222';
const CUSTOM_ECONOMICS: Hex = `0x${'ab'.repeat(32)}`;
const CUSTOM_SALT: Hex = `0x${'cd'.repeat(32)}`;

const TEST_ENCRYPTION_KEY = 'unit-test-encryption-key-pons-launch-tool-v1';
const SAMPLE_PINATA_JWT = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJ0ZXN0IjoidG9rZW4ifQ.dummyPinataJwtSecretValue';

const OWNER_ID = 100001;
const USER_B_ID = 200002;
const USER_C_ID = 300003;

const createdDirs: string[] = [];

async function createTempStoreFile(): Promise<{ dir: string; filePath: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'pons-store-test-'));
  createdDirs.push(dir);
  return { dir, filePath: join(dir, 'nested', 'store.json') };
}

describe('Encrypted BotStore (src/storage/store.ts)', () => {
  after(async () => {
    await Promise.all(createdDirs.map((dir) => rm(dir, { recursive: true, force: true })));
  });

  beforeEach(() => {
    // Each test allocates its own isolated temp directory.
  });

  it('rejects construction without at least one root owner ID', () => {
    assert.throws(
      () =>
        new BotStore({
          filePath: join(tmpdir(), 'unused-store.json'),
          encryptionKey: TEST_ENCRYPTION_KEY,
          ownerIds: [],
        }),
      /at least one root owner/i,
    );
  });

  it('initializes atomically on disk and never stores plaintext private keys or Pinata JWT', async () => {
    const { dir, filePath } = await createTempStoreFile();
    const store = new BotStore({
      filePath,
      encryptionKey: TEST_ENCRYPTION_KEY,
      ownerIds: [OWNER_ID],
      initialAllowedIds: [OWNER_ID, USER_B_ID],
    });
    await store.init();

    await store.setSponsorPrivateKey(OWNER_ID, SPONSOR_PK_1);
    await store.setTargetPrivateKey(OWNER_ID, TARGET_PK_1);
    await store.setPinataJwt(OWNER_ID, SAMPLE_PINATA_JWT);

    const rawOnDisk = await readFile(filePath, 'utf8');
    // Plaintext secrets (with or without 0x) must never appear in raw storage
    assert.equal(rawOnDisk.includes(SPONSOR_PK_1), false);
    assert.equal(rawOnDisk.includes(SPONSOR_PK_1.slice(2)), false);
    assert.equal(rawOnDisk.includes(TARGET_PK_1), false);
    assert.equal(rawOnDisk.includes(TARGET_PK_1.slice(2)), false);
    assert.equal(rawOnDisk.includes(SAMPLE_PINATA_JWT), false);

    // Ensure atomic rename left no stale .tmp files behind
    const filesInDir = await readdir(join(dir, 'nested'));
    assert.deepEqual(filesInDir, ['store.json']);

    // Reload with a fresh BotStore instance and confirm state & decryption survive persistence
    const reloaded = new BotStore({
      filePath,
      encryptionKey: TEST_ENCRYPTION_KEY,
      ownerIds: [OWNER_ID],
    });
    await reloaded.init();

    assert.equal(reloaded.isOwner(OWNER_ID), true);
    assert.equal(reloaded.isAuthorized(USER_B_ID), true);
    assert.equal(reloaded.listAuthorizedUsers().length, 1);
    assert.equal(reloaded.listAuthorizedUsers()[0].userId, USER_B_ID);

    const wallets = reloaded.getDecryptedWallets(OWNER_ID);
    assert.equal(wallets.sponsorPk, SPONSOR_PK_1);
    assert.equal(wallets.targetPk, TARGET_PK_1);
    assert.equal(reloaded.getDecryptedPinataJwt(OWNER_ID), SAMPLE_PINATA_JWT);

    // Reloading with the wrong encryption key must fail decryption
    const wrongKeyStore = new BotStore({
      filePath,
      encryptionKey: 'completely-different-master-key-value',
      ownerIds: [OWNER_ID],
    });
    await wrongKeyStore.init();
    assert.throws(() => wrongKeyStore.getDecryptedWallets(OWNER_ID));
    assert.throws(() => wrongKeyStore.getDecryptedPinataJwt(OWNER_ID));
  });

  it('supports setting, replacing (rotating), and clearing Sponsor and Target private keys', async () => {
    const { filePath } = await createTempStoreFile();
    const store = new BotStore({
      filePath,
      encryptionKey: TEST_ENCRYPTION_KEY,
      ownerIds: [OWNER_ID],
    });
    await store.init();

    // Initial set
    await store.setSponsorPrivateKey(OWNER_ID, SPONSOR_PK_1);
    await store.setTargetPrivateKey(OWNER_ID, TARGET_PK_1);
    assert.deepEqual(store.getDecryptedWallets(OWNER_ID), {
      sponsorPk: SPONSOR_PK_1,
      targetPk: TARGET_PK_1,
    });
    const firstCipherSponsor = store.getUserProfile(OWNER_ID).wallets.sponsorPkEnc;
    const firstCipherTarget = store.getUserProfile(OWNER_ID).wallets.targetPkEnc;

    // Rotate both keys
    await store.setSponsorPrivateKey(OWNER_ID, SPONSOR_PK_2);
    await store.setTargetPrivateKey(OWNER_ID, TARGET_PK_2);
    assert.deepEqual(store.getDecryptedWallets(OWNER_ID), {
      sponsorPk: SPONSOR_PK_2,
      targetPk: TARGET_PK_2,
    });
    assert.notEqual(store.getUserProfile(OWNER_ID).wallets.sponsorPkEnc, firstCipherSponsor);
    assert.notEqual(store.getUserProfile(OWNER_ID).wallets.targetPkEnc, firstCipherTarget);

    // Clear Sponsor only
    await store.clearSponsorPrivateKey(OWNER_ID);
    assert.deepEqual(store.getDecryptedWallets(OWNER_ID), {
      targetPk: TARGET_PK_2,
    });

    // Clear Target only
    await store.clearTargetPrivateKey(OWNER_ID);
    assert.deepEqual(store.getDecryptedWallets(OWNER_ID), {});

    // Set both again and clear all wallets at once
    await store.setSponsorPrivateKey(OWNER_ID, SPONSOR_PK_1);
    await store.setTargetPrivateKey(OWNER_ID, TARGET_PK_1);
    await store.clearAllWallets(OWNER_ID);
    assert.deepEqual(store.getDecryptedWallets(OWNER_ID), {});
    assert.equal(store.getUserProfile(OWNER_ID).wallets.sponsorPkEnc, undefined);
    assert.equal(store.getUserProfile(OWNER_ID).wallets.targetPkEnc, undefined);
  });

  it('atomically resets all 8 launch-data fields in resetLaunchData while preserving all retained settings, Pinata, presets, and ACL', async () => {
    const { filePath } = await createTempStoreFile();
    const store = new BotStore({
      filePath,
      encryptionKey: TEST_ENCRYPTION_KEY,
      ownerIds: [OWNER_ID],
    });
    await store.init();

    // Populate ACL
    await store.addAuthorizedUser(OWNER_ID, USER_B_ID, 'Operator One');

    // Populate credentials & Pinata JWT
    await store.setSponsorPrivateKey(OWNER_ID, SPONSOR_PK_1);
    await store.setTargetPrivateKey(OWNER_ID, TARGET_PK_1);
    await store.setPinataJwt(OWNER_ID, SAMPLE_PINATA_JWT);

    // Populate custom Network, Factory, Fee, Execution, and IPFS gateway settings
    await store.updateUserSettings(OWNER_ID, (settings) => {
      settings.network = {
        rpcUrl: 'https://custom-rpc.example.com/v1',
        chainId: 8453,
        chainName: 'CustomChain',
        explorerUrl: 'https://explorer.example.com',
      };
      settings.contract = {
        factoryAddress: CUSTOM_FACTORY,
        launchConfigId: '42',
        pairToken: CUSTOM_PAIR,
        buybackEnabled: true,
        expectedEconomics: CUSTOM_ECONOMICS,
      };
      settings.fee = {
        fundAmountEth: '0.025',
        creatorFeeRecipient: FEE_RECIPIENT,
        creatorTaxBps: 500,
      };
      settings.execution = {
        gasPriceMultiplierBps: 20000,
        gasLimitMultiplierBps: 14000,
        maxPriorityFeeWei: '2500000',
        revokeGasLimit: '350000',
        fundGasLimit: '120000',
        sponsorGasReserveEth: '0.0005',
        safetyBufferEth: '0.0002',
        launchRetries: 600,
        launchRetryIntervalMs: 15,
        receiptPollingMs: 250,
        receiptTimeoutMs: 90000,
      };
      settings.ipfs.pinataGateway = 'https://custom-gateway.example.com/ipfs';
    });

    // Populate active token draft completely (including all 5 socials & customSalt)
    await store.updateTokenDraft(OWNER_ID, (draft) => {
      draft.name = 'Alpha Launch Token';
      draft.symbol = 'ALPHA';
      draft.logo = 'https://custom-gateway.example.com/ipfs/QmTestHash123';
      draft.description = 'High-speed token launch draft';
      draft.socials = {
        twitter: 'https://x.com/alphatoken',
        telegram: 'https://t.me/alphatoken',
        discord: 'https://discord.gg/alphatoken',
        website: 'https://alphatoken.example.com',
        github: 'https://github.com/alphatoken/contracts',
      };
      draft.customSalt = CUSTOM_SALT;
    });

    // Save two presets
    const preset1 = await store.savePreset(OWNER_ID, 'Alpha Template');
    const preset2 = await store.savePreset(OWNER_ID, 'Beta Template', {
      name: 'Beta Token',
      symbol: 'BETA',
      logo: 'https://example.com/beta.png',
      description: 'Second preset',
      socials: {
        twitter: 'https://x.com/beta',
        telegram: '',
        discord: '',
        website: '',
        github: 'https://github.com/beta',
      },
      customSalt: '',
    });

    // Execute atomic reset
    const afterReset = await store.resetLaunchData(OWNER_ID);

    // Verify all 8 target launch fields are cleared/reset
    assert.equal(afterReset.wallets.sponsorPkEnc, undefined);
    assert.equal(afterReset.wallets.targetPkEnc, undefined);
    assert.deepEqual(store.getDecryptedWallets(OWNER_ID), {});
    assert.equal(afterReset.settings.fee.creatorFeeRecipient, '');
    assert.equal(afterReset.tokenDraft.logo, '');
    assert.equal(afterReset.tokenDraft.name, '');
    assert.equal(afterReset.tokenDraft.symbol, '');
    assert.equal(afterReset.tokenDraft.description, '');
    assert.deepEqual(afterReset.tokenDraft.socials, {
      twitter: '',
      telegram: '',
      discord: '',
      website: '',
      github: '',
    });
    assert.equal(afterReset.tokenDraft.customSalt, '');

    // Verify retained configuration remains completely intact
    assert.deepEqual(afterReset.settings.network, {
      rpcUrl: 'https://custom-rpc.example.com/v1',
      chainId: 8453,
      chainName: 'CustomChain',
      explorerUrl: 'https://explorer.example.com',
    });
    assert.deepEqual(afterReset.settings.contract, {
      factoryAddress: CUSTOM_FACTORY,
      launchConfigId: '42',
      pairToken: CUSTOM_PAIR,
      buybackEnabled: true,
      expectedEconomics: CUSTOM_ECONOMICS,
    });
    assert.equal(afterReset.settings.fee.fundAmountEth, '0.025');
    assert.equal(afterReset.settings.fee.creatorTaxBps, 500);
    assert.deepEqual(afterReset.settings.execution, {
      gasPriceMultiplierBps: 20000,
      gasLimitMultiplierBps: 14000,
      maxPriorityFeeWei: '2500000',
      revokeGasLimit: '350000',
      fundGasLimit: '120000',
      sponsorGasReserveEth: '0.0005',
      safetyBufferEth: '0.0002',
      launchRetries: 600,
      launchRetryIntervalMs: 15,
      receiptPollingMs: 250,
      receiptTimeoutMs: 90000,
    });
    assert.equal(afterReset.settings.ipfs.pinataGateway, 'https://custom-gateway.example.com/ipfs');
    assert.ok(afterReset.settings.ipfs.pinataJwtEnc);
    assert.equal(store.getDecryptedPinataJwt(OWNER_ID), SAMPLE_PINATA_JWT);

    assert.equal(afterReset.presets.length, 2);
    assert.equal(afterReset.presets[0].id, preset1.id);
    assert.equal(afterReset.presets[0].draft.name, 'Alpha Launch Token');
    assert.equal(afterReset.presets[1].id, preset2.id);
    assert.equal(afterReset.presets[1].draft.symbol, 'BETA');

    assert.equal(store.isOwner(OWNER_ID), true);
    assert.equal(store.isAuthorized(USER_B_ID), true);
    assert.equal(store.listAuthorizedUsers().length, 1);

    // Reload from disk to confirm the atomic reset was durably persisted
    const reloaded = new BotStore({
      filePath,
      encryptionKey: TEST_ENCRYPTION_KEY,
      ownerIds: [OWNER_ID],
    });
    await reloaded.init();
    assert.deepEqual(reloaded.getDecryptedWallets(OWNER_ID), {});
    assert.equal(reloaded.getUserProfile(OWNER_ID).settings.fee.creatorFeeRecipient, '');
    assert.equal(reloaded.getUserProfile(OWNER_ID).tokenDraft.name, '');
    assert.equal(reloaded.getDecryptedPinataJwt(OWNER_ID), SAMPLE_PINATA_JWT);
    assert.equal(reloaded.listPresets(OWNER_ID).length, 2);
    assert.equal(reloaded.isAuthorized(USER_B_ID), true);
  });

  it('supports preset save, overwrite, load-to-draft isolation, and delete CRUD', async () => {
    const { filePath } = await createTempStoreFile();
    const store = new BotStore({
      filePath,
      encryptionKey: TEST_ENCRYPTION_KEY,
      ownerIds: [OWNER_ID],
    });
    await store.init();

    await assert.rejects(() => store.savePreset(OWNER_ID, '   '), /must not be empty/i);

    await store.updateTokenDraft(OWNER_ID, (draft) => {
      draft.name = 'First Token';
      draft.symbol = 'ONE';
      draft.logo = 'https://example.com/one.png';
      draft.socials.github = 'https://github.com/org/one';
    });

    const created = await store.savePreset(OWNER_ID, 'Core Preset');
    assert.equal(created.label, 'Core Preset');
    assert.match(created.id, /^[0-9a-f]{8}$/);
    assert.equal(store.listPresets(OWNER_ID).length, 1);

    // Case-insensitive label overwrite preserves preset ID and updates draft
    await store.updateTokenDraft(OWNER_ID, (draft) => {
      draft.name = 'Updated Token';
      draft.symbol = 'UPD';
    });
    const updated = await store.savePreset(OWNER_ID, 'core preset');
    assert.equal(updated.id, created.id);
    assert.equal(updated.label, 'core preset');
    assert.equal(updated.draft.name, 'Updated Token');
    assert.equal(store.listPresets(OWNER_ID).length, 1);

    // Clear active draft, then load preset back into draft
    await store.clearTokenDraft(OWNER_ID);
    assert.equal(store.getUserProfile(OWNER_ID).tokenDraft.name, '');

    const loadedDraft = await store.loadPresetToDraft(OWNER_ID, created.id);
    assert.equal(loadedDraft.name, 'Updated Token');
    assert.equal(loadedDraft.symbol, 'UPD');
    assert.equal(loadedDraft.socials.github, 'https://github.com/org/one');

    // Mutating active draft after load must NOT mutate saved preset
    await store.updateTokenDraft(OWNER_ID, (draft) => {
      draft.name = 'Mutated Draft Only';
    });
    assert.equal(store.listPresets(OWNER_ID)[0].draft.name, 'Updated Token');

    await assert.rejects(() => store.loadPresetToDraft(OWNER_ID, 'deadbeef'), /not found/i);

    // Delete preset
    assert.equal(await store.deletePreset(OWNER_ID, created.id), true);
    assert.equal(await store.deletePreset(OWNER_ID, created.id), false);
    assert.equal(store.listPresets(OWNER_ID).length, 0);
  });

  it('serializes concurrent mutations without data loss or file corruption', async () => {
    const { filePath } = await createTempStoreFile();
    const store = new BotStore({
      filePath,
      encryptionKey: TEST_ENCRYPTION_KEY,
      ownerIds: [OWNER_ID],
    });
    await store.init();

    const presetCount = 15;
    const userCount = 10;

    const ops: Array<Promise<unknown>> = [];
    for (let i = 0; i < presetCount; i += 1) {
      ops.push(
        store.savePreset(OWNER_ID, `Parallel Preset ${i}`, {
          name: `Token ${i}`,
          symbol: `TK${i}`,
          logo: `https://example.com/${i}.png`,
          description: `Concurrent entry ${i}`,
          socials: { twitter: '', telegram: '', discord: '', website: '', github: '' },
          customSalt: '',
        }),
      );
    }
    for (let j = 0; j < userCount; j += 1) {
      ops.push(store.addAuthorizedUser(OWNER_ID, 500000 + j, `Op ${j}`));
    }
    ops.push(store.setSponsorPrivateKey(OWNER_ID, SPONSOR_PK_1));
    ops.push(store.setTargetPrivateKey(OWNER_ID, TARGET_PK_1));
    ops.push(store.setSponsorPrivateKey(USER_B_ID, SPONSOR_PK_2));
    ops.push(
      store.updateUserSettings(OWNER_ID, (s) => {
        s.fee.creatorTaxBps = 450;
      }),
    );

    await Promise.all(ops);

    assert.equal(store.listPresets(OWNER_ID).length, presetCount);
    assert.equal(store.listAuthorizedUsers().length, userCount);
    assert.equal(store.getDecryptedWallets(OWNER_ID).sponsorPk, SPONSOR_PK_1);
    assert.equal(store.getDecryptedWallets(OWNER_ID).targetPk, TARGET_PK_1);
    assert.equal(store.getDecryptedWallets(USER_B_ID).sponsorPk, SPONSOR_PK_2);
    assert.equal(store.getUserProfile(OWNER_ID).settings.fee.creatorTaxBps, 450);

    // Reload from disk to ensure serialized JSON is completely valid and complete
    const reloaded = new BotStore({
      filePath,
      encryptionKey: TEST_ENCRYPTION_KEY,
      ownerIds: [OWNER_ID],
    });
    await reloaded.init();
    assert.equal(reloaded.listPresets(OWNER_ID).length, presetCount);
    assert.equal(reloaded.listAuthorizedUsers().length, userCount);
    assert.equal(reloaded.getDecryptedWallets(OWNER_ID).sponsorPk, SPONSOR_PK_1);
    assert.equal(reloaded.getDecryptedWallets(USER_B_ID).sponsorPk, SPONSOR_PK_2);
  });

  it('enforces strict per-user isolation so User B never inherits Owner credentials, settings, or drafts', async () => {
    const { filePath } = await createTempStoreFile();
    const store = new BotStore({
      filePath,
      encryptionKey: TEST_ENCRYPTION_KEY,
      ownerIds: [OWNER_ID],
    });
    await store.init();

    // Owner configures everything
    await store.addAuthorizedUser(OWNER_ID, USER_B_ID, 'Operator B');
    await store.addAuthorizedUser(OWNER_ID, USER_C_ID, 'Operator C');
    await store.setSponsorPrivateKey(OWNER_ID, SPONSOR_PK_1);
    await store.setTargetPrivateKey(OWNER_ID, TARGET_PK_1);
    await store.setPinataJwt(OWNER_ID, SAMPLE_PINATA_JWT);
    await store.updateUserSettings(OWNER_ID, (s) => {
      s.network.rpcUrl = 'https://owner-private-rpc.example.com';
      s.fee.creatorFeeRecipient = FEE_RECIPIENT;
      s.fee.creatorTaxBps = 750;
      s.ipfs.pinataGateway = 'https://owner-gw.example.com/ipfs';
    });
    await store.updateTokenDraft(OWNER_ID, (d) => {
      d.name = 'Owner Secret Token';
      d.symbol = 'OWN';
      d.logo = 'https://owner.example.com/logo.png';
    });
    await store.savePreset(OWNER_ID, 'Owner Preset');

    // User B initializes profile
    const profileB = await store.ensureUserProfile(USER_B_ID);
    assert.equal(profileB.userId, USER_B_ID);
    assert.deepEqual(store.getDecryptedWallets(USER_B_ID), {});
    assert.equal(store.getDecryptedPinataJwt(USER_B_ID), undefined);
    assert.equal(profileB.wallets.sponsorPkEnc, undefined);
    assert.equal(profileB.wallets.targetPkEnc, undefined);
    assert.equal(profileB.settings.ipfs.pinataJwtEnc, undefined);
    assert.equal(profileB.settings.fee.creatorFeeRecipient, '');
    assert.notEqual(profileB.settings.network.rpcUrl, 'https://owner-private-rpc.example.com');
    assert.equal(profileB.tokenDraft.name, '');
    assert.equal(profileB.tokenDraft.symbol, '');
    assert.equal(profileB.presets.length, 0);

    // Mutating returned object from getUserProfile must not mutate internal store state
    profileB.tokenDraft.name = 'External Mutation Attempt';
    assert.equal(store.getUserProfile(USER_B_ID).tokenDraft.name, '');

    // User B setting its own data and resetting does not affect Owner or User C
    await store.setSponsorPrivateKey(USER_B_ID, SPONSOR_PK_2);
    await store.resetLaunchData(USER_B_ID);
    assert.equal(store.getDecryptedWallets(OWNER_ID).sponsorPk, SPONSOR_PK_1);
    assert.equal(store.getDecryptedWallets(OWNER_ID).targetPk, TARGET_PK_1);
    assert.equal(store.getDecryptedPinataJwt(OWNER_ID), SAMPLE_PINATA_JWT);
    assert.equal(store.getUserProfile(OWNER_ID).tokenDraft.name, 'Owner Secret Token');
    assert.deepEqual(store.getDecryptedWallets(USER_C_ID), {});
  });

  it('rejects cross-user and cross-field ciphertext transplant on disk via GCM AAD binding', async () => {
    const { filePath } = await createTempStoreFile();
    const store = new BotStore({
      filePath,
      encryptionKey: TEST_ENCRYPTION_KEY,
      ownerIds: [OWNER_ID],
    });
    await store.init();
    await store.setSponsorPrivateKey(OWNER_ID, SPONSOR_PK_1);
    await store.ensureUserProfile(USER_B_ID);

    // Simulate tampered disk file transplanting Owner's sponsorPkEnc into User B and into Owner's targetPkEnc
    const rawJson = JSON.parse(await readFile(filePath, 'utf8')) as {
      users: Record<string, { wallets: { sponsorPkEnc?: string; targetPkEnc?: string } }>;
    };
    const ownerSponsorCipher = rawJson.users[String(OWNER_ID)].wallets.sponsorPkEnc;
    assert.ok(ownerSponsorCipher);
    rawJson.users[String(USER_B_ID)].wallets.sponsorPkEnc = ownerSponsorCipher;
    rawJson.users[String(OWNER_ID)].wallets.targetPkEnc = ownerSponsorCipher;
    await writeFile(filePath, JSON.stringify(rawJson, null, 2), 'utf8');

    const tamperedStore = new BotStore({
      filePath,
      encryptionKey: TEST_ENCRYPTION_KEY,
      ownerIds: [OWNER_ID],
    });
    await tamperedStore.init();

    assert.throws(() => tamperedStore.getDecryptedWallets(USER_B_ID));
    assert.throws(() => tamperedStore.getDecryptedWallets(OWNER_ID));
  });
});
