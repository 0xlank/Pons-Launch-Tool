import { randomBytes } from 'node:crypto';
import type { Address, Hex } from 'viem';

export type PendingInputField =
  | 'wallet_sponsor_pk'
  | 'wallet_target_pk'
  | 'wallet_creator_fee_recipient'
  | 'token_name'
  | 'token_symbol'
  | 'token_logo'
  | 'token_description'
  | 'token_social_twitter'
  | 'token_social_telegram'
  | 'token_social_discord'
  | 'token_social_website'
  | 'token_social_github'
  | 'token_custom_salt'
  | 'token_quick_paste'
  | 'preset_save_label'
  | 'set_rpc_url'
  | 'set_chain_id'
  | 'set_chain_name'
  | 'set_explorer_url'
  | 'set_factory_address'
  | 'set_launch_config_id'
  | 'set_pair_token'
  | 'set_expected_economics'
  | 'set_fund_amount'
  | 'set_creator_fee_recipient'
  | 'set_creator_tax_bps'
  | 'set_gas_price_mult'
  | 'set_gas_limit_mult'
  | 'set_priority_fee'
  | 'set_revoke_gas_limit'
  | 'set_fund_gas_limit'
  | 'set_sponsor_reserve'
  | 'set_safety_buffer'
  | 'set_launch_retries'
  | 'set_retry_interval'
  | 'set_receipt_polling'
  | 'set_receipt_timeout'
  | 'set_pinata_jwt'
  | 'set_pinata_gateway'
  | 'access_add_user';

export type ReturnScreen =
  | 'main'
  | 'wallets'
  | 'token'
  | 'socials'
  | 'presets'
  | 'settings'
  | 'set_network'
  | 'set_factory'
  | 'set_fee'
  | 'set_speed'
  | 'set_pinata'
  | 'set_access';

export interface PendingInputState {
  field: PendingInputField;
  returnScreen: ReturnScreen;
  sensitive: boolean;
  promptMessageId?: number;
  chatId?: number;
  createdAt: number;
}

export interface LaunchConfirmationSnapshot {
  confirmId: string;
  userId: number;
  chatId?: number;
  salt: Hex;
  predictedToken: Address;
  predictedCurve: Address;
  launchFeeWei: bigint;
  fundWei: bigint;
  creatorFeeRecipient: Address;
  createdAt: number;
  expiresAt: number;
}

const DEFAULT_CONFIRM_TTL_MS = 90_000;

export class SessionManager {
  private readonly pendingInputs = new Map<number, PendingInputState>();
  private readonly activeLaunches = new Map<number, AbortController>();
  private readonly launchConfirmations = new Map<number, LaunchConfirmationSnapshot>();

  setPendingInput(
    userId: number,
    state: Omit<PendingInputState, 'createdAt'>,
  ): void {
    this.pendingInputs.set(userId, {
      ...state,
      createdAt: Date.now(),
    });
  }

  getPendingInput(userId: number, chatId?: number): PendingInputState | undefined {
    const pending = this.pendingInputs.get(userId);
    if (!pending) {
      return undefined;
    }
    if (chatId !== undefined && pending.chatId !== undefined && pending.chatId !== chatId) {
      return undefined;
    }
    return pending;
  }

  clearPendingInput(userId: number): void {
    this.pendingInputs.delete(userId);
  }

  createLaunchConfirmation(
    userId: number,
    data: Omit<LaunchConfirmationSnapshot, 'confirmId' | 'userId' | 'createdAt' | 'expiresAt'>,
    ttlMs = DEFAULT_CONFIRM_TTL_MS,
  ): LaunchConfirmationSnapshot {
    const now = Date.now();
    const snapshot: LaunchConfirmationSnapshot = {
      ...data,
      confirmId: randomBytes(6).toString('hex'),
      userId,
      createdAt: now,
      expiresAt: now + ttlMs,
    };
    this.launchConfirmations.set(userId, snapshot);
    return snapshot;
  }

  /**
   * Atomically consumes and invalidates a one-time launch confirmation token.
   * Prevents double-click replays and stale confirmation button execution.
   */
  consumeLaunchConfirmation(
    userId: number,
    confirmId: string,
    chatId?: number,
  ): LaunchConfirmationSnapshot | undefined {
    const existing = this.launchConfirmations.get(userId);
    if (!existing) {
      return undefined;
    }
    if (existing.confirmId !== confirmId) {
      return undefined;
    }
    this.launchConfirmations.delete(userId);

    if (Date.now() > existing.expiresAt) {
      return undefined;
    }
    if (chatId !== undefined && existing.chatId !== undefined && existing.chatId !== chatId) {
      return undefined;
    }
    return existing;
  }

  clearLaunchConfirmation(userId: number): void {
    this.launchConfirmations.delete(userId);
  }

  tryAcquireLaunchLock(userId: number): boolean {
    if (this.activeLaunches.has(userId)) {
      return false;
    }
    this.activeLaunches.set(userId, new AbortController());
    return true;
  }

  getLaunchAbortSignal(userId: number): AbortSignal | undefined {
    return this.activeLaunches.get(userId)?.signal;
  }

  releaseLaunchLock(userId: number): void {
    this.activeLaunches.delete(userId);
  }

  isLaunching(userId: number): boolean {
    return this.activeLaunches.has(userId);
  }

  /**
   * Invoked when an Owner revokes a user's access: clears pending input & confirmation
   * tokens and aborts any in-flight pre-broadcast launch without breaking the active lock.
   */
  revokeUserSession(userId: number): void {
    this.pendingInputs.delete(userId);
    this.launchConfirmations.delete(userId);
    const controller = this.activeLaunches.get(userId);
    if (controller) {
      controller.abort();
    }
  }

  clearUserSession(userId: number): void {
    this.pendingInputs.delete(userId);
    this.launchConfirmations.delete(userId);
    const controller = this.activeLaunches.get(userId);
    if (controller) {
      controller.abort();
    }
    this.activeLaunches.delete(userId);
  }
}
