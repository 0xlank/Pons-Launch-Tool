# Pons Launch Tool

A production TypeScript Telegram bot for launching tokens on the **Pons V2 Factory** using an atomic, pre-signed **2-Wallet EIP-7702 Auto-Revoke + Fund + Burst Launch** execution flow.

## Features

- **2-Wallet EIP-7702 Auto-Revoke Race Engine**: Pre-signs all three transactions locally (EIP-7702 zero-address delegation revoke, Sponsor-to-Target funding, and Target `launchToken` call) before broadcasting a low-latency burst to outrun sweepers and delegation hijackers.
- **Mandatory Explicit Creator Fee Recipient**: Creator fees are strictly routed to an explicitly configured EVM address (`creatorFeeRecipient`) that must never be empty, the zero address, or the compromised Target wallet.
- **Pre-Flight Simulation**: Runs `simulateContract` and `estimateContractGas` using state overrides (`balance` + clean `code: "0x"`) to verify gas requirements, exact funding coverage, and predicted token/curve addresses before spending gas.
- **Encrypted Persistent Storage**: Stores Sponsor private keys, Target private keys, and Pinata JWTs using authenticated **AES-256-GCM** encryption in an atomic JSON store (`data/store.json`) with serialized write locking.
- **Pinata IPFS Media Upload**: Directly upload token logos from Telegram photos or image documents to Pinata IPFS, including single-message Quick Paste with image caption support.
- **Owner-Only Dynamic Access Control & Shared Workspace**: Immutable Root Owners configured via `OWNER_TELEGRAM_IDS` can authorize or revoke other Telegram users dynamically via inline buttons. All authorized users share a single synchronized workspace (wallets, Pinata JWT, settings, token draft, and presets) protected by a workspace-wide launch lock, while access management stays strictly Owner-only.
- **Scoped Launch Data Reset**: One-click reset clears sensitive launch credentials, creator fee recipient, and active token draft fields while preserving network, factory, gas tuning, Pinata credentials, presets, and access control lists.

## Prerequisites

- **Node.js** `>= 20.0.0` (LTS recommended)
- **npm** `>= 10.0.0`
- A Telegram Bot token from `@BotFather`
- A funded Sponsor EVM wallet on the target chain and a Target (Creator) EVM wallet

## Environment Setup

1. Copy the template environment file:

   ```bash
   cp .env.example .env
   ```

2. Configure the required variables in `.env`:

   | Variable | Required | Description |
   | --- | --- | --- |
   | `BOT_TOKEN` | Yes | Telegram bot token from `@BotFather`. |
   | `OWNER_TELEGRAM_IDS` | Yes | Comma-separated numeric Telegram user IDs of immutable Root Owners. |
   | `ALLOWED_TELEGRAM_IDS` | No | Comma-separated initial authorized non-owner Telegram user IDs. |
   | `ENCRYPTION_KEY` | Yes | 64-character hex string (32 bytes) or strong passphrase (`>= 16` chars) used for AES-256-GCM encryption. |
   | `RPC_URL` | No | Optional bootstrap default RPC endpoint (defaults to `https://rpc.mainnet.chain.robinhood.com`). |
   | `CHAIN_ID` | No | Optional bootstrap default chain ID (defaults to `4663`). |
   | `CHAIN_NAME` | No | Optional bootstrap default chain name (defaults to `Robinhood`). |
   | `EXPLORER_URL` | No | Optional bootstrap default block explorer URL (defaults to `https://robin.etherscan.io`). |
   | `PINATA_GATEWAY` | No | Optional bootstrap default IPFS gateway base URL (defaults to `https://gateway.pinata.cloud/ipfs`). |

### Obtaining a Bot Token & Telegram User ID

1. **Bot Token**: Message `@BotFather` on Telegram, run `/newbot`, follow the prompts, and copy the resulting HTTP API token into `BOT_TOKEN`.
2. **Telegram User ID**: Message `@userinfobot` (or `@RawDataBot`) on Telegram to retrieve your numeric user ID, then place it in `OWNER_TELEGRAM_IDS`.

