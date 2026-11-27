import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  decodeFunctionData,
  encodeFunctionData,
  InvalidInputRpcError,
  keccak256,
  parseEther,
  parseTransaction,
  recoverTransactionAddress,
  RpcRequestError,
  zeroAddress,
  type Address,
  type Hex,
  type PublicClient,
  type TransactionSerialized,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { recoverAuthorizationAddress } from 'viem/utils';
import { PONS_FACTORY_ABI } from '../src/blockchain/abi.js';
import {
  checkRpcHealth,
  checkWalletsStatus,
  executeLaunch,
  extractBlockchainError,
  isAlreadyKnownError,
  parseEip7702Delegation,
  simulateLaunch,
} from '../src/blockchain/launcher.js';
import { createDefaultUserSettings, createEmptyTokenDraft } from '../src/config/defaults.js';
import type { PartialDecryptedWallets, TokenDraft, UserSettings } from '../src/types/domain.js';

// Deterministic well-known Anvil / Hardhat test private keys (NEVER real funds)
const SPONSOR_PK: Hex = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const TARGET_PK: Hex = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';
const SPONSOR_ACCOUNT = privateKeyToAccount(SPONSOR_PK);
const TARGET_ACCOUNT = privateKeyToAccount(TARGET_PK);
const CREATOR_FEE_RECIPIENT: Address = '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC';
const DELEGATE_CONTRACT: Address = '0x1111111111111111111111111111111111111111';
const PREDICTED_TOKEN: Address = '0x2222222222222222222222222222222222222222';
const PREDICTED_CURVE: Address = '0x3333333333333333333333333333333333333333';
const CUSTOM_SALT: Hex = `0x${'ab'.repeat(32)}`;

function createValidSettings(overrides?: Partial<UserSettings>): UserSettings {
  const base = createDefaultUserSettings();
  base.fee.creatorFeeRecipient = CREATOR_FEE_RECIPIENT;
  base.fee.fundAmountEth = '0.001';
  base.fee.creatorTaxBps = 300;
  base.execution.launchRetries = 10;
  base.execution.launchRetryIntervalMs = 5;
  base.execution.receiptPollingMs = 10;
  base.execution.receiptTimeoutMs = 5000;
  return {
    ...base,
    ...overrides,
  };
}

function createValidDraft(overrides?: Partial<TokenDraft>): TokenDraft {
  return {
    ...createEmptyTokenDraft(),
    name: 'Pons Test Token',
    symbol: 'PTST',
    logo: 'https://gateway.pinata.cloud/ipfs/QmLogoHash',
    description: 'Automated test token launch',
    socials: {
      twitter: 'https://x.com/ponstest',
      telegram: 'https://t.me/ponstest',
      discord: 'https://discord.gg/ponstest',
      website: 'https://ponstest.example.com',
      github: 'https://github.com/ponstest/contracts',
    },
    customSalt: CUSTOM_SALT,
    ...overrides,
  };
}

function createValidWallets(): PartialDecryptedWallets {
  return {
    sponsorPk: SPONSOR_PK,
    targetPk: TARGET_PK,
  };
}

interface MockClientConfig {
  chainId?: number;
  launchFee?: bigint;
  gasPrice?: bigint;
  sponsorBalance?: bigint;
  targetBalance?: bigint;
  postTargetBalance?: bigint;
  targetCode?: Hex;
  targetNonce?: number;
  sponsorNonce?: number;
  estimatedGas?: bigint;
  predictedToken?: Address;
  predictedCurve?: Address;
  receiptStatus?: 'success' | 'reverted';
  onSimulateContract?: (args: Record<string, unknown>) => void;
  onEstimateContractGas?: (args: Record<string, unknown>) => void;
  onSendRawTransaction?: (serializedTransaction: Hex, index: number) => Promise<Hex>;
  onWaitForReceipt?: (args: Record<string, unknown>) => void;
}

