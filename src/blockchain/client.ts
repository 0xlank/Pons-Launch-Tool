import { createPublicClient, defineChain, http, type Chain, type PublicClient } from 'viem';
import type { NetworkSettings } from '../types/domain.js';

const MAX_CACHE_ENTRIES = 32;
const publicClientCache = new Map<string, PublicClient>();
const burstClientCache = new Map<string, PublicClient>();

export function buildClientCacheKey(network: NetworkSettings): string {
  return `${network.chainId}:${network.rpcUrl}:${network.chainName}:${network.explorerUrl}`;
}

export function buildViemChain(network: NetworkSettings): Chain {
  return defineChain({
    id: network.chainId,
    name: network.chainName,
    nativeCurrency: {
      name: 'Ether',
      symbol: 'ETH',
      decimals: 18,
    },
    rpcUrls: {
      default: {
        http: [network.rpcUrl],
      },
    },
    blockExplorers: {
      default: {
        name: `${network.chainName} Explorer`,
        url: network.explorerUrl,
      },
    },
  });
}

function setBounded(cache: Map<string, PublicClient>, key: string, client: PublicClient): void {
  if (cache.size >= MAX_CACHE_ENTRIES && !cache.has(key)) {
    const oldestKey = cache.keys().next().value;
    if (oldestKey !== undefined) {
      cache.delete(oldestKey);
    }
  }
  cache.set(key, client);
}

export function getPublicClient(network: NetworkSettings): PublicClient {
  const key = buildClientCacheKey(network);
  const cached = publicClientCache.get(key);
  if (cached) {
    return cached;
  }

  const chain = buildViemChain(network);
  const client = createPublicClient({
    chain,
    transport: http(network.rpcUrl, {
      retryCount: 2,
      timeout: 20_000,
    }),
  });

  setBounded(publicClientCache, key, client);
  return client;
}

/**
 * Dedicated client with retryCount: 0 for high-frequency burst raw TX broadcasts
 * so each burst iteration emits exactly 1 RPC request without multiplying load 3x.
 */
export function getBurstPublicClient(network: NetworkSettings): PublicClient {
  const key = buildClientCacheKey(network);
  const cached = burstClientCache.get(key);
  if (cached) {
    return cached;
  }

  const chain = buildViemChain(network);
  const client = createPublicClient({
    chain,
    transport: http(network.rpcUrl, {
      retryCount: 0,
      timeout: 5_000,
    }),
  });

  setBounded(burstClientCache, key, client);
  return client;
}

export function evictPublicClient(network: NetworkSettings): void {
  const key = buildClientCacheKey(network);
  publicClientCache.delete(key);
  burstClientCache.delete(key);
}

export function clearPublicClientCache(): void {
  publicClientCache.clear();
  burstClientCache.clear();
}
