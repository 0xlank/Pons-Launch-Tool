import type { Address, Hex } from 'viem';

export interface NetworkSettings {
  rpcUrl: string;
  chainId: number;
  chainName: string;
  explorerUrl: string;
}

export interface ContractSettings {
  factoryAddress: Address;
  launchConfigId: string;
  pairToken: Address;
  buybackEnabled: boolean;
  expectedEconomics: Hex;
}

export interface FeeSettings {
  fundAmountEth: string;
  creatorFeeRecipient: string;
  creatorTaxBps: number;
}

export interface ExecutionSettings {
  gasPriceMultiplierBps: number;
  gasLimitMultiplierBps: number;
  maxPriorityFeeWei: string;
  revokeGasLimit: string;
  fundGasLimit: string;
  sponsorGasReserveEth: string;
  safetyBufferEth: string;
  launchRetries: number;
  launchRetryIntervalMs: number;
  receiptPollingMs: number;
  receiptTimeoutMs: number;
}

export interface IpfsSettings {
  pinataGateway: string;
  pinataJwtEnc?: string;
}

export interface UserSettings {
  network: NetworkSettings;
  contract: ContractSettings;
  fee: FeeSettings;
  execution: ExecutionSettings;
  ipfs: IpfsSettings;
}

export interface EncryptedWalletBundle {
  sponsorPkEnc?: string;
  targetPkEnc?: string;
}

export interface DecryptedWallets {
  sponsorPk: Hex;
  targetPk: Hex;
}

export interface PartialDecryptedWallets {
  sponsorPk?: Hex;
  targetPk?: Hex;
}

export interface TokenSocials {
  twitter: string;
  telegram: string;
  discord: string;
  website: string;
  github: string;
}

export interface TokenDraft {
  name: string;
  symbol: string;
  logo: string;
  description: string;
  socials: TokenSocials;
  customSalt: string;
}

export interface TokenPreset {
  id: string;
  label: string;
  createdAt: string;
  updatedAt: string;
  draft: TokenDraft;
}

export interface AuthorizedUserEntry {
  userId: number;
  label?: string;
  addedBy: number;
  addedAt: string;
}

export interface UserProfile {
  userId: number;
  createdAt: string;
  updatedAt: string;
  settings: UserSettings;
  wallets: EncryptedWalletBundle;
  tokenDraft: TokenDraft;
  presets: TokenPreset[];
}

export interface BotStoreData {
  version: 1;
  authorizedUsers: AuthorizedUserEntry[];
  users: Record<string, UserProfile>;
}

export interface Eip7702DelegationInfo {
  isDelegated: boolean;
  delegateAddress?: Address;
  rawCode: Hex;
}

export interface RpcHealthResult {
  ok: boolean;
  latencyMs: number;
  blockNumber: bigint;
  gasPrice: bigint;
  launchFee: bigint;
  chainId: number;
  rpcUrl: string;
  error?: string;
}

export interface WalletStatusResult {
  sponsorAddress?: Address;
  sponsorBalance?: bigint;
  targetAddress?: Address;
  targetBalance?: bigint;
  targetDelegation?: Eip7702DelegationInfo;
}

export interface SimulationResult {
  predictedToken: Address;
  predictedCurve: Address;
  fee: bigint;
  gas: bigint;
  gasLimit: bigint;
  gasPrice: bigint;
  maxFee: bigint;
  maxPriorityFee: bigint;
  needed: bigint;
  fundWei: bigint;
  safetyBufferWei: bigint;
  sponsorGasReserveWei: bigint;
  sponsorAddress: Address;
  sponsorBalance: bigint;
  targetAddress: Address;
  targetBalance: bigint;
  targetDelegation: Eip7702DelegationInfo;
  targetNonce: number;
  sponsorNonce: number;
  creator: Address;
  creatorFeeRecipient: Address;
  creatorTaxBps: number;
  salt: Hex;
  durationMs: number;
}

export interface LaunchBroadcastSummary {
  revokeHash: Hex;
  fundHash?: Hex;
  fundError?: string;
  launchHash: Hex;
  attempts: number;
  broadcastDurationMs: number;
}

export interface LaunchHooks {
  onRevokeSent?: (revokeHash: Hex) => void | Promise<void>;
  onBroadcastComplete?: (summary: LaunchBroadcastSummary) => void | Promise<void>;
}

export interface LaunchResult {
  success: boolean;
  status: 'success' | 'reverted';
  predictedToken: Address;
  predictedCurve: Address;
  revokeHash: Hex;
  fundHash?: Hex;
  fundError?: string;
  launchHash: Hex;
  blockNumber: bigint;
  gasUsed: bigint;
  effectiveGasPrice?: bigint;
  creator: Address;
  creatorFeeRecipient: Address;
  creatorTaxBps: number;
  salt: Hex;
  launchFee: bigint;
  fundWei: bigint;
  postTargetBalance: bigint;
  attempts: number;
  broadcastDurationMs: number;
  totalDurationMs: number;
  explorerUrl: string;
}

export interface EnvBootstrapDefaults {
  rpcUrl?: string;
  chainId?: number;
  chainName?: string;
  explorerUrl?: string;
  pinataGateway?: string;
}