function createMockPublicClient(config: MockClientConfig = {}): {
  client: PublicClient;
  sentTxs: Array<{ serialized: Hex; sentAt: number }>;
} {
  const sentTxs: Array<{ serialized: Hex; sentAt: number }> = [];
  let receiptWaited = false;

  const client = {
    getChainId: async () => config.chainId ?? 4663,
    getBlockNumber: async () => 123456n,
    readContract: async () => config.launchFee ?? parseEther('0.0002'),
    getGasPrice: async () => config.gasPrice ?? 1_000_000_000n, // 1 gwei
    getBalance: async ({ address }: { address: Address }) => {
      if (address.toLowerCase() === SPONSOR_ACCOUNT.address.toLowerCase()) {
        return config.sponsorBalance ?? parseEther('0.05');
      }
      if (address.toLowerCase() === TARGET_ACCOUNT.address.toLowerCase()) {
        if (receiptWaited && config.postTargetBalance !== undefined) {
          return config.postTargetBalance;
        }
        return config.targetBalance ?? 0n;
      }
      return 0n;
    },
    getCode: async () =>
      config.targetCode ?? (`0xef0100${DELEGATE_CONTRACT.slice(2).toLowerCase()}` as Hex),
    getTransactionCount: async ({ address }: { address: Address }) => {
      if (address.toLowerCase() === TARGET_ACCOUNT.address.toLowerCase()) {
        return config.targetNonce ?? 12;
      }
      if (address.toLowerCase() === SPONSOR_ACCOUNT.address.toLowerCase()) {
        return config.sponsorNonce ?? 7;
      }
      return 0;
    },
    simulateContract: async (args: Record<string, unknown>) => {
      config.onSimulateContract?.(args);
      return {
        result: [
          config.predictedToken ?? PREDICTED_TOKEN,
          config.predictedCurve ?? PREDICTED_CURVE,
        ] as const,
      };
    },
    estimateContractGas: async (args: Record<string, unknown>) => {
      config.onEstimateContractGas?.(args);
      return config.estimatedGas ?? 200_000n;
    },
    sendRawTransaction: async ({ serializedTransaction }: { serializedTransaction: Hex }) => {
      const idx = sentTxs.length;
      sentTxs.push({ serialized: serializedTransaction, sentAt: performance.now() });
      if (config.onSendRawTransaction) {
        return config.onSendRawTransaction(serializedTransaction, idx);
      }
      return keccak256(serializedTransaction);
    },
    waitForTransactionReceipt: async (args: Record<string, unknown>) => {
      config.onWaitForReceipt?.(args);
      receiptWaited = true;
      return {
        status: config.receiptStatus ?? 'success',
        blockNumber: 987654n,
        gasUsed: 185_000n,
        effectiveGasPrice: 1_200_000_000n,
      };
    },
  } as unknown as PublicClient;

  return { client, sentTxs };
}

