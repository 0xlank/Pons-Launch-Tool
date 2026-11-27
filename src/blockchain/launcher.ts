import { randomBytes } from 'node:crypto';
import {
  BaseError,
  encodeFunctionData,
  formatEther,
  getAddress,
  isAddress,
  keccak256,
  parseEther,
  zeroAddress,
  type Address,
  type Hex,
  type PublicClient,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import type {
  ContractSettings,
  Eip7702DelegationInfo,
  FeeSettings,
  LaunchHooks,
  LaunchResult,
  NetworkSettings,
  PartialDecryptedWallets,
  RpcHealthResult,
  SimulationResult,
  TokenDraft,
  UserSettings,
  WalletStatusResult,
} from '../types/domain.js';
import { PONS_FACTORY_ABI } from './abi.js';
import { getBurstPublicClient, getPublicClient } from './client.js';

const BYTES32_REGEX = /^0x[0-9a-fA-F]{64}$/;
const EIP7702_PREFIX = '0xef0100';
const ALREADY_KNOWN_REGEX = /already known|known transaction/i;
const MAX_BURST_INFLIGHT = 10;
const MAX_BURST_WALL_MS = 15_000;
const POST_LOOP_SETTLE_MS = 1_500;

export interface TokenLaunchParams {
  name: string;
  symbol: string;
  logo: string;
  description: string;
  socials: {
    twitter: string;
    telegram: string;
    discord: string;
    website: string;
    github: string;
  };
  creatorFeeRecipient: Address;
  creatorTaxBps: number;
  buybackEnabled: boolean;
  expectedEconomics: Hex;
  salt: Hex;
}

export interface ExecuteLaunchOptions {
  burstClient?: PublicClient;
  preparedSalt?: Hex;
  expectedLaunchFeeWei?: bigint;
  signal?: AbortSignal;
  checkAuthorized?: () => boolean;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function sanitizeRpcErrorText(raw: string): string {
  return raw
    // Redact embedded basic-auth credentials in URLs
    .replace(/(https?:\/\/)([^/\s@:]+):([^/\s@]+)@/gi, '$1***:***@')
    // Redact URL paths/queries that might hold private RPC API keys
    .replace(/(https?:\/\/[^\s/?#]+)\/[^\s"')]+/gi, '$1/***')
    // Redact Telegram bot tokens if ever present
    .replace(/\/bot\d+:[A-Za-z0-9_-]+/g, '/bot***')
    .trim();
}

export function extractBlockchainError(err: unknown): string {
  if (err instanceof BaseError) {
    const detailParts: string[] = [];
    const seen = new Set<string>();
    const addPart = (value: unknown): void => {
      if (typeof value !== 'string') {
        return;
      }
      const clean = sanitizeRpcErrorText(value);
      if (clean && !seen.has(clean)) {
        seen.add(clean);
        detailParts.push(clean);
      }
    };

    addPart(err.details);
    err.walk((nested) => {
      if (nested instanceof BaseError) {
        addPart(nested.details);
      } else if (nested instanceof Error) {
        addPart(nested.message);
      }
      return false;
    });

    const shortClean = err.shortMessage ? sanitizeRpcErrorText(err.shortMessage) : '';
    if (detailParts.length > 0) {
      const joinedDetails = detailParts.join(' | ');
      if (shortClean && !shortClean.includes(joinedDetails)) {
        return `${shortClean} (${joinedDetails})`;
      }
      return joinedDetails;
    }
    return shortClean || sanitizeRpcErrorText(err.message);
  }
  if (err instanceof Error) {
    return sanitizeRpcErrorText(err.message);
  }
  return sanitizeRpcErrorText(String(err));
}

export function isAlreadyKnownError(err: unknown): boolean {
  if (err instanceof BaseError) {
    if (err.details && ALREADY_KNOWN_REGEX.test(err.details)) {
      return true;
    }
    if (err.shortMessage && ALREADY_KNOWN_REGEX.test(err.shortMessage)) {
      return true;
    }
    if (err.message && ALREADY_KNOWN_REGEX.test(err.message)) {
      return true;
    }
    let matched = false;
    err.walk((nested) => {
      if (nested instanceof BaseError && nested.details && ALREADY_KNOWN_REGEX.test(nested.details)) {
        matched = true;
        return true;
      }
      if (nested instanceof Error && ALREADY_KNOWN_REGEX.test(nested.message)) {
        matched = true;
        return true;
      }
      return false;
    });
    return matched;
  }
  if (err instanceof Error) {
    return ALREADY_KNOWN_REGEX.test(err.message);
  }
  return ALREADY_KNOWN_REGEX.test(String(err));
}

export function parseEip7702Delegation(bytecode: Hex | undefined | null): Eip7702DelegationInfo {
  const rawCode = (bytecode && bytecode !== '0x' ? bytecode : '0x') as Hex;
  const lower = rawCode.toLowerCase();

  // EIP-7702 delegation designator: 0xef0100 || 20-byte address (total 23 bytes = 48 chars with 0x)
  if (lower.startsWith(EIP7702_PREFIX) && lower.length === 48) {
    const rawAddr = `0x${lower.slice(8)}`;
    if (isAddress(rawAddr)) {
      return {
        isDelegated: true,
        delegateAddress: getAddress(rawAddr),
        rawCode,
      };
    }
  }

  return {
    isDelegated: false,
    rawCode,
  };
}

async function verifyRpcChainId(pub: PublicClient, expectedChainId: number): Promise<void> {
  if (typeof (pub as Partial<PublicClient>).getChainId !== 'function') {
    return;
  }
  const actualChainId = await pub.getChainId();
  if (actualChainId !== expectedChainId) {
    throw new Error(
      `RPC chain ID mismatch: configured chainId=${expectedChainId}, but RPC returned eth_chainId=${actualChainId}`,
    );
  }
}

export async function checkRpcHealth(
  network: NetworkSettings,
  contract: ContractSettings,
  client?: PublicClient,
): Promise<RpcHealthResult> {
  const pub = client ?? getPublicClient(network);
  const start = performance.now();

  try {
    const [blockNumber, gasPrice, launchFee] = await Promise.all([
      pub.getBlockNumber(),
      pub.getGasPrice(),
      pub.readContract({
        address: contract.factoryAddress,
        abi: PONS_FACTORY_ABI,
        functionName: 'launchFee',
      }),
      verifyRpcChainId(pub, network.chainId),
    ]);

    return {
      ok: true,
      latencyMs: Math.round(performance.now() - start),
      blockNumber,
      gasPrice,
      launchFee,
      chainId: network.chainId,
      rpcUrl: network.rpcUrl,
    };
  } catch (err: unknown) {
    return {
      ok: false,
      latencyMs: Math.round(performance.now() - start),
      blockNumber: 0n,
      gasPrice: 0n,
      launchFee: 0n,
      chainId: network.chainId,
      rpcUrl: network.rpcUrl,
      error: extractBlockchainError(err),
    };
  }
}

export async function checkWalletsStatus(
  network: NetworkSettings,
  wallets: PartialDecryptedWallets,
  client?: PublicClient,
): Promise<WalletStatusResult> {
  const pub = client ?? getPublicClient(network);
  const sponsorAccount = wallets.sponsorPk ? privateKeyToAccount(wallets.sponsorPk) : undefined;
  const targetAccount = wallets.targetPk ? privateKeyToAccount(wallets.targetPk) : undefined;

  const [sponsorBalance, targetBalance, targetCode] = await Promise.all([
    sponsorAccount ? pub.getBalance({ address: sponsorAccount.address }) : Promise.resolve(undefined),
    targetAccount ? pub.getBalance({ address: targetAccount.address }) : Promise.resolve(undefined),
    targetAccount ? pub.getCode({ address: targetAccount.address }) : Promise.resolve(undefined),
  ]);

  return {
    ...(sponsorAccount ? { sponsorAddress: sponsorAccount.address, sponsorBalance } : {}),
    ...(targetAccount
      ? {
          targetAddress: targetAccount.address,
          targetBalance,
          targetDelegation: parseEip7702Delegation(targetCode),
        }
      : {}),
  };
}

export function buildTokenLaunchParams(
  tokenDraft: TokenDraft,
  feeSettings: FeeSettings,
  contractSettings: ContractSettings,
  targetAddress: Address,
  preparedSalt?: Hex,
): TokenLaunchParams {
  const name = tokenDraft.name.trim();
  const symbol = tokenDraft.symbol.trim();
  const logo = tokenDraft.logo.trim();
  const description = tokenDraft.description.trim();

  if (!name) {
    throw new Error('Token name is required');
  }
  if (!symbol) {
    throw new Error('Token symbol is required');
  }
  if (!logo) {
    throw new Error('Token logo URL is required');
  }

  const rawRecipient = feeSettings.creatorFeeRecipient.trim();
  if (!rawRecipient) {
    throw new Error(
      'Creator fee recipient wallet is mandatory and must be explicitly configured (no fallback to sponsor wallet)',
    );
  }
  if (!isAddress(rawRecipient)) {
    throw new Error(`Invalid creator fee recipient address: "${rawRecipient}"`);
  }

  const creatorFeeRecipient = getAddress(rawRecipient);
  if (creatorFeeRecipient.toLowerCase() === zeroAddress.toLowerCase()) {
    throw new Error('Creator fee recipient must not be the zero address');
  }
  if (creatorFeeRecipient.toLowerCase() === targetAddress.toLowerCase()) {
    throw new Error(
      'Creator fee recipient must not be the same as the Target (Creator) wallet',
    );
  }

  if (
    !Number.isInteger(feeSettings.creatorTaxBps) ||
    feeSettings.creatorTaxBps < 0 ||
    feeSettings.creatorTaxBps > 10_000
  ) {
    throw new Error('Creator tax bps must be an integer between 0 and 10000');
  }

  if (!BYTES32_REGEX.test(contractSettings.expectedEconomics)) {
    throw new Error('Contract expectedEconomics must be a valid 32-byte hex value');
  }

  let salt: Hex;
  const customSalt = tokenDraft.customSalt.trim();
  if (preparedSalt && BYTES32_REGEX.test(preparedSalt)) {
    salt = preparedSalt.toLowerCase() as Hex;
  } else if (customSalt.length > 0) {
    if (!BYTES32_REGEX.test(customSalt)) {
      throw new Error('Custom salt must be a valid bytes32 hex string (0x followed by 64 hex characters)');
    }
    salt = customSalt.toLowerCase() as Hex;
  } else {
    salt = `0x${randomBytes(32).toString('hex')}`;
  }

  return {
    name,
    symbol,
    logo,
    description,
    socials: {
      twitter: tokenDraft.socials.twitter.trim(),
      telegram: tokenDraft.socials.telegram.trim(),
      discord: tokenDraft.socials.discord.trim(),
      website: tokenDraft.socials.website.trim(),
      github: tokenDraft.socials.github.trim(),
    },
    creatorFeeRecipient,
    creatorTaxBps: feeSettings.creatorTaxBps,
    buybackEnabled: contractSettings.buybackEnabled,
    expectedEconomics: contractSettings.expectedEconomics,
    salt,
  };
}

interface PreparedPreflight {
  sponsor: ReturnType<typeof privateKeyToAccount>;
  target: ReturnType<typeof privateKeyToAccount>;
  params: TokenLaunchParams;
  launchConfigId: bigint;
  simulation: SimulationResult;
}

async function runPreflightSimulation(
  settings: UserSettings,
  wallets: PartialDecryptedWallets,
  tokenDraft: TokenDraft,
  pub: PublicClient,
  preparedSalt?: Hex,
  expectedLaunchFeeWei?: bigint,
): Promise<PreparedPreflight> {
  const startedAt = performance.now();

  if (!wallets.sponsorPk) {
    throw new Error('Sponsor wallet private key is not configured');
  }
  if (!wallets.targetPk) {
    throw new Error('Target wallet private key is not configured');
  }

  const sponsor = privateKeyToAccount(wallets.sponsorPk);
  const target = privateKeyToAccount(wallets.targetPk);

  if (sponsor.address.toLowerCase() === target.address.toLowerCase()) {
    throw new Error('Sponsor wallet and Target wallet must be two distinct addresses');
  }

  const params = buildTokenLaunchParams(
    tokenDraft,
    settings.fee,
    settings.contract,
    target.address,
    preparedSalt,
  );

  const fundWei = parseEther(settings.fee.fundAmountEth);
  const sponsorGasReserveWei = parseEther(settings.execution.sponsorGasReserveEth);
  const safetyBufferWei = parseEther(settings.execution.safetyBufferEth);
  const maxPriorityFee = BigInt(settings.execution.maxPriorityFeeWei);
  const revokeGasLimit = BigInt(settings.execution.revokeGasLimit);
  const fundGasLimit = BigInt(settings.execution.fundGasLimit);
  const launchConfigId = BigInt(settings.contract.launchConfigId);

  if (fundWei <= 0n) {
    throw new Error('Fund amount must be greater than 0 ETH');
  }

  const [fee, gasPrice, sponsorBalance, targetBalance, targetCode, targetNonce, sponsorNonce] =
    await Promise.all([
      pub.readContract({
        address: settings.contract.factoryAddress,
        abi: PONS_FACTORY_ABI,
        functionName: 'launchFee',
      }),
      pub.getGasPrice(),
      pub.getBalance({ address: sponsor.address }),
      pub.getBalance({ address: target.address }),
      pub.getCode({ address: target.address }),
      pub.getTransactionCount({ address: target.address, blockTag: 'pending' }),
      pub.getTransactionCount({ address: sponsor.address, blockTag: 'pending' }),
      verifyRpcChainId(pub, settings.network.chainId),
    ]);

  if (expectedLaunchFeeWei !== undefined && fee > expectedLaunchFeeWei) {
    throw new Error(
      `On-chain launchFee increased since confirmation (confirmed ${formatEther(expectedLaunchFeeWei)} ETH, current ${formatEther(fee)} ETH). Please re-simulate before launching.`,
    );
  }

  const computedMaxFee =
    (gasPrice * BigInt(settings.execution.gasPriceMultiplierBps)) / 10_000n;
  const maxFee = computedMaxFee < maxPriorityFee ? maxPriorityFee : computedMaxFee;

  // Verify Sponsor can cover fund transfer + worst-case upfront gas for Revoke + Fund + reserve
  const sponsorGasCostWei = (revokeGasLimit + fundGasLimit) * maxFee;
  const requiredSponsorWei = fundWei + sponsorGasCostWei + sponsorGasReserveWei;
  if (sponsorBalance < requiredSponsorWei) {
    throw new Error(
      `Insufficient Sponsor balance: have ${formatEther(sponsorBalance)} ETH, need at least ${formatEther(requiredSponsorWei)} ETH (fund ${formatEther(fundWei)} + sponsor gas ${formatEther(sponsorGasCostWei)} + reserve ${formatEther(sponsorGasReserveWei)})`,
    );
  }

  const stateOverride = [
    {
      address: target.address,
      balance: fundWei,
      code: '0x' as Hex,
    },
  ];

  const [simOutcome, estimatedGas] = await Promise.all([
    pub.simulateContract({
      address: settings.contract.factoryAddress,
      abi: PONS_FACTORY_ABI,
      functionName: 'launchToken',
      args: [params, launchConfigId, settings.contract.pairToken],
      account: target,
      value: fee,
      stateOverride,
    }),
    pub.estimateContractGas({
      address: settings.contract.factoryAddress,
      abi: PONS_FACTORY_ABI,
      functionName: 'launchToken',
      args: [params, launchConfigId, settings.contract.pairToken],
      account: target,
      value: fee,
      stateOverride,
    }),
  ]);

  const [predictedToken, predictedCurve] = simOutcome.result;

  const gasLimit =
    (estimatedGas * BigInt(settings.execution.gasLimitMultiplierBps)) / 10_000n;
  const needed = fee + gasLimit * maxFee;
  const minFundRequired = needed + safetyBufferWei;

  if (fundWei < minFundRequired) {
    throw new Error(
      `Fund amount too low for launch + gas + safety buffer: fund is ${formatEther(fundWei)} ETH, required minimum is ${formatEther(minFundRequired)} ETH (launch+gas ${formatEther(needed)} + buffer ${formatEther(safetyBufferWei)})`,
    );
  }

  const targetDelegation = parseEip7702Delegation(targetCode);

  const simulation: SimulationResult = {
    predictedToken: getAddress(predictedToken),
    predictedCurve: getAddress(predictedCurve),
    fee,
    gas: estimatedGas,
    gasLimit,
    gasPrice,
    maxFee,
    maxPriorityFee,
    needed,
    fundWei,
    safetyBufferWei,
    sponsorGasReserveWei,
    sponsorAddress: sponsor.address,
    sponsorBalance,
    targetAddress: target.address,
    targetBalance,
    targetDelegation,
    targetNonce,
    sponsorNonce,
    creator: target.address,
    creatorFeeRecipient: params.creatorFeeRecipient,
    creatorTaxBps: params.creatorTaxBps,
    salt: params.salt,
    durationMs: Math.round(performance.now() - startedAt),
  };

  return {
    sponsor,
    target,
    params,
    launchConfigId,
    simulation,
  };
}

export async function simulateLaunch(
  settings: UserSettings,
  wallets: PartialDecryptedWallets,
  tokenDraft: TokenDraft,
  client?: PublicClient,
  preparedSalt?: Hex,
): Promise<SimulationResult> {
  const pub = client ?? getPublicClient(settings.network);
  const preflight = await runPreflightSimulation(
    settings,
    wallets,
    tokenDraft,
    pub,
    preparedSalt,
  );
  return preflight.simulation;
}

function assertNotAbortedOrRevoked(options?: ExecuteLaunchOptions): void {
  if (options?.signal?.aborted) {
    throw new Error('Launch aborted before broadcast');
  }
  if (options?.checkAuthorized && !options.checkAuthorized()) {
    throw new Error('User authorization was revoked before broadcast');
  }
}

export async function executeLaunch(
  settings: UserSettings,
  wallets: PartialDecryptedWallets,
  tokenDraft: TokenDraft,
  hooks?: LaunchHooks,
  client?: PublicClient,
  options?: ExecuteLaunchOptions,
): Promise<LaunchResult> {
  const totalStart = performance.now();
  const pub = client ?? getPublicClient(settings.network);
  const burstPub = options?.burstClient ?? client ?? getBurstPublicClient(settings.network);

  assertNotAbortedOrRevoked(options);

  // Step 1: Fresh pre-flight & simulation
  const { sponsor, target, params, launchConfigId, simulation } = await runPreflightSimulation(
    settings,
    wallets,
    tokenDraft,
    pub,
    options?.preparedSalt,
    options?.expectedLaunchFeeWei,
  );

  assertNotAbortedOrRevoked(options);

  const {
    chainId,
    explorerUrl,
  } = settings.network;
  const {
    fee,
    gasLimit,
    maxFee,
    maxPriorityFee,
    fundWei,
    targetNonce: n0,
    sponsorNonce: sn0,
    predictedToken,
    predictedCurve,
  } = simulation;

  const revokeGasLimit = BigInt(settings.execution.revokeGasLimit);
  const fundGasLimit = BigInt(settings.execution.fundGasLimit);

  // Step 2: Local pre-signing of ALL 3 transactions before broadcasting any transaction
  const launchData = encodeFunctionData({
    abi: PONS_FACTORY_ABI,
    functionName: 'launchToken',
    args: [params, launchConfigId, settings.contract.pairToken],
  });

  const signedLaunch = await target.signTransaction({
    type: 'eip1559',
    chainId,
    nonce: n0 + 1,
    to: settings.contract.factoryAddress,
    data: launchData,
    value: fee,
    gas: gasLimit,
    maxFeePerGas: maxFee,
    maxPriorityFeePerGas: maxPriorityFee,
  });

  const signedFund = await sponsor.signTransaction({
    type: 'eip1559',
    chainId,
    nonce: sn0 + 1,
    to: target.address,
    value: fundWei,
    gas: fundGasLimit,
    maxFeePerGas: maxFee,
    maxPriorityFeePerGas: maxPriorityFee,
  });

  const authorization = await target.signAuthorization({
    chainId,
    contractAddress: zeroAddress,
    nonce: n0,
  });

  const signedRevoke = await sponsor.signTransaction({
    type: 'eip7702',
    chainId,
    nonce: sn0,
    to: target.address,
    value: 0n,
    data: '0x',
    authorizationList: [authorization],
    gas: revokeGasLimit,
    maxFeePerGas: maxFee,
    maxPriorityFeePerGas: maxPriorityFee,
  });

  assertNotAbortedOrRevoked(options);

  // Step 3: HOT PATH (ZERO Telegram await blocking)
  const revokeHash = await pub.sendRawTransaction({
    serializedTransaction: signedRevoke,
  });

  // Notify caller asynchronously on next microtask; catch both sync and async hook errors
  if (hooks?.onRevokeSent) {
    const onRevokeSent = hooks.onRevokeSent;
    void Promise.resolve()
      .then(() => onRevokeSent(revokeHash))
      .catch(() => undefined);
  }

  const t0 = performance.now();

  const fundP = pub
    .sendRawTransaction({ serializedTransaction: signedFund })
    .then((hash) => ({ ok: true as const, hash }))
    .catch((err: unknown) => ({ ok: false as const, error: extractBlockchainError(err) }));

  const expectedLaunchHash = keccak256(signedLaunch);
  let launchHash: Hex | undefined;
  let lastBurstError: string | undefined;
  let attempts = 0;
  let activeInFlight = 0;
  const maxRetries = Math.max(1, settings.execution.launchRetries);
  const retryIntervalMs = Math.max(0, settings.execution.launchRetryIntervalMs);
  const inFlightAttempts: Promise<void>[] = [];

  const attemptLaunchBroadcast = (): void => {
    attempts += 1;
    activeInFlight += 1;
    const p = burstPub
      .sendRawTransaction({ serializedTransaction: signedLaunch })
      .then((hash) => {
        if (!launchHash) {
          launchHash = hash;
        }
      })
      .catch((err: unknown) => {
        if (isAlreadyKnownError(err)) {
          if (!launchHash) {
            launchHash = expectedLaunchHash;
          }
          return;
        }
        lastBurstError = extractBlockchainError(err);
      })
      .finally(() => {
        activeInFlight = Math.max(0, activeInFlight - 1);
      });
    inFlightAttempts.push(p);
  };

  for (let i = 0; i < maxRetries && !launchHash; i += 1) {
    if (performance.now() - t0 >= MAX_BURST_WALL_MS) {
      break;
    }
    if (activeInFlight < MAX_BURST_INFLIGHT) {
      attemptLaunchBroadcast();
    }
    if (!launchHash && retryIntervalMs > 0) {
      await sleep(retryIntervalMs);
    }
  }

  if (!launchHash && inFlightAttempts.length > 0) {
    await Promise.race([Promise.allSettled(inFlightAttempts), sleep(POST_LOOP_SETTLE_MS)]);
  }

  // Fallback mempool/on-chain check to avoid false failure if an attempt succeeded after HTTP drop
  if (!launchHash && typeof (pub as Partial<PublicClient>).getTransaction === 'function') {
    const existingTx = await pub
      .getTransaction({ hash: expectedLaunchHash })
      .catch(() => undefined);
    if (existingTx) {
      launchHash = expectedLaunchHash;
    }
  }

  const fundOutcome = await fundP;
  const broadcastDurationMs = Math.round(performance.now() - t0);

  if (!launchHash) {
    throw new Error(
      `Launch transaction broadcast failed after ${attempts} attempts (revokeTx=${revokeHash}, fund=${fundOutcome.ok ? fundOutcome.hash : `failed: ${fundOutcome.error}`}): ${lastBurstError ?? 'no transaction hash received'}`,
    );
  }

  if (hooks?.onBroadcastComplete) {
    const onBroadcastComplete = hooks.onBroadcastComplete;
    await Promise.resolve()
      .then(() =>
        onBroadcastComplete({
          revokeHash,
          ...(fundOutcome.ok ? { fundHash: fundOutcome.hash } : { fundError: fundOutcome.error }),
          launchHash: launchHash!,
          attempts,
          broadcastDurationMs,
        }),
      )
      .catch(() => undefined);
  }

  // Step 4: Wait for on-chain receipt and check residual balance
  const receipt = await pub.waitForTransactionReceipt({
    hash: launchHash,
    pollingInterval: settings.execution.receiptPollingMs,
    timeout: settings.execution.receiptTimeoutMs,
  });

  const postTargetBalance = await pub
    .getBalance({ address: target.address })
    .catch(() => 0n);

  const status = receipt.status === 'success' ? 'success' : 'reverted';

  return {
    success: status === 'success',
    status,
    predictedToken,
    predictedCurve,
    revokeHash,
    ...(fundOutcome.ok ? { fundHash: fundOutcome.hash } : { fundError: fundOutcome.error }),
    launchHash,
    blockNumber: receipt.blockNumber,
    gasUsed: receipt.gasUsed,
    ...(receipt.effectiveGasPrice !== undefined
      ? { effectiveGasPrice: receipt.effectiveGasPrice }
      : {}),
    creator: target.address,
    creatorFeeRecipient: params.creatorFeeRecipient,
    creatorTaxBps: params.creatorTaxBps,
    salt: params.salt,
    launchFee: fee,
    fundWei,
    postTargetBalance,
    attempts,
    broadcastDurationMs,
    totalDurationMs: Math.round(performance.now() - totalStart),
    explorerUrl,
  };
}
