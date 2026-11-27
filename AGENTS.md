# AGENTS.md — Pons Launch Tool

*Project context for autonomous agents (Hermes Agent, coding agents, and operators). All timestamps and logs operate strictly in **UTC**.*

## Overview

**Pons Launch Tool** is a production TypeScript Telegram bot (`Node.js >= 20`, ESM, `grammY` + `viem` + `zod`) for launching tokens on the **Pons V2 Factory** (`0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e`, default on **Robinhood Chain Mainnet**, chain ID `4663`) using an atomic, locally pre-signed **2-Wallet EIP-7702 Auto-Revoke + Fund + Burst Launch** race engine, Pinata IPFS logo uploads, and an AES-256-GCM encrypted shared workspace (`data/store.json`).

**HIGH-SENSITIVITY PRODUCTION SYSTEM**: This bot stores encrypted Sponsor and Target EVM private keys and executes irreversible on-chain token launches and ETH funding transfers. Treat all restarts, storage operations, and config edits with maximum caution.

## Architecture & Module Map

- **Entrypoint (`src/index.ts`)**:
  - Loads and validates `.env` via `loadEnv()`, initializes `BotStore` (`data/store.json`), registers grammY auth middleware (strict private-chat + allowlist gate), clears stale `pendingInput` on callback navigation, registers modular handlers, auto-deletes stray Private Keys / JWTs sent outside active input sessions, redacts bot tokens in error logs, and handles graceful `SIGINT`/`SIGTERM` shutdown.
- **Configuration (`src/config/`)**:
  - `env.ts`: Zod validation requiring `BOT_TOKEN`, `OWNER_TELEGRAM_IDS`, and strong `ENCRYPTION_KEY` (64-hex or `>= 16` char high-entropy passphrase; rejects placeholders and weak strings). Optional HTTPS-only bootstrap defaults (`RPC_URL`, `CHAIN_ID`, `CHAIN_NAME`, `EXPLORER_URL`, `PINATA_GATEWAY`).
  - `defaults.ts`: Defaults for Robinhood Mainnet (`4663`, `https://rpc.mainnet.chain.robinhood.com`, `https://robin.etherscan.io`), Pons V2 Factory address, `fundAmountEth: 0.001`, `creatorTaxBps: 300`, `launchRetries: 400`, `launchRetryIntervalMs: 10`, `receiptPollingMs: 100`, `receiptTimeoutMs: 60000`.
- **Blockchain Race Engine (`src/blockchain/`)**:
  - `launcher.ts`:
    - `checkRpcHealth()`: Verifies `getBlockNumber`, `getGasPrice`, `launchFee()`, and `eth_chainId` against configured `chainId`.
    - `parseEip7702Delegation()`: Inspects Target bytecode for EIP-7702 `0xef0100` + 20-byte delegate prefix.
    - `runPreflightSimulation()` / `simulateLaunch()`: Parallel pre-flight fetching `launchFee`, gas price, balances, bytecode, and pending nonces (`n0` Target, `sn0` Sponsor); simulates `launchToken` using state overrides (`balance = fundWei`, `code = "0x"`) to predict token & bonding curve addresses.
    - `executeLaunch()`: Pre-signs 3 transactions locally before any broadcast:
      1. `signedRevoke` (Type `0x04` EIP-7702, Sponsor nonce `sn0`, Target auth nonce `n0` -> `zeroAddress`)
      2. `signedFund` (Type `0x02` EIP-1559, Sponsor nonce `sn0 + 1` -> Target `fundWei`)
      3. `signedLaunch` (Type `0x02` EIP-1559, Target nonce `n0 + 1` -> Factory `launchToken` with `value = launchFee`)
      Broadcasts `signedRevoke`, fires `signedFund` concurrently with a bounded burst loop (`MAX_BURST_INFLIGHT = 10`, `MAX_BURST_WALL_MS = 15_000`) sending `signedLaunch` until accepted or `already known`, checks mempool fallback via `getTransaction(expectedLaunchHash)`, and waits for receipt.
  - `client.ts`, `abi.ts`: Standard & low-latency burst `viem` `PublicClient` builders and `PONS_FACTORY_ABI`.