describe('Pons V2 Launcher & ABI (src/blockchain/abi.ts & src/blockchain/launcher.ts)', () => {
  describe('Pons V2 Factory ABI regression checks', () => {
    it('defines socials.github (not farcaster) and round-trips launchToken calldata', () => {
      const launchFn = PONS_FACTORY_ABI.find(
        (item) => item.type === 'function' && item.name === 'launchToken',
      );
      assert.ok(launchFn && 'inputs' in launchFn);

      const paramsTuple = launchFn.inputs[0];
      assert.ok(paramsTuple && paramsTuple.type === 'tuple');
      const socialsTuple = paramsTuple.components.find((c) => c.name === 'socials');
      assert.ok(socialsTuple && 'components' in socialsTuple);

      const socialFieldNames = socialsTuple.components.map((c) => c.name);
      assert.deepEqual(socialFieldNames, ['twitter', 'telegram', 'discord', 'website', 'github']);
      assert.equal(socialFieldNames.includes('farcaster' as never), false);

      const encoded = encodeFunctionData({
        abi: PONS_FACTORY_ABI,
        functionName: 'launchToken',
        args: [
          {
            name: 'GitHub Regression Token',
            symbol: 'GHRT',
            logo: 'https://example.com/logo.png',
            description: 'Verifies github field in ABI encoding',
            socials: {
              twitter: 'https://x.com/ghrt',
              telegram: 'https://t.me/ghrt',
              discord: 'https://discord.gg/ghrt',
              website: 'https://ghrt.example.com',
              github: 'https://github.com/org/ghrt',
            },
            creatorFeeRecipient: CREATOR_FEE_RECIPIENT,
            creatorTaxBps: 300,
            buybackEnabled: false,
            expectedEconomics: `0x${'00'.repeat(32)}`,
            salt: CUSTOM_SALT,
          },
          0n,
          zeroAddress,
        ],
      });

      const decoded = decodeFunctionData({
        abi: PONS_FACTORY_ABI,
        data: encoded,
      });
      assert.equal(decoded.functionName, 'launchToken');
      assert.equal(decoded.args[0].socials.github, 'https://github.com/org/ghrt');
      assert.equal(decoded.args[0].creatorFeeRecipient, CREATOR_FEE_RECIPIENT);
    });
  });

  describe('parseEip7702Delegation', () => {
    it('detects 0xef0100<20-byte-address> EIP-7702 delegation designators', () => {
      const code = `0xef0100${DELEGATE_CONTRACT.slice(2).toLowerCase()}` as Hex;
      const info = parseEip7702Delegation(code);
      assert.equal(info.isDelegated, true);
      assert.equal(info.delegateAddress, DELEGATE_CONTRACT);
      assert.equal(info.rawCode, code);

      const upperCode = `0xEF0100${DELEGATE_CONTRACT.slice(2).toUpperCase()}` as Hex;
      const upperInfo = parseEip7702Delegation(upperCode);
      assert.equal(upperInfo.isDelegated, true);
      assert.equal(upperInfo.delegateAddress, DELEGATE_CONTRACT);
    });

    it('returns isDelegated: false for empty 0x, nullish, non-7702 bytecode, and malformed lengths', () => {
      for (const empty of ['0x' as Hex, undefined, null]) {
        const info = parseEip7702Delegation(empty);
        assert.equal(info.isDelegated, false);
        assert.equal(info.delegateAddress, undefined);
        assert.equal(info.rawCode, '0x');
      }

      const regularContract: Hex = '0x6080604052348015600f57600080fd5b50';
      const regularInfo = parseEip7702Delegation(regularContract);
      assert.equal(regularInfo.isDelegated, false);
      assert.equal(regularInfo.delegateAddress, undefined);
      assert.equal(regularInfo.rawCode, regularContract);

      const tooShort: Hex = '0xef010011111111111111111111';
      assert.equal(parseEip7702Delegation(tooShort).isDelegated, false);

      const tooLong: Hex = `0xef0100${DELEGATE_CONTRACT.slice(2)}00`;
      assert.equal(parseEip7702Delegation(tooLong).isDelegated, false);
    });
  });

  describe('simulateLaunch & pre-flight validation rules', () => {
    it('simulates with Target as msg.sender, explicit creatorFeeRecipient, and EIP-7702 stateOverride', async () => {
      let capturedSimArgs: Record<string, unknown> | undefined;
      let capturedGasArgs: Record<string, unknown> | undefined;

      const { client } = createMockPublicClient({
        onSimulateContract: (args) => {
          capturedSimArgs = args;
        },
        onEstimateContractGas: (args) => {
          capturedGasArgs = args;
        },
      });

      const settings = createValidSettings();
      const draft = createValidDraft();
      const sim = await simulateLaunch(settings, createValidWallets(), draft, client);

      assert.equal(sim.creator, TARGET_ACCOUNT.address);
      assert.equal(sim.targetAddress, TARGET_ACCOUNT.address);
      assert.equal(sim.sponsorAddress, SPONSOR_ACCOUNT.address);
      assert.equal(sim.creatorFeeRecipient, CREATOR_FEE_RECIPIENT);
      assert.equal(sim.predictedToken, PREDICTED_TOKEN);
      assert.equal(sim.predictedCurve, PREDICTED_CURVE);
      assert.equal(sim.targetDelegation.isDelegated, true);
      assert.equal(sim.targetDelegation.delegateAddress, DELEGATE_CONTRACT);
      assert.equal(sim.sponsorNonce, 7);
      assert.equal(sim.targetNonce, 12);

      // Verify simulateContract & estimateContractGas received Target as account & clean stateOverride
      assert.ok(capturedSimArgs && capturedGasArgs);
      assert.equal((capturedSimArgs.account as { address: Address }).address, TARGET_ACCOUNT.address);
      assert.equal((capturedGasArgs.account as { address: Address }).address, TARGET_ACCOUNT.address);
      assert.deepEqual(capturedSimArgs.stateOverride, [
        {
          address: TARGET_ACCOUNT.address,
          balance: parseEther('0.001'),
          code: '0x',
        },
      ]);

      const simParams = (capturedSimArgs.args as unknown[])[0] as {
        creatorFeeRecipient: Address;
        socials: { github: string };
      };
      assert.equal(simParams.creatorFeeRecipient, CREATOR_FEE_RECIPIENT);
      assert.equal(simParams.socials.github, draft.socials.github);
    });

    it('hard-rejects empty, zeroAddress, invalid, or Target-equal creatorFeeRecipient (never falls back to Sponsor)', async () => {
      const { client } = createMockPublicClient();
      const wallets = createValidWallets();
      const draft = createValidDraft();

      // Empty string
      const emptyRecipient = createValidSettings();
      emptyRecipient.fee.creatorFeeRecipient = '';
      await assert.rejects(
        () => simulateLaunch(emptyRecipient, wallets, draft, client),
        /mandatory.*no fallback to sponsor/i,
      );

      // Whitespace-only
      const spaceRecipient = createValidSettings();
      spaceRecipient.fee.creatorFeeRecipient = '   ';
      await assert.rejects(
        () => simulateLaunch(spaceRecipient, wallets, draft, client),
        /mandatory.*no fallback to sponsor/i,
      );

      // Zero address
      const zeroRecipient = createValidSettings();
      zeroRecipient.fee.creatorFeeRecipient = zeroAddress;
      await assert.rejects(
        () => simulateLaunch(zeroRecipient, wallets, draft, client),
        /must not be the zero address/i,
      );

      // Invalid EVM address
      const invalidRecipient = createValidSettings();
      invalidRecipient.fee.creatorFeeRecipient = '0xnotanaddress';
      await assert.rejects(
        () => simulateLaunch(invalidRecipient, wallets, draft, client),
        /Invalid creator fee recipient/i,
      );

      // Same as Target wallet (case-insensitive)
      const targetRecipient = createValidSettings();
      targetRecipient.fee.creatorFeeRecipient = TARGET_ACCOUNT.address.toLowerCase();
      await assert.rejects(
        () => simulateLaunch(targetRecipient, wallets, draft, client),
        /must not be the same as the Target/i,
      );
    });

    it('hard-rejects Sponsor === Target, missing PKs, missing token metadata, insufficient Sponsor ETH, and insufficient FUND_AMOUNT', async () => {
      const { client } = createMockPublicClient();
      const settings = createValidSettings();
      const draft = createValidDraft();

      // Sponsor === Target
      await assert.rejects(
        () => simulateLaunch(settings, { sponsorPk: SPONSOR_PK, targetPk: SPONSOR_PK }, draft, client),
        /must be two distinct addresses/i,
      );

      // Missing Sponsor PK
      await assert.rejects(
        () => simulateLaunch(settings, { targetPk: TARGET_PK }, draft, client),
        /Sponsor wallet private key is not configured/i,
      );

      // Missing Target PK
      await assert.rejects(
        () => simulateLaunch(settings, { sponsorPk: SPONSOR_PK }, draft, client),
        /Target wallet private key is not configured/i,
      );

      // Missing Name / Symbol / Logo
      await assert.rejects(
        () => simulateLaunch(settings, createValidWallets(), createValidDraft({ name: '   ' }), client),
        /Token name is required/i,
      );
      await assert.rejects(
        () => simulateLaunch(settings, createValidWallets(), createValidDraft({ symbol: '' }), client),
        /Token symbol is required/i,
      );
      await assert.rejects(
        () => simulateLaunch(settings, createValidWallets(), createValidDraft({ logo: '' }), client),
        /Token logo URL is required/i,
      );

      // Insufficient Sponsor balance (< fund 0.001 + reserve 0.0001 = 0.0011 ETH)
      const lowSponsorMock = createMockPublicClient({ sponsorBalance: parseEther('0.00109') });
      await assert.rejects(
        () => simulateLaunch(settings, createValidWallets(), draft, lowSponsorMock.client),
        /Insufficient Sponsor balance/i,
      );

      // Insufficient FUND_AMOUNT (< launchFee 0.0002 + gasLimit*maxFee 0.00036 + safetyBuffer 0.00005 = 0.00061 ETH)
      const lowFundSettings = createValidSettings();
      lowFundSettings.fee.fundAmountEth = '0.0005';
      await assert.rejects(
        () => simulateLaunch(lowFundSettings, createValidWallets(), draft, client),
        /Fund amount too low/i,
      );

      // Zero FUND_AMOUNT
      const zeroFundSettings = createValidSettings();
      zeroFundSettings.fee.fundAmountEth = '0';
      await assert.rejects(
        () => simulateLaunch(zeroFundSettings, createValidWallets(), draft, client),
        /Fund amount must be greater than 0/i,
      );
    });
  });

  describe('executeLaunch 3-TX pre-signing, nonce allocation, hot-path timing, and burst resilience', () => {
    it('pre-signs and broadcasts Revoke (sn0, 7702 auth n0) -> Fund (sn0+1) + Launch (Target n0+1) without awaiting slow onRevokeSent', async () => {
      const sn0 = 7;
      const n0 = 12;
      const postBalance = parseEther('0.000321');
      let waitReceiptArgs: Record<string, unknown> | undefined;

      const { client, sentTxs } = createMockPublicClient({
        sponsorNonce: sn0,
        targetNonce: n0,
        postTargetBalance: postBalance,
        onWaitForReceipt: (args) => {
          waitReceiptArgs = args;
        },
      });

      let onRevokeStartedAt = 0;
      let onRevokeFinishedAt = 0;
      let onRevokeHookPromise: Promise<void> | undefined;
      let broadcastSummaryAttempts = 0;

      const settings = createValidSettings();
      const draft = createValidDraft();

      const result = await executeLaunch(
        settings,
        createValidWallets(),
        draft,
        {
          onRevokeSent: () => {
            onRevokeStartedAt = performance.now();
            onRevokeHookPromise = new Promise<void>((resolve) => {
              setTimeout(() => {
                onRevokeFinishedAt = performance.now();
                resolve();
              }, 250);
            });
            return onRevokeHookPromise;
          },
          onBroadcastComplete: (summary) => {
            broadcastSummaryAttempts = summary.attempts;
          },
        },
        client,
      );

      // Must have broadcast Revoke, Fund, and at least one Launch attempt
      assert.ok(sentTxs.length >= 3);
      const [revokeTxEntry, fundTxEntry, launchTxEntry] = sentTxs;

      // Ordering & non-blocking hot-path timing assertions:
      // Revoke is sent first; Fund and Launch fire BEFORE slow 250ms onRevokeSent finishes!
      assert.ok(revokeTxEntry.sentAt <= fundTxEntry.sentAt);
      assert.ok(revokeTxEntry.sentAt <= launchTxEntry.sentAt);
      assert.ok(onRevokeStartedAt > 0);
      assert.equal(
        onRevokeFinishedAt,
        0,
        'executeLaunch must NOT await slow onRevokeSent before broadcasting Fund+Launch and completing',
      );

      // Cryptographically parse & verify TX #1: signedRevoke (Sponsor sn0, EIP-7702 zeroAddress auth Target n0)
      const parsedRevoke = parseTransaction(revokeTxEntry.serialized);
      assert.equal(parsedRevoke.type, 'eip7702');
      assert.equal(parsedRevoke.nonce, sn0);
      assert.equal(parsedRevoke.chainId, settings.network.chainId);
      assert.equal(parsedRevoke.to?.toLowerCase(), TARGET_ACCOUNT.address.toLowerCase());
      assert.equal(parsedRevoke.value ?? 0n, 0n);

      const revokeSender = await recoverTransactionAddress({
        serializedTransaction: revokeTxEntry.serialized as TransactionSerialized,
      });
      assert.equal(revokeSender.toLowerCase(), SPONSOR_ACCOUNT.address.toLowerCase());

      assert.ok(parsedRevoke.authorizationList && parsedRevoke.authorizationList.length === 1);
      const auth = parsedRevoke.authorizationList[0];
      assert.equal(auth.address.toLowerCase(), zeroAddress.toLowerCase());
      assert.equal(auth.nonce, n0);
      assert.equal(auth.chainId, settings.network.chainId);
      const authSigner = await recoverAuthorizationAddress({ authorization: auth });
      assert.equal(authSigner.toLowerCase(), TARGET_ACCOUNT.address.toLowerCase());

      // Cryptographically parse & verify TX #2: signedFund (Sponsor sn0+1 -> Target, value = fundWei)
      const parsedFund = parseTransaction(fundTxEntry.serialized);
      assert.equal(parsedFund.type, 'eip1559');
      assert.equal(parsedFund.nonce, sn0 + 1);
      assert.equal(parsedFund.to?.toLowerCase(), TARGET_ACCOUNT.address.toLowerCase());
      assert.equal(parsedFund.value, parseEther('0.001'));

      const fundSender = await recoverTransactionAddress({
        serializedTransaction: fundTxEntry.serialized as TransactionSerialized,
      });
      assert.equal(fundSender.toLowerCase(), SPONSOR_ACCOUNT.address.toLowerCase());

      // Cryptographically parse & verify TX #3: signedLaunch (Target n0+1 -> Factory, launchToken calldata)
      const parsedLaunch = parseTransaction(launchTxEntry.serialized);
      assert.equal(parsedLaunch.type, 'eip1559');
      assert.equal(parsedLaunch.nonce, n0 + 1);
      assert.equal(parsedLaunch.to?.toLowerCase(), settings.contract.factoryAddress.toLowerCase());
      assert.equal(parsedLaunch.value, parseEther('0.0002'));

      const launchSender = await recoverTransactionAddress({
        serializedTransaction: launchTxEntry.serialized as TransactionSerialized,
      });
      assert.equal(launchSender.toLowerCase(), TARGET_ACCOUNT.address.toLowerCase());

      assert.ok(parsedLaunch.data);
      const decodedLaunch = decodeFunctionData({
        abi: PONS_FACTORY_ABI,
        data: parsedLaunch.data,
      });
      assert.equal(decodedLaunch.functionName, 'launchToken');
      assert.equal(decodedLaunch.args[0].name, draft.name);
      assert.equal(decodedLaunch.args[0].symbol, draft.symbol);
      assert.equal(decodedLaunch.args[0].logo, draft.logo);
      assert.equal(decodedLaunch.args[0].socials.github, draft.socials.github);
      assert.equal(decodedLaunch.args[0].creatorFeeRecipient, CREATOR_FEE_RECIPIENT);
      assert.equal(decodedLaunch.args[0].creatorTaxBps, 300);
      assert.equal(decodedLaunch.args[0].salt, CUSTOM_SALT);

      // Verify returned LaunchResult & receipt polling parameters
      assert.equal(result.success, true);
      assert.equal(result.status, 'success');
      assert.equal(result.creator, TARGET_ACCOUNT.address);
      assert.equal(result.creatorFeeRecipient, CREATOR_FEE_RECIPIENT);
      assert.equal(result.revokeHash, keccak256(revokeTxEntry.serialized));
      assert.equal(result.fundHash, keccak256(fundTxEntry.serialized));
      assert.equal(result.launchHash, keccak256(launchTxEntry.serialized));
      assert.equal(result.postTargetBalance, postBalance);
      assert.equal(result.blockNumber, 987654n);
      assert.equal(broadcastSummaryAttempts, result.attempts);
      assert.equal(waitReceiptArgs?.hash, result.launchHash);
      assert.equal(waitReceiptArgs?.pollingInterval, settings.execution.receiptPollingMs);
      assert.equal(waitReceiptArgs?.timeout, settings.execution.receiptTimeoutMs);

      // Cleanly await the background timer so Node test runner has no dangling timer handle
      if (onRevokeHookPromise) {
        await onRevokeHookPromise;
      }
      assert.ok(onRevokeFinishedAt > launchTxEntry.sentAt);
    });

    it('recovers from temporary RPC errors during launch burst retries', async () => {
      let launchAttemptsSeen = 0;
      const postBalance = parseEther('0.000111');

      const { client } = createMockPublicClient({
        postTargetBalance: postBalance,
        onSendRawTransaction: async (serialized, idx) => {
          // idx 0 = revoke, idx 1 = fund, idx >= 2 = launch burst
          if (idx >= 2) {
            launchAttemptsSeen += 1;
            if (launchAttemptsSeen <= 2) {
              throw new Error('insufficient funds for gas * price + value');
            }
          }
          return keccak256(serialized);
        },
      });

      const settings = createValidSettings();
      settings.execution.launchRetries = 10;
      settings.execution.launchRetryIntervalMs = 5;

      const result = await executeLaunch(settings, createValidWallets(), createValidDraft(), undefined, client);
      assert.equal(result.success, true);
      assert.ok(result.attempts >= 3);
      assert.ok(launchAttemptsSeen >= 3);
      assert.equal(result.postTargetBalance, postBalance);
    });

    it('treats "already known" RPC error as accepted and computes launchHash via keccak256(signedLaunch)', async () => {
      let capturedSignedLaunch: Hex | undefined;
      let waitedHash: Hex | undefined;

      const { client } = createMockPublicClient({
        onSendRawTransaction: async (serialized, idx) => {
          if (idx >= 2) {
            capturedSignedLaunch = serialized;
            throw new Error('RPC error: already known');
          }
          return keccak256(serialized);
        },
        onWaitForReceipt: (args) => {
          waitedHash = args.hash as Hex;
        },
      });

      const settings = createValidSettings();
      const result = await executeLaunch(settings, createValidWallets(), createValidDraft(), undefined, client);

      assert.ok(capturedSignedLaunch);
      const expectedHash = keccak256(capturedSignedLaunch);
      assert.equal(result.success, true);
      assert.equal(result.launchHash, expectedHash);
      assert.equal(waitedHash, expectedHash);
    });

    it('returns status "reverted" when on-chain receipt reverts and throws when all burst attempts fail', async () => {
      const revertedMock = createMockPublicClient({ receiptStatus: 'reverted' });
      const revertedRes = await executeLaunch(
        createValidSettings(),
        createValidWallets(),
        createValidDraft(),
        undefined,
        revertedMock.client,
      );
      assert.equal(revertedRes.success, false);
      assert.equal(revertedRes.status, 'reverted');

      const allFailMock = createMockPublicClient({
        onSendRawTransaction: async (serialized, idx) => {
          if (idx >= 2) {
            throw new Error('nonce too low');
          }
          return keccak256(serialized);
        },
      });
      const settings = createValidSettings();
      settings.execution.launchRetries = 3;
      settings.execution.launchRetryIntervalMs = 2;

      await assert.rejects(
        () => executeLaunch(settings, createValidWallets(), createValidDraft(), undefined, allFailMock.client),
        /Launch transaction broadcast failed after 3 attempts.*nonce too low/i,
      );
    });
  });

  describe('checkRpcHealth & checkWalletsStatus', () => {
    it('reports online RPC health and EIP-7702 delegation status on wallets', async () => {
      const { client } = createMockPublicClient();
      const settings = createValidSettings();

      const health = await checkRpcHealth(settings.network, settings.contract, client);
      assert.equal(health.ok, true);
      assert.equal(health.blockNumber, 123456n);
      assert.equal(health.launchFee, parseEther('0.0002'));

      const status = await checkWalletsStatus(settings.network, createValidWallets(), client);
      assert.equal(status.sponsorAddress, SPONSOR_ACCOUNT.address);
      assert.equal(status.sponsorBalance, parseEther('0.05'));
      assert.equal(status.targetAddress, TARGET_ACCOUNT.address);
      assert.equal(status.targetDelegation?.isDelegated, true);
      assert.equal(status.targetDelegation?.delegateAddress, DELEGATE_CONTRACT);
    });

    it('detects viem InvalidInputRpcError "already known" details, redacts RPC path keys, and survives sync onRevokeSent throws', async () => {
      const viemAlreadyKnown = new InvalidInputRpcError(
        new RpcRequestError({
          body: { method: 'eth_sendRawTransaction' },
          error: { code: -32000, message: 'already known' },
          url: 'https://rpc.example.com/v2/super-secret-api-key',
        }),
      );

      assert.equal(isAlreadyKnownError(viemAlreadyKnown), true);
      const extracted = extractBlockchainError(viemAlreadyKnown);
      assert.match(extracted, /already known/i);
      assert.equal(extracted.includes('super-secret-api-key'), false);

      let capturedLaunch: Hex | undefined;
      const { client } = createMockPublicClient({
        onSendRawTransaction: async (serialized, idx) => {
          if (idx >= 2) {
            capturedLaunch = serialized;
            throw viemAlreadyKnown;
          }
          return keccak256(serialized);
        },
      });

      const result = await executeLaunch(
        createValidSettings(),
        createValidWallets(),
        createValidDraft(),
        {
          onRevokeSent: () => {
            throw new Error('synchronous hook failure must never abort hot path');
          },
        },
        client,
      );

      assert.ok(capturedLaunch);
      assert.equal(result.success, true);
      assert.equal(result.launchHash, keccak256(capturedLaunch));
    });

    it('rejects insufficient Sponsor upfront gas cost, eth_chainId mismatch, and on-chain launchFee surge', async () => {
      const settings = createValidSettings();
      // gasPrice = 1 gwei -> maxFee = 1.5 gwei -> (300k + 100k) * 1.5 gwei = 0.0006 ETH
      // fund 0.001 + sponsorGas 0.0006 + reserve 0.0001 = 0.0017 ETH required
      const underfundedSponsor = createMockPublicClient({
        sponsorBalance: parseEther('0.0015'),
      });
      await assert.rejects(
        () => simulateLaunch(settings, createValidWallets(), createValidDraft(), underfundedSponsor.client),
        /Insufficient Sponsor balance/i,
      );

      // Mismatched RPC eth_chainId rejected in both checkRpcHealth and simulateLaunch
      const wrongChainMock = createMockPublicClient({ chainId: 999999 });
      const badHealth = await checkRpcHealth(settings.network, settings.contract, wrongChainMock.client);
      assert.equal(badHealth.ok, false);
      assert.match(badHealth.error ?? '', /chain ID mismatch/i);

      await assert.rejects(
        () => simulateLaunch(settings, createValidWallets(), createValidDraft(), wrongChainMock.client),
        /chain ID mismatch/i,
      );

      // On-chain launchFee surge above confirmed expectation rejected before signing
      const { client } = createMockPublicClient({ launchFee: parseEther('0.0004') });
      await assert.rejects(
        () =>
          executeLaunch(
            settings,
            createValidWallets(),
            createValidDraft(),
            undefined,
            client,
            {
              preparedSalt: CUSTOM_SALT,
              expectedLaunchFeeWei: parseEther('0.0002'),
            },
          ),
        /launchFee increased since confirmation/i,
      );
    });
  });
});