### Generating an Encryption Key

Generate a cryptographically random 256-bit hex key:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

## Security & Encryption Model

- **AES-256-GCM**: All secrets (`sponsorPkEnc`, `targetPkEnc`, `pinataJwtEnc`) are encrypted using Node.js `crypto` with a fresh 12-byte random IV and a 16-byte authentication tag, persisted as `v1:<ivHex>:<tagHex>:<cipherHex>`.
- **Key Derivation**: If `ENCRYPTION_KEY` is a 64-character hex string, its raw 32 bytes are used directly. Otherwise, a 32-byte key is derived deterministically via `scryptSync` with an application-specific domain salt.
- **Chat Hygiene**: Messages containing private keys or Pinata JWTs are immediately deleted from the Telegram chat after ingestion.
- **Shared Workspace with Field-Bound AAD**: All authorized users share a single encrypted workspace profile (`users.shared`) in `data/store.json` with per-field GCM AAD binding (`v1:shared:<field>`), automatically migrating legacy per-user profiles on startup without losing stored credentials. A workspace-wide launch lock prevents concurrent cross-user launches on the shared wallets.

## 2-Wallet EIP-7702 Auto-Revoke Race Flow

When executing a launch, the engine performs all verification and signing locally before touching the network:

1. **Pre-Flight & State-Override Simulation**: Fetches `launchFee()`, `gasPrice`, balances, Target bytecode (checking for EIP-7702 `0xef0100...` delegation), and pending nonces (`n0` for Target, `sn0` for Sponsor) in parallel. Simulates `launchToken` with Target overridden to clean bytecode (`0x`) and `fundWei` balance.
2. **Local Pre-Signing (3 Transactions)**:
   - `signedRevoke` (Type `0x04` EIP-7702, Sponsor nonce `sn0`): Authorizes `0x0000...0000` on Target (Target nonce `n0`) to clear any EIP-7702 delegation.
   - `signedFund` (Type `0x02` EIP-1559, Sponsor nonce `sn0 + 1`): Transfers `fundWei` from Sponsor to Target.
   - `signedLaunch` (Type `0x02` EIP-1559, Target nonce `n0 + 1`): Calls `launchToken(params, launchConfigId, pairToken)` on the Pons V2 Factory with `value = launchFee`.
3. **Zero-Blocking Hot Path**:
   - Broadcasts `signedRevoke` first and triggers the status notification asynchronously without blocking execution.
   - Immediately fires `signedFund` in parallel with a tight burst loop broadcasting `signedLaunch` up to `launchRetries` times (default `400` retries at `10ms` intervals) until accepted or acknowledged as known (`already known`).
   - Polls for the `launchToken` transaction receipt and reports the deployed token address, bonding curve address, explorer links, and residual Target balance.

## Pinata IPFS Setup

1. Create a Pinata account and navigate to **API Keys**.
2. Generate a new API key with `pinFileToIPFS` and `testAuthentication` permissions and copy the **JWT**.
3. Open **Settings -> Pinata IPFS** in the bot, paste the JWT (the chat message is deleted automatically), and test authentication.
4. You can now send photos or image files (PNG, JPEG, WebP, GIF, up to 10 MB) in the Logo or Quick Paste screens to upload automatically to IPFS.

## Owner-Only Access Control

- **Root Owners** (`OWNER_TELEGRAM_IDS`) are immutable and can never be revoked at runtime.
- Root Owners see the **Access Management (Owner)** button inside **Settings** to view authorized users, add new users by numeric ID or forwarded message, remove individual users, or clear all non-owner users.
- Non-owners cannot view or invoke any access-management callbacks or commands; revoking a user immediately clears their active in-memory session.

## Build, Run & Test Commands

```bash
# Install dependencies
npm install

# Type-check without emitting files
npm run typecheck

# Compile TypeScript to dist/
npm run build

# Start the compiled bot
npm start

# Run in development watch mode
npm run dev

# Run the test suite
npm test
```
