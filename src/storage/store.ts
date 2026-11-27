import { randomBytes } from 'node:crypto';
import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { Hex } from 'viem';
import {
  createDefaultUserSettings,
  createEmptyTokenDraft,
  createEmptyTokenSocials,
} from '../config/defaults.js';
import type {
  AuthorizedUserEntry,
  BotStoreData,
  EnvBootstrapDefaults,
  PartialDecryptedWallets,
  TokenDraft,
  TokenPreset,
  UserProfile,
  UserSettings,
} from '../types/domain.js';
import { assertStrongEncryptionKey, decryptSecret, encryptSecret } from './crypto.js';

export const MAX_PRESETS_PER_USER = 20;
const WINDOWS_RETRYABLE_CODES = new Set(['EPERM', 'EACCES', 'EBUSY']);
const RENAME_MAX_ATTEMPTS = 5;

export class StoreAuthorizationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StoreAuthorizationError';
  }
}

export interface BotStoreOptions {
  filePath: string;
  encryptionKey: string;
  ownerIds: Iterable<number>;
  initialAllowedIds?: Iterable<number>;
  bootstrapDefaults?: EnvBootstrapDefaults;
}

function deepClone<T>(value: T): T {
  return structuredClone(value);
}

function utcNow(): string {
  return new Date().toISOString();
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function buildSecretAad(userId: number, field: 'sponsorPk' | 'targetPk' | 'pinataJwt'): string {
  return `v1:${userId}:${field}`;
}

export class BotStore {
  private readonly filePath: string;
  private readonly encryptionKey: string;
  private readonly ownerIds: Set<number>;
  private readonly initialAllowedIds: Set<number>;
  private readonly bootstrapDefaults?: EnvBootstrapDefaults;

  private data: BotStoreData = {
    version: 1,
    authorizedUsers: [],
    users: {},
  };

  private initialized = false;
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(options: BotStoreOptions) {
    this.filePath = options.filePath;
    this.encryptionKey = assertStrongEncryptionKey(options.encryptionKey);
    this.ownerIds = new Set<number>(options.ownerIds);
    this.initialAllowedIds = new Set<number>(options.initialAllowedIds ?? []);
    this.bootstrapDefaults = options.bootstrapDefaults;

    if (this.ownerIds.size === 0) {
      throw new Error('BotStore requires at least one root owner ID');
    }
  }

  private normalizeLoadedProfile(rawKey: string, rawProfile: Partial<UserProfile> | undefined): UserProfile | undefined {
    const parsedId = Number(rawKey);
    const userId =
      typeof rawProfile?.userId === 'number' && Number.isSafeInteger(rawProfile.userId) && rawProfile.userId > 0
        ? rawProfile.userId
        : Number.isSafeInteger(parsedId) && parsedId > 0
          ? parsedId
          : undefined;

    if (userId === undefined) {
      return undefined;
    }

    const defaults = createDefaultUserSettings(this.bootstrapDefaults);
    const emptyDraft = createEmptyTokenDraft();
    const rawSettings = rawProfile?.settings;
    const rawDraft = rawProfile?.tokenDraft;
    const now = utcNow();

    const normalizedPresets: TokenPreset[] = Array.isArray(rawProfile?.presets)
      ? rawProfile.presets
          .filter((p) => p && typeof p.id === 'string' && typeof p.label === 'string')
          .slice(0, MAX_PRESETS_PER_USER)
          .map((p) => ({
            id: p.id,
            label: p.label,
            createdAt: typeof p.createdAt === 'string' ? p.createdAt : now,
            updatedAt: typeof p.updatedAt === 'string' ? p.updatedAt : now,
            draft: {
              ...emptyDraft,
              ...(p.draft ?? {}),
              socials: {
                ...createEmptyTokenSocials(),
                ...(p.draft?.socials ?? {}),
              },
            },
          }))
      : [];

    return {
      userId,
      createdAt: typeof rawProfile?.createdAt === 'string' ? rawProfile.createdAt : now,
      updatedAt: typeof rawProfile?.updatedAt === 'string' ? rawProfile.updatedAt : now,
      settings: {
        network: { ...defaults.network, ...(rawSettings?.network ?? {}) },
        contract: { ...defaults.contract, ...(rawSettings?.contract ?? {}) },
        fee: { ...defaults.fee, ...(rawSettings?.fee ?? {}) },
        execution: { ...defaults.execution, ...(rawSettings?.execution ?? {}) },
        ipfs: { ...defaults.ipfs, ...(rawSettings?.ipfs ?? {}) },
      },
      wallets: {
        ...(typeof rawProfile?.wallets?.sponsorPkEnc === 'string'
          ? { sponsorPkEnc: rawProfile.wallets.sponsorPkEnc }
          : {}),
        ...(typeof rawProfile?.wallets?.targetPkEnc === 'string'
          ? { targetPkEnc: rawProfile.wallets.targetPkEnc }
          : {}),
      },
      tokenDraft: {
        ...emptyDraft,
        ...(rawDraft ?? {}),
        socials: {
          ...createEmptyTokenSocials(),
          ...(rawDraft?.socials ?? {}),
        },
      },
      presets: normalizedPresets,
    };
  }

  async init(): Promise<void> {
    if (this.initialized) {
      return;
    }

    await this.enqueueWrite(async () => {
      if (this.initialized) {
        return;
      }

      try {
        const raw = await readFile(this.filePath, 'utf8');
        const parsed = JSON.parse(raw) as Partial<BotStoreData>;
        const normalizedUsers: Record<string, UserProfile> = {};

        if (parsed.users && typeof parsed.users === 'object') {
          for (const [k, rawProfile] of Object.entries(parsed.users)) {
            const normalized = this.normalizeLoadedProfile(k, rawProfile);
            if (normalized) {
              normalizedUsers[String(normalized.userId)] = normalized;
            }
          }
        }

        this.data = {
          version: 1,
          authorizedUsers: Array.isArray(parsed.authorizedUsers)
            ? parsed.authorizedUsers.filter(
                (entry) =>
                  typeof entry?.userId === 'number' &&
                  Number.isSafeInteger(entry.userId) &&
                  entry.userId > 0 &&
                  !this.ownerIds.has(entry.userId),
              )
            : [],
          users: normalizedUsers,
        };
      } catch (err: unknown) {
        const code = (err as NodeJS.ErrnoException | undefined)?.code;
        if (code !== 'ENOENT') {
          throw err;
        }

        const now = utcNow();
        const primaryOwner = this.listOwnerIds()[0];
        const initialEntries: AuthorizedUserEntry[] = [];

        for (const allowedId of this.initialAllowedIds) {
          if (this.ownerIds.has(allowedId)) {
            continue;
          }
          initialEntries.push({
            userId: allowedId,
            label: 'Env Bootstrap',
            addedBy: primaryOwner,
            addedAt: now,
          });
        }

        const initialData: BotStoreData = {
          version: 1,
          authorizedUsers: initialEntries,
          users: {},
        };

        await this.persistDataUnsafe(initialData);
        this.data = initialData;
      }

      this.initialized = true;
    });
  }

  private enqueueWrite<T>(task: () => Promise<T>): Promise<T> {
    const run = this.writeQueue.then(task, task);
    this.writeQueue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async persistDataUnsafe(snapshot: BotStoreData): Promise<void> {
    const dir = dirname(this.filePath);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const tmpPath = `${this.filePath}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
    const serialized = `${JSON.stringify(snapshot, null, 2)}\n`;

    let renamed = false;
    try {
      const handle = await open(tmpPath, 'w', 0o600);
      try {
        await handle.writeFile(serialized, 'utf8');
        await handle.sync();
      } finally {
        await handle.close();
      }

      for (let attempt = 1; attempt <= RENAME_MAX_ATTEMPTS; attempt += 1) {
        try {
          await rename(tmpPath, this.filePath);
          renamed = true;
          break;
        } catch (err: unknown) {
          const code = (err as NodeJS.ErrnoException | undefined)?.code;
          if (code && WINDOWS_RETRYABLE_CODES.has(code) && attempt < RENAME_MAX_ATTEMPTS) {
            await sleep(25 * attempt);
            continue;
          }
          throw err;
        }
      }
    } finally {
      if (!renamed) {
        await unlink(tmpPath).catch(() => undefined);
      }
    }
  }

  /**
   * Copy-on-write mutation helper: clones state, applies mutation to clone,
   * durably persists to disk first, and only commits to RAM upon success.
   */
  private async mutateAndPersist<T>(
    mutator: (nextData: BotStoreData) => { result: T; changed: boolean },
  ): Promise<T> {
    return this.enqueueWrite(async () => {
      const nextData = deepClone(this.data);
      const { result, changed } = mutator(nextData);
      if (changed) {
        await this.persistDataUnsafe(nextData);
        this.data = nextData;
      }
      return result;
    });
  }

  private assertOwner(actorId: number): void {
    if (!this.isOwner(actorId)) {
      throw new StoreAuthorizationError(`User ${actorId} is not a root owner`);
    }
  }

  private getOrCreateProfileIn(data: BotStoreData, userId: number): { profile: UserProfile; created: boolean } {
    const key = String(userId);
    const existing = data.users[key];
    if (existing) {
      return { profile: existing, created: false };
    }

    const now = utcNow();
    const fresh: UserProfile = {
      userId,
      createdAt: now,
      updatedAt: now,
      settings: createDefaultUserSettings(this.bootstrapDefaults),
      wallets: {},
      tokenDraft: createEmptyTokenDraft(),
      presets: [],
    };
    data.users[key] = fresh;
    return { profile: fresh, created: true };
  }

  // ---------------------------------------------------------------------------
  // Access Control (Root Owners + Dynamic Authorized Users)
  // ---------------------------------------------------------------------------

  isOwner(userId: number): boolean {
    return this.ownerIds.has(userId);
  }

  isAuthorized(userId: number): boolean {
    if (this.ownerIds.has(userId)) {
      return true;
    }
    return this.data.authorizedUsers.some((entry) => entry.userId === userId);
  }

  listOwnerIds(): number[] {
    return Array.from(this.ownerIds).sort((a, b) => a - b);
  }

  listAuthorizedUsers(): AuthorizedUserEntry[] {
    return deepClone(this.data.authorizedUsers);
  }

  async addAuthorizedUser(
    ownerId: number,
    targetId: number,
    label?: string,
  ): Promise<AuthorizedUserEntry> {
    this.assertOwner(ownerId);

    if (!Number.isSafeInteger(targetId) || targetId <= 0) {
      throw new Error('Target Telegram user ID must be a positive safe integer');
    }
    if (this.ownerIds.has(targetId)) {
      throw new Error('Target user is already an immutable root owner');
    }

    return this.mutateAndPersist((nextData) => {
      const normalizedLabel = label?.trim() ? label.trim().slice(0, 64) : undefined;
      const existing = nextData.authorizedUsers.find((entry) => entry.userId === targetId);
      if (existing) {
        if (normalizedLabel !== undefined) {
          existing.label = normalizedLabel;
        }
        return { result: deepClone(existing), changed: true };
      }

      const entry: AuthorizedUserEntry = {
        userId: targetId,
        ...(normalizedLabel ? { label: normalizedLabel } : {}),
        addedBy: ownerId,
        addedAt: utcNow(),
      };
      nextData.authorizedUsers.push(entry);
      return { result: deepClone(entry), changed: true };
    });
  }

  async removeAuthorizedUser(ownerId: number, targetId: number): Promise<boolean> {
    this.assertOwner(ownerId);

    if (this.ownerIds.has(targetId)) {
      throw new StoreAuthorizationError('Root owners are immutable and cannot be removed');
    }

    return this.mutateAndPersist((nextData) => {
      const before = nextData.authorizedUsers.length;
      nextData.authorizedUsers = nextData.authorizedUsers.filter(
        (entry) => entry.userId !== targetId,
      );
      const removed = nextData.authorizedUsers.length < before;
      return { result: removed, changed: removed };
    });
  }

  async clearAuthorizedUsersWithIds(ownerId: number): Promise<number[]> {
    this.assertOwner(ownerId);

    return this.mutateAndPersist((nextData) => {
      const removedIds = nextData.authorizedUsers.map((entry) => entry.userId);
      if (removedIds.length === 0) {
        return { result: [], changed: false };
      }
      nextData.authorizedUsers = [];
      return { result: removedIds, changed: true };
    });
  }

  async clearAuthorizedUsers(ownerId: number): Promise<number> {
    const removedIds = await this.clearAuthorizedUsersWithIds(ownerId);
    return removedIds.length;
  }

  // ---------------------------------------------------------------------------
  // Isolated Per-User Profiles, Settings, Secrets, Drafts, and Presets
  // ---------------------------------------------------------------------------

  getUserProfile(userId: number): UserProfile {
    const existing = this.data.users[String(userId)];
    if (existing) {
      return deepClone(existing);
    }

    const now = utcNow();
    return {
      userId,
      createdAt: now,
      updatedAt: now,
      settings: createDefaultUserSettings(this.bootstrapDefaults),
      wallets: {},
      tokenDraft: createEmptyTokenDraft(),
      presets: [],
    };
  }

  async ensureUserProfile(userId: number): Promise<UserProfile> {
    return this.mutateAndPersist((nextData) => {
      const { profile, created } = this.getOrCreateProfileIn(nextData, userId);
      return { result: deepClone(profile), changed: created };
    });
  }

  async updateUserSettings(
    userId: number,
    updater: (settings: UserSettings) => UserSettings | void,
  ): Promise<UserSettings> {
    return this.mutateAndPersist((nextData) => {
      const { profile } = this.getOrCreateProfileIn(nextData, userId);
      const working = deepClone(profile.settings);
      const updated = updater(working) ?? working;
      profile.settings = updated;
      profile.updatedAt = utcNow();
      return { result: deepClone(profile.settings), changed: true };
    });
  }

  async setSponsorPrivateKey(userId: number, privateKey: Hex): Promise<void> {
    await this.mutateAndPersist((nextData) => {
      const { profile } = this.getOrCreateProfileIn(nextData, userId);
      profile.wallets.sponsorPkEnc = encryptSecret(
        privateKey,
        this.encryptionKey,
        buildSecretAad(userId, 'sponsorPk'),
      );
      profile.updatedAt = utcNow();
      return { result: undefined, changed: true };
    });
  }

  async clearSponsorPrivateKey(userId: number): Promise<void> {
    await this.mutateAndPersist((nextData) => {
      const { profile } = this.getOrCreateProfileIn(nextData, userId);
      delete profile.wallets.sponsorPkEnc;
      profile.updatedAt = utcNow();
      return { result: undefined, changed: true };
    });
  }

  async setTargetPrivateKey(userId: number, privateKey: Hex): Promise<void> {
    await this.mutateAndPersist((nextData) => {
      const { profile } = this.getOrCreateProfileIn(nextData, userId);
      profile.wallets.targetPkEnc = encryptSecret(
        privateKey,
        this.encryptionKey,
        buildSecretAad(userId, 'targetPk'),
      );
      profile.updatedAt = utcNow();
      return { result: undefined, changed: true };
    });
  }

  async clearTargetPrivateKey(userId: number): Promise<void> {
    await this.mutateAndPersist((nextData) => {
      const { profile } = this.getOrCreateProfileIn(nextData, userId);
      delete profile.wallets.targetPkEnc;
      profile.updatedAt = utcNow();
      return { result: undefined, changed: true };
    });
  }

  async clearAllWallets(userId: number): Promise<void> {
    await this.mutateAndPersist((nextData) => {
      const { profile } = this.getOrCreateProfileIn(nextData, userId);
      delete profile.wallets.sponsorPkEnc;
      delete profile.wallets.targetPkEnc;
      profile.updatedAt = utcNow();
      return { result: undefined, changed: true };
    });
  }

  getDecryptedWallets(userId: number): PartialDecryptedWallets {
    const profile = this.data.users[String(userId)];
    if (!profile) {
      return {};
    }

    const result: PartialDecryptedWallets = {};
    if (profile.wallets.sponsorPkEnc) {
      result.sponsorPk = decryptSecret(
        profile.wallets.sponsorPkEnc,
        this.encryptionKey,
        buildSecretAad(userId, 'sponsorPk'),
      ) as Hex;
    }
    if (profile.wallets.targetPkEnc) {
      result.targetPk = decryptSecret(
        profile.wallets.targetPkEnc,
        this.encryptionKey,
        buildSecretAad(userId, 'targetPk'),
      ) as Hex;
    }
    return result;
  }

  async setPinataJwt(userId: number, jwt: string): Promise<void> {
    await this.mutateAndPersist((nextData) => {
      const { profile } = this.getOrCreateProfileIn(nextData, userId);
      profile.settings.ipfs.pinataJwtEnc = encryptSecret(
        jwt.trim(),
        this.encryptionKey,
        buildSecretAad(userId, 'pinataJwt'),
      );
      profile.updatedAt = utcNow();
      return { result: undefined, changed: true };
    });
  }

  async clearPinataJwt(userId: number): Promise<void> {
    await this.mutateAndPersist((nextData) => {
      const { profile } = this.getOrCreateProfileIn(nextData, userId);
      delete profile.settings.ipfs.pinataJwtEnc;
      profile.updatedAt = utcNow();
      return { result: undefined, changed: true };
    });
  }

  getDecryptedPinataJwt(userId: number): string | undefined {
    const profile = this.data.users[String(userId)];
    const enc = profile?.settings.ipfs.pinataJwtEnc;
    if (!enc) {
      return undefined;
    }
    return decryptSecret(enc, this.encryptionKey, buildSecretAad(userId, 'pinataJwt'));
  }

  async updateTokenDraft(
    userId: number,
    updater: (draft: TokenDraft) => TokenDraft | void,
  ): Promise<TokenDraft> {
    return this.mutateAndPersist((nextData) => {
      const { profile } = this.getOrCreateProfileIn(nextData, userId);
      const working = deepClone(profile.tokenDraft);
      const updated = updater(working) ?? working;
      profile.tokenDraft = updated;
      profile.updatedAt = utcNow();
      return { result: deepClone(profile.tokenDraft), changed: true };
    });
  }

  async clearTokenDraft(userId: number): Promise<TokenDraft> {
    return this.mutateAndPersist((nextData) => {
      const { profile } = this.getOrCreateProfileIn(nextData, userId);
      profile.tokenDraft = createEmptyTokenDraft();
      profile.updatedAt = utcNow();
      return { result: deepClone(profile.tokenDraft), changed: true };
    });
  }

  listPresets(userId: number): TokenPreset[] {
    const profile = this.data.users[String(userId)];
    return profile ? deepClone(profile.presets) : [];
  }

  async savePreset(userId: number, label: string, draft?: TokenDraft): Promise<TokenPreset> {
    const cleanLabel = label.trim().slice(0, 48);
    if (!cleanLabel) {
      throw new Error('Preset label must not be empty');
    }

    return this.mutateAndPersist((nextData) => {
      const { profile } = this.getOrCreateProfileIn(nextData, userId);
      const now = utcNow();
      const sourceDraft = deepClone(draft ?? profile.tokenDraft);
      const existing = profile.presets.find(
        (preset) => preset.label.toLowerCase() === cleanLabel.toLowerCase(),
      );

      if (existing) {
        existing.label = cleanLabel;
        existing.draft = sourceDraft;
        existing.updatedAt = now;
        profile.updatedAt = now;
        return { result: deepClone(existing), changed: true };
      }

      if (profile.presets.length >= MAX_PRESETS_PER_USER) {
        throw new Error(`Maximum of ${MAX_PRESETS_PER_USER} saved presets reached. Delete an old preset first.`);
      }

      const preset: TokenPreset = {
        id: randomBytes(4).toString('hex'),
        label: cleanLabel,
        createdAt: now,
        updatedAt: now,
        draft: sourceDraft,
      };
      profile.presets.push(preset);
      profile.updatedAt = now;
      return { result: deepClone(preset), changed: true };
    });
  }

  async loadPresetToDraft(userId: number, presetId: string): Promise<TokenDraft> {
    return this.mutateAndPersist((nextData) => {
      const { profile } = this.getOrCreateProfileIn(nextData, userId);
      const preset = profile.presets.find((item) => item.id === presetId);
      if (!preset) {
        throw new Error(`Preset "${presetId}" not found`);
      }

      profile.tokenDraft = deepClone(preset.draft);
      profile.updatedAt = utcNow();
      return { result: deepClone(profile.tokenDraft), changed: true };
    });
  }

  async deletePreset(userId: number, presetId: string): Promise<boolean> {
    return this.mutateAndPersist((nextData) => {
      const { profile } = this.getOrCreateProfileIn(nextData, userId);
      const before = profile.presets.length;
      profile.presets = profile.presets.filter((item) => item.id !== presetId);
      const removed = profile.presets.length < before;
      if (removed) {
        profile.updatedAt = utcNow();
      }
      return { result: removed, changed: removed };
    });
  }

  /**
   * Atomically resets sensitive per-launch credentials, creator fee recipient,
   * and active token draft fields while preserving network, contract, funding/tax,
   * execution tuning, IPFS/Pinata settings, saved presets, and root ACL.
   */
  async resetLaunchData(userId: number): Promise<UserProfile> {
    return this.mutateAndPersist((nextData) => {
      const { profile } = this.getOrCreateProfileIn(nextData, userId);

      // 1 & 2: Clear Sponsor PK and Target PK
      delete profile.wallets.sponsorPkEnc;
      delete profile.wallets.targetPkEnc;

      // 3: Clear creator fee recipient (preserve fundAmountEth and creatorTaxBps)
      profile.settings.fee.creatorFeeRecipient = '';

      // 4-8: Clear active token draft fields (logo, name, symbol, description, socials, customSalt)
      profile.tokenDraft = {
        name: '',
        symbol: '',
        logo: '',
        description: '',
        socials: createEmptyTokenSocials(),
        customSalt: '',
      };

      profile.updatedAt = utcNow();
      return { result: deepClone(profile), changed: true };
    });
  }
}