- **Encrypted Shared Storage (`src/storage/`)**:
  - `crypto.ts`: AES-256-GCM (`v1:<ivHex>:<tagHex>:<cipherHex>`) with 12-byte IV, 16-byte tag, raw 32-byte key (if 64-hex) or `scryptSync` (`N=65536`, domain salt `pons-launch-tool:aes-256-gcm:v1`).
  - `store.ts`: `BotStore` persists `data/store.json` using serialized `writeQueue` + atomic temp-file/rename writes. All authorized users share `users.shared` with per-field GCM AAD binding (`v1:shared:<field>` for `sponsorPk`, `targetPk`, `pinataJwt`). Auto-migrates legacy per-user profiles on startup.
- **Media & Telegram Handlers (`src/services/pinata.ts`, `src/bot/`)**:
  - `pinata.ts`: Magic-byte image sniffer (`sniffImageMime` allowing only PNG/JPEG/GIF/WebP up to 10 MB; rejects spoofed HTML/SVG/JS), `testPinataAuth`, `uploadImageBufferToPinata`.
  - `bot/handlers/`: `auth.ts` (private-chat + allowlist), `access.ts` (immutable Root Owner-only user management), `launch.ts` (enforces non-empty explicit `creatorFeeRecipient != zeroAddress && != targetAddress`, workspace-wide launch lock), `wallets.ts`, `token.ts`, `settings.ts`, `menu.ts`.

## Runtime & Deployment

- Build & start: `npm run build` (`tsc` -> `dist/index.js`) then `npm start` (`node dist/index.js`).
- Commonly supervised on VPS via `systemd`, `pm2`, or `tmux`/`screen` (verify active supervisor on host).
- No HTTP port is opened; the bot operates exclusively over outbound HTTPS Telegram long-polling and outbound RPC/Pinata HTTPS calls.

## Safe Operational Commands

```bash
# Build, typecheck, and test (safe non-broadcast verification)
npm run typecheck
npm run build
npm test

# Inspect runtime logs (adapt to actual VPS supervisor: systemd / pm2 / docker)
# systemctl status pons-launch-tool   OR   pm2 logs pons-launch-tool --lines 100
```

## Critical Invariants & Failure Modes

1. **Single Polling Instance**: Running two processes with the same `BOT_TOKEN` causes Telegram `409 Conflict` polling loops.
2. **Changing `ENCRYPTION_KEY` Breaks Decryption**: `data/store.json` secrets (`sponsorPkEnc`, `targetPkEnc`, `pinataJwtEnc`) are GCM-authenticated with `ENCRYPTION_KEY` + field AAD (`v1:shared:<field>`). Never rotate `ENCRYPTION_KEY` without re-encrypting or resetting stored secrets, and never edit `data/store.json` manually.
3. **Mandatory Explicit `creatorFeeRecipient`**: Launches fail pre-flight if `creatorFeeRecipient` is empty, `0x000...000`, or equal to the Target wallet address (intentional anti-sweeper protection).
4. **RPC Chain ID Mismatch**: `verifyRpcChainId` aborts health checks and launches if `eth_chainId` differs from configured `settings.network.chainId`.
5. **Partial Broadcast / Burst Failure**: If `executeLaunch` fails after broadcasting `signedRevoke` or `signedFund`, **do NOT blindly re-run**—inspect the logged `revokeTx`, `fund` hash, Sponsor/Target nonces, and Target EIP-7702 delegation status on the block explorer first.
6. **In-Memory Session & Launch Lock**: Pending inputs and active launch locks live in memory (`SessionManager`). Restarting the bot mid-launch can interrupt receipt tracking even though transactions are already broadcast on-chain.

## Agent Safety Rules

- **NEVER** read, print, log, copy, or transmit `.env`, `BOT_TOKEN`, `ENCRYPTION_KEY`, or `data/store.json` (contains encrypted keys and operational settings).
- **NEVER** restart the process while a token launch is in progress; always inspect recent logs and ask explicit human confirmation before restarting, editing `.env`, or modifying `data/store.json`.
- **NEVER** commit `.env`, `data/store.json`, or backup archives to Git.
