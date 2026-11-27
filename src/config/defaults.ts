import type { Address, Hex } from 'viem';
import type {
  ContractSettings,
  EnvBootstrapDefaults,
  ExecutionSettings,
  FeeSettings,
  IpfsSettings,
  NetworkSettings,
  TokenDraft,
  TokenSocials,
  UserSettings,
} from '../types/domain.js';

export const DEFAULT_RPC_URL = 'https://rpc.mainnet.chain.robinhood.com';
export const DEFAULT_CHAIN_ID = 4663;
export const DEFAULT_CHAIN_NAME = 'Robinhood';
export const DEFAULT_EXPLORER_URL = 'https://robin.etherscan.io';

export const DEFAULT_FACTORY_ADDRESS: Address = '0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e';
export const DEFAULT_LAUNCH_CONFIG_ID = '0';
export const DEFAULT_PAIR_TOKEN: Address = '0x0000000000000000000000000000000000000000';
export const DEFAULT_BUYBACK_ENABLED = false;
export const DEFAULT_EXPECTED_ECONOMICS: Hex = `0x${'00'.repeat(32)}`;

export const DEFAULT_FUND_AMOUNT_ETH = '0.001';
export const DEFAULT_CREATOR_FEE_RECIPIENT = '';
export const DEFAULT_CREATOR_TAX_BPS = 300;

export const DEFAULT_GAS_PRICE_MULTIPLIER_BPS = 15000;
export const DEFAULT_GAS_LIMIT_MULTIPLIER_BPS = 12000;
export const DEFAULT_MAX_PRIORITY_FEE_WEI = '1';
export const DEFAULT_REVOKE_GAS_LIMIT = '300000';
export const DEFAULT_FUND_GAS_LIMIT = '100000';
export const DEFAULT_SPONSOR_GAS_RESERVE_ETH = '0.0001';
export const DEFAULT_SAFETY_BUFFER_ETH = '0.00005';
export const DEFAULT_LAUNCH_RETRIES = 400;
export const DEFAULT_LAUNCH_RETRY_INTERVAL_MS = 10;
export const DEFAULT_RECEIPT_POLLING_MS = 100;
export const DEFAULT_RECEIPT_TIMEOUT_MS = 60000;

export const DEFAULT_PINATA_GATEWAY = 'https://gateway.pinata.cloud/ipfs';

export function createDefaultNetworkSettings(overrides?: EnvBootstrapDefaults): NetworkSettings {
  return {
    rpcUrl: overrides?.rpcUrl ?? DEFAULT_RPC_URL,
    chainId: overrides?.chainId ?? DEFAULT_CHAIN_ID,
    chainName: overrides?.chainName ?? DEFAULT_CHAIN_NAME,
    explorerUrl: overrides?.explorerUrl ?? DEFAULT_EXPLORER_URL,
  };
}

export function createDefaultContractSettings(): ContractSettings {
  return {
    factoryAddress: DEFAULT_FACTORY_ADDRESS,
    launchConfigId: DEFAULT_LAUNCH_CONFIG_ID,
    pairToken: DEFAULT_PAIR_TOKEN,
    buybackEnabled: DEFAULT_BUYBACK_ENABLED,
    expectedEconomics: DEFAULT_EXPECTED_ECONOMICS,
  };
}

export function createDefaultFeeSettings(): FeeSettings {
  return {
    fundAmountEth: DEFAULT_FUND_AMOUNT_ETH,
    creatorFeeRecipient: DEFAULT_CREATOR_FEE_RECIPIENT,
    creatorTaxBps: DEFAULT_CREATOR_TAX_BPS,
  };
}

export function createDefaultExecutionSettings(): ExecutionSettings {
  return {
    gasPriceMultiplierBps: DEFAULT_GAS_PRICE_MULTIPLIER_BPS,
    gasLimitMultiplierBps: DEFAULT_GAS_LIMIT_MULTIPLIER_BPS,
    maxPriorityFeeWei: DEFAULT_MAX_PRIORITY_FEE_WEI,
    revokeGasLimit: DEFAULT_REVOKE_GAS_LIMIT,
    fundGasLimit: DEFAULT_FUND_GAS_LIMIT,
    sponsorGasReserveEth: DEFAULT_SPONSOR_GAS_RESERVE_ETH,
    safetyBufferEth: DEFAULT_SAFETY_BUFFER_ETH,
    launchRetries: DEFAULT_LAUNCH_RETRIES,
    launchRetryIntervalMs: DEFAULT_LAUNCH_RETRY_INTERVAL_MS,
    receiptPollingMs: DEFAULT_RECEIPT_POLLING_MS,
    receiptTimeoutMs: DEFAULT_RECEIPT_TIMEOUT_MS,
  };
}

export function createDefaultIpfsSettings(overrides?: EnvBootstrapDefaults): IpfsSettings {
  return {
    pinataGateway: overrides?.pinataGateway ?? DEFAULT_PINATA_GATEWAY,
  };
}

export function createDefaultUserSettings(overrides?: EnvBootstrapDefaults): UserSettings {
  return {
    network: createDefaultNetworkSettings(overrides),
    contract: createDefaultContractSettings(),
    fee: createDefaultFeeSettings(),
    execution: createDefaultExecutionSettings(),
    ipfs: createDefaultIpfsSettings(overrides),
  };
}

export function createEmptyTokenSocials(): TokenSocials {
  return {
    twitter: '',
    telegram: '',
    discord: '',
    website: '',
    github: '',
  };
}

export function createEmptyTokenDraft(): TokenDraft {
  return {
    name: '',
    symbol: '',
    logo: '',
    description: '',
    socials: createEmptyTokenSocials(),
    customSalt: '',
  };
}
