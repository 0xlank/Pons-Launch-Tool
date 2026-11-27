import { formatEther, formatGwei, type Address } from 'viem';
import { maskRpcUrl, truncateText } from './parsers.js';
import type {
  AuthorizedUserEntry,
  ContractSettings,
  ExecutionSettings,
  FeeSettings,
  IpfsSettings,
  LaunchResult,
  NetworkSettings,
  RpcHealthResult,
  SimulationResult,
  TokenDraft,
  TokenPreset,
  TokenSocials,
  UserProfile,
  UserSettings,
  WalletStatusResult,
} from '../types/domain.js';

export function escapeHtml(input: string): string {
  return input
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function maskAddress(address?: string): string {
  if (!address || address.trim().length < 12) {
    return 'Belum diatur';
  }
  const clean = address.trim();
  return `${clean.slice(0, 6)}...${clean.slice(-4)}`;
}

export function formatEthShort(wei?: bigint, maxDecimals = 6): string {
  if (wei === undefined) {
    return '-';
  }
  const full = formatEther(wei);
  const [whole, frac] = full.split('.');
  if (!frac) {
    return `${whole} ETH`;
  }
  const truncated = frac.slice(0, maxDecimals).replace(/0+$/, '');
  return truncated.length > 0 ? `${whole}.${truncated} ETH` : `${whole} ETH`;
}

export function formatGweiShort(wei?: bigint, maxDecimals = 4): string {
  if (wei === undefined) {
    return '-';
  }
  const full = formatGwei(wei);
  const [whole, frac] = full.split('.');
  if (!frac) {
    return `${whole} Gwei`;
  }
  const truncated = frac.slice(0, maxDecimals).replace(/0+$/, '');
  return truncated.length > 0 ? `${whole}.${truncated} Gwei` : `${whole} Gwei`;
}

export function formatMultiplierFromBps(bps: number): string {
  const whole = Math.floor(bps / 10_000);
  const rem = bps % 10_000;
  const frac = String(rem).padStart(4, '0').replace(/0+$/, '');
  return frac.length > 0 ? `${whole}.${frac}x` : `${whole}.0x`;
}

export function formatBpsPercent(bps: number): string {
  const whole = Math.floor(bps / 100);
  const rem = bps % 100;
  const frac = String(rem).padStart(2, '0').replace(/0+$/, '');
  return frac.length > 0 ? `${whole}.${frac}%` : `${whole}%`;
}

export function formatTxLink(explorerUrl: string, txHash: string, label?: string): string {
  const base = explorerUrl.replace(/\/+$/, '');
  const href = escapeHtml(`${base}/tx/${txHash}`);
  const text = escapeHtml(label ?? maskAddress(txHash));
  return `<a href="${href}">${text}</a>`;
}

export function formatAddressLink(
  explorerUrl: string,
  address: string,
  label?: string,
): string {
  const base = explorerUrl.replace(/\/+$/, '');
  const href = escapeHtml(`${base}/address/${address}`);
  const text = escapeHtml(label ?? address);
  return `<a href="${href}">${text}</a>`;
}

function formatReadinessBadge(ready: boolean): string {
  return ready ? '✅' : '❌';
}

export function formatMainMenu(
  profile: UserProfile,
  derived: { sponsorAddress?: Address; targetAddress?: Address },
  isOwner: boolean,
): string {
  const { settings, tokenDraft } = profile;
  const hasSponsor = Boolean(derived.sponsorAddress);
  const hasTarget = Boolean(derived.targetAddress);
  const feeRecipientTrimmed = settings.fee.creatorFeeRecipient.trim();
  const feeConflictsTarget = Boolean(
    derived.targetAddress &&
      feeRecipientTrimmed &&
      derived.targetAddress.toLowerCase() === feeRecipientTrimmed.toLowerCase(),
  );
  const hasFeeRecipient = feeRecipientTrimmed.length > 0 && !feeConflictsTarget;
  const hasTokenCore =
    tokenDraft.name.trim().length > 0 &&
    tokenDraft.symbol.trim().length > 0 &&
    tokenDraft.logo.trim().length > 0;

  const readyCount = [hasSponsor, hasTarget, hasFeeRecipient, hasTokenCore].filter(Boolean).length;
  const statusLine = feeConflictsTarget
    ? '🔴 <b>Konflik: Creator Fee Wallet tidak boleh sama dengan Target Wallet!</b>'
    : readyCount === 4
      ? '🟢 <b>Siap Simulasi / Launch</b>'
      : `🟡 <b>Kelengkapan: ${readyCount}/4</b>`;

  const tokenSummary =
    tokenDraft.name || tokenDraft.symbol
      ? `${escapeHtml(tokenDraft.name || '-')} (<code>${escapeHtml(tokenDraft.symbol || '-')}</code>)`
      : '<i>Belum diisi</i>';

  const roleBadge = isOwner ? '👑 Owner' : '👤 Authorized User';

  return [
    '🚀 <b>Pons Launch Tool — Control Panel</b>',
    `Role: <b>${roleBadge}</b> | Mode: <b>2-Wallet EIP-7702 Auto-Revoke</b>`,
    '',
    `🌐 <b>Jaringan:</b> ${escapeHtml(settings.network.chainName)} (Chain ID <code>${settings.network.chainId}</code>)`,
    `🏭 <b>Factory:</b> <code>${escapeHtml(maskAddress(settings.contract.factoryAddress))}</code>`,
    '',
    '<b>Status Kesiapan:</b>',
    `${formatReadinessBadge(hasSponsor)} Sponsor Wallet: <code>${escapeHtml(maskAddress(derived.sponsorAddress))}</code>`,
    `${formatReadinessBadge(hasTarget)} Target Wallet (Creator): <code>${escapeHtml(maskAddress(derived.targetAddress))}</code>`,
    `${formatReadinessBadge(hasFeeRecipient)} Creator Fee Wallet: <code>${escapeHtml(maskAddress(settings.fee.creatorFeeRecipient))}</code> (${formatBpsPercent(settings.fee.creatorTaxBps)})`,
    `${formatReadinessBadge(hasTokenCore)} Data Token: ${tokenSummary}`,
    '',
    statusLine,
  ].join('\n');
}

export function formatWalletMenu(
  profile: UserProfile,
  status?: WalletStatusResult,
  derived?: { sponsorAddress?: Address; targetAddress?: Address },
): string {
  const sponsorAddr = status?.sponsorAddress ?? derived?.sponsorAddress;
  const targetAddr = status?.targetAddress ?? derived?.targetAddress;
  const feeRecipient = profile.settings.fee.creatorFeeRecipient.trim();

  let delegationLine = '<i>Belum dicek (klik Refresh Saldo &amp; Delegasi)</i>';
  if (!targetAddr) {
    delegationLine = '<i>Target Wallet belum diatur</i>';
  } else if (status?.targetDelegation) {
    delegationLine = status.targetDelegation.isDelegated
      ? `⚠️ <b>TERDELEGASI EIP-7702</b> ke <code>${escapeHtml(status.targetDelegation.delegateAddress ?? '-')}</code> (akan otomatis di-revoke saat launch)`
      : '✅ <b>Bersih</b> (tidak ada delegasi EIP-7702 aktif)';
  }

  return [
    '👛 <b>Manajemen Wallet (2-Wallet Auto-Revoke)</b>',
    '',
    `🔑 <b>Sponsor Wallet (Pendana &amp; Pengirim Revoke):</b>`,
    sponsorAddr
      ? `   • Alamat: <code>${escapeHtml(sponsorAddr)}</code>\n   • Saldo: <b>${escapeHtml(status?.sponsorBalance !== undefined ? formatEthShort(status.sponsorBalance) : 'Belum dicek')}</b>`
      : '   • Status: ❌ <i>Belum diatur</i>',
    '',
    `🎯 <b>Target Wallet (Token Creator):</b>`,
    targetAddr
      ? `   • Alamat: <code>${escapeHtml(targetAddr)}</code>\n   • Saldo: <b>${escapeHtml(status?.targetBalance !== undefined ? formatEthShort(status.targetBalance) : 'Belum dicek')}</b>`
      : '   • Status: ❌ <i>Belum diatur</i>',
    `   • Delegasi EIP-7702: ${delegationLine}`,
    '',
    `💸 <b>Creator Fee Recipient (Wajib Eksplisit):</b>`,
    feeRecipient
      ? `   • Alamat: <code>${escapeHtml(feeRecipient)}</code>`
      : '   • Status: ❌ <i>WAJIB diisi — tidak pernah fallback ke Sponsor Wallet</i>',
    `   • Creator Tax: <b>${formatBpsPercent(profile.settings.fee.creatorTaxBps)}</b> (<code>${profile.settings.fee.creatorTaxBps} bps</code>)`,
    `   • Dana Transfer ke Target: <b>${escapeHtml(profile.settings.fee.fundAmountEth)} ETH</b>`,
    '',
    '<i>🔒 Private key dienkripsi AES-256-GCM dan pesan chat berisi PK otomatis dihapus.</i>',
  ].join('\n');
}

export function formatResetConfirm(): string {
  return [
    '🧹 <b>Konfirmasi Reset Data Launch</b>',
    '',
    '<b>Data yang AKAN DIHAPUS / DIKOSONGKAN:</b>',
    '1. Sponsor Wallet Private Key',
    '2. Target Wallet Private Key',
    '3. Creator Fee Wallet (Recipient)',
    '4. Logo Token',
    '5. Nama Token',
    '6. Symbol / Ticker Token',
    '7. Deskripsi Token',
    '8. Semua Socials Token (Twitter, Telegram, Discord, Website, GitHub) &amp; Custom Salt',
    '',
    '<b>Data yang TETAP DISIMPAN:</b>',
    '• Network &amp; RPC, Factory &amp; Contract',
    '• Fund Amount ETH &amp; Creator Tax BPS',
    '• Speed &amp; Gas Tuning',
    '• Pinata JWT &amp; IPFS Gateway',
    '• Daftar Preset Token &amp; Daftar Akses User',
    '',
    'Lanjutkan reset data launch?',
  ].join('\n');
}

export function formatTokenMenu(draft: TokenDraft, hasPinataJwt: boolean): string {
  const socialsFilled = [
    draft.socials.twitter ? 'Twitter' : null,
    draft.socials.telegram ? 'Telegram' : null,
    draft.socials.discord ? 'Discord' : null,
    draft.socials.website ? 'Website' : null,
    draft.socials.github ? 'GitHub' : null,
  ].filter((v): v is string => Boolean(v));

  const descPreview = draft.description
    ? draft.description.length > 120
      ? `${draft.description.slice(0, 120)}...`
      : draft.description
    : '';

  return [
    '🪙 <b>Data Token (Draft Aktif)</b>',
    '',
    `• <b>Nama:</b> ${draft.name ? escapeHtml(draft.name) : '❌ <i>Belum diisi</i>'}`,
    `• <b>Symbol:</b> ${draft.symbol ? `<code>${escapeHtml(draft.symbol)}</code>` : '❌ <i>Belum diisi</i>'}`,
    `• <b>Logo:</b> ${draft.logo ? `<code>${escapeHtml(draft.logo)}</code>` : '❌ <i>Belum diisi</i>'}`,
    `• <b>Deskripsi:</b> ${descPreview ? escapeHtml(descPreview) : '<i>Kosong (opsional)</i>'}`,
    `• <b>Socials:</b> ${socialsFilled.length > 0 ? escapeHtml(socialsFilled.join(', ')) : '<i>Kosong (opsional)</i>'}`,
    `• <b>Custom Salt:</b> ${draft.customSalt ? `<code>${escapeHtml(maskAddress(draft.customSalt))}</code>` : '<i>Auto Random (32-byte)</i>'}`,
    '',
    hasPinataJwt
      ? '🖼️ <i>Pinata IPFS aktif — Anda bisa kirim foto/gambar langsung pada menu Edit Logo atau Quick Paste.</i>'
      : 'ℹ️ <i>Pinata JWT belum diatur — Anda tetap bisa tempel URL logo manual, atau atur Pinata di Settings.</i>',
  ].join('\n');
}

export function formatSocialsMenu(socials: TokenSocials): string {
  return [
    '🔗 <b>Socials Token</b>',
    '',
    `• <b>Twitter / X:</b> ${socials.twitter ? escapeHtml(socials.twitter) : '<i>Kosong</i>'}`,
    `• <b>Telegram:</b> ${socials.telegram ? escapeHtml(socials.telegram) : '<i>Kosong</i>'}`,
    `• <b>Discord:</b> ${socials.discord ? escapeHtml(socials.discord) : '<i>Kosong</i>'}`,
    `• <b>Website:</b> ${socials.website ? escapeHtml(socials.website) : '<i>Kosong</i>'}`,
    `• <b>GitHub:</b> ${socials.github ? escapeHtml(socials.github) : '<i>Kosong</i>'}`,
    '',
    '<i>Tip: Kirim tanda <code>-</code> saat mengedit untuk mengosongkan field.</i>',
  ].join('\n');
}

export function formatPresetsMenu(presets: TokenPreset[]): string {
  if (presets.length === 0) {
    return [
      '📚 <b>Preset Token</b>',
      '',
      'Belum ada preset tersimpan.',
      'Anda dapat menyimpan draft token saat ini sebagai preset agar mudah dipakai ulang.',
    ].join('\n');
  }

  const lines = presets.map((preset, idx) => {
    const nameSym = `${preset.draft.name || '-'} (${preset.draft.symbol || '-'})`;
    return `${idx + 1}. <b>${escapeHtml(preset.label)}</b> — ${escapeHtml(nameSym)}`;
  });

  return [
    '📚 <b>Preset Token Tersimpan</b>',
    '',
    ...lines,
    '',
    'Pilih tombol di bawah untuk memuat preset ke draft aktif atau menghapusnya.',
  ].join('\n');
}

export function formatSettingsMenu(settings: UserSettings, isOwner: boolean): string {
  return [
    '⚙️ <b>Pengaturan Bot</b>',
    '',
    `🌐 <b>Network:</b> ${escapeHtml(settings.network.chainName)} (ID <code>${settings.network.chainId}</code>)`,
    `🏭 <b>Factory:</b> <code>${escapeHtml(maskAddress(settings.contract.factoryAddress))}</code> (Config <code>${escapeHtml(settings.contract.launchConfigId)}</code>)`,
    `💰 <b>Funding &amp; Fee:</b> ${escapeHtml(settings.fee.fundAmountEth)} ETH | Tax ${formatBpsPercent(settings.fee.creatorTaxBps)}`,
    `⚡ <b>Speed &amp; Gas:</b> GasPrice ${formatMultiplierFromBps(settings.execution.gasPriceMultiplierBps)} | GasLimit ${formatMultiplierFromBps(settings.execution.gasLimitMultiplierBps)} | Retries ${settings.execution.launchRetries}x`,
    `🖼️ <b>Pinata IPFS:</b> ${settings.ipfs.pinataJwtEnc ? '✅ JWT Terpasang' : '❌ Belum diatur'}`,
    ...(isOwner ? ['', '👑 <i>Anda adalah Root Owner — menu Kelola Akses tersedia di bawah.</i>'] : []),
  ].join('\n');
}

export function formatNetworkSettings(network: NetworkSettings): string {
  return [
    '🌐 <b>Pengaturan Network &amp; RPC</b>',
    '',
    `• <b>RPC URL:</b> <code>${escapeHtml(maskRpcUrl(network.rpcUrl))}</code>`,
    `• <b>Chain ID:</b> <code>${network.chainId}</code>`,
    `• <b>Chain Name:</b> ${escapeHtml(network.chainName)}`,
    `• <b>Explorer URL:</b> <code>${escapeHtml(network.explorerUrl)}</code>`,
  ].join('\n');
}

export function formatFactorySettings(contract: ContractSettings): string {
  return [
    '🏭 <b>Pengaturan Factory &amp; Contract</b>',
    '',
    `• <b>Factory Address:</b> <code>${escapeHtml(contract.factoryAddress)}</code>`,
    `• <b>Launch Config ID:</b> <code>${escapeHtml(contract.launchConfigId)}</code>`,
    `• <b>Pair Token:</b> <code>${escapeHtml(contract.pairToken)}</code>`,
    `• <b>Buyback Enabled:</b> ${contract.buybackEnabled ? '✅ Aktif (true)' : '❌ Nonaktif (false)'}`,
    `• <b>Expected Economics:</b> <code>${escapeHtml(maskAddress(contract.expectedEconomics))}</code>`,
  ].join('\n');
}

export function formatFeeSettings(fee: FeeSettings): string {
  return [
    '💰 <b>Pengaturan Funding &amp; Creator Fee</b>',
    '',
    `• <b>Fund Amount (Sponsor → Target):</b> <b>${escapeHtml(fee.fundAmountEth)} ETH</b>`,
    `• <b>Creator Fee Recipient:</b> ${
      fee.creatorFeeRecipient
        ? `<code>${escapeHtml(fee.creatorFeeRecipient)}</code>`
        : '❌ <i>Belum diatur (WAJIB diisi)</i>'
    }`,
    `• <b>Creator Tax:</b> <b>${formatBpsPercent(fee.creatorTaxBps)}</b> (<code>${fee.creatorTaxBps} bps</code>)`,
    '',
    '<i>⚠️ Creator Fee Recipient wajib berupa alamat EVM valid, bukan zero address, dan bukan Target Wallet.</i>',
  ].join('\n');
}

export function formatSpeedSettings(exec: ExecutionSettings): string {
  return [
    '⚡ <b>Pengaturan Speed &amp; Gas Tuning</b>',
    '',
    `• <b>Gas Price Multiplier:</b> <b>${formatMultiplierFromBps(exec.gasPriceMultiplierBps)}</b> (<code>${exec.gasPriceMultiplierBps} bps</code>)`,
    `• <b>Gas Limit Multiplier:</b> <b>${formatMultiplierFromBps(exec.gasLimitMultiplierBps)}</b> (<code>${exec.gasLimitMultiplierBps} bps</code>)`,
    `• <b>Max Priority Fee:</b> <code>${escapeHtml(exec.maxPriorityFeeWei)} wei</code>`,
    `• <b>Revoke Gas Limit:</b> <code>${escapeHtml(exec.revokeGasLimit)}</code>`,
    `• <b>Fund Gas Limit:</b> <code>${escapeHtml(exec.fundGasLimit)}</code>`,
    `• <b>Sponsor Gas Reserve:</b> <b>${escapeHtml(exec.sponsorGasReserveEth)} ETH</b>`,
    `• <b>Safety Buffer Target:</b> <b>${escapeHtml(exec.safetyBufferEth)} ETH</b>`,
    `• <b>Burst Launch Retries:</b> <code>${exec.launchRetries}</code> kali`,
    `• <b>Burst Retry Interval:</b> <code>${exec.launchRetryIntervalMs} ms</code>`,
    `• <b>Receipt Polling:</b> <code>${exec.receiptPollingMs} ms</code>`,
    `• <b>Receipt Timeout:</b> <code>${exec.receiptTimeoutMs} ms</code>`,
  ].join('\n');
}

export function formatPinataSettings(ipfs: IpfsSettings): string {
  return [
    '🖼️ <b>Pengaturan Pinata IPFS</b>',
    '',
    `• <b>Status JWT:</b> ${ipfs.pinataJwtEnc ? '✅ Tersimpan (terenkripsi AES-256-GCM)' : '❌ Belum diatur'}`,
    `• <b>IPFS Gateway:</b> <code>${escapeHtml(ipfs.pinataGateway)}</code>`,
    '',
    '<i>Pesan chat yang berisi Pinata JWT akan otomatis dihapus setelah disimpan.</i>',
  ].join('\n');
}

export function formatAccessMenu(
  ownerIds: number[],
  authorizedUsers: AuthorizedUserEntry[],
): string {
  const ownerLines = ownerIds.map((id) => `   • <code>${id}</code> (Immutable Root Owner)`);
  const userLines =
    authorizedUsers.length > 0
      ? authorizedUsers.map((entry, idx) => {
          const labelPart = entry.label ? ` — ${escapeHtml(entry.label)}` : '';
          return `   ${idx + 1}. <code>${entry.userId}</code>${labelPart}`;
        })
      : ['   <i>Belum ada user tambahan.</i>'];

  return [
    '👥 <b>Kelola Akses Bot (Khusus Owner)</b>',
    '',
    '👑 <b>Root Owners (.env):</b>',
    ...ownerLines,
    '',
    `👤 <b>Authorized Users (${authorizedUsers.length}):</b>`,
    ...userLines,
    '',
    '<i>Setiap user memiliki profil terisolasi (wallet, Pinata JWT, draft &amp; preset tidak pernah dibagikan antar user).</i>',
  ].join('\n');
}

export function formatSimulationReport(
  sim: SimulationResult,
  network: NetworkSettings,
  draft: TokenDraft,
): string {
  const delegationStatus = sim.targetDelegation.isDelegated
    ? `⚠️ Terdelegasi ke <code>${escapeHtml(sim.targetDelegation.delegateAddress ?? '-')}</code> (akan di-revoke)`
    : '✅ Bersih (tetap kirim TX revoke EIP-7702 untuk proteksi)';

  return [
    '🧪 <b>Hasil Simulasi Launch (Dry Run — SUKSES)</b>',
    '',
    `🪙 <b>Token:</b> ${escapeHtml(draft.name)} (<code>${escapeHtml(draft.symbol)}</code>)`,
    `📍 <b>Prediksi Token:</b> ${formatAddressLink(network.explorerUrl, sim.predictedToken, sim.predictedToken)}`,
    `📈 <b>Prediksi Curve:</b> ${formatAddressLink(network.explorerUrl, sim.predictedCurve, sim.predictedCurve)}`,
    '',
    '<b>Peran Wallet:</b>',
    `• Sponsor: <code>${escapeHtml(sim.sponsorAddress)}</code> (${escapeHtml(formatEthShort(sim.sponsorBalance))}, nonce <code>${sim.sponsorNonce}</code>)`,
    `• Token Creator (Target): <code>${escapeHtml(sim.creator)}</code> (${escapeHtml(formatEthShort(sim.targetBalance))}, nonce <code>${sim.targetNonce}</code>)`,
    `• Creator Fee Recipient: <code>${escapeHtml(sim.creatorFeeRecipient)}</code> (${formatBpsPercent(sim.creatorTaxBps)})`,
    `• Delegasi Target: ${delegationStatus}`,
    '',
    '<b>Estimasi Biaya &amp; Gas:</b>',
    `• Launch Fee: <b>${escapeHtml(formatEthShort(sim.fee))}</b>`,
    `• Estimasi Gas: <code>${sim.gas.toString()}</code> → Gas Limit: <code>${sim.gasLimit.toString()}</code>`,
    `• Gas Price: <code>${escapeHtml(formatGweiShort(sim.gasPrice))}</code> → Max Fee: <code>${escapeHtml(formatGweiShort(sim.maxFee))}</code>`,
    `• Total Kebutuhan Target: <b>${escapeHtml(formatEthShort(sim.needed))}</b>`,
    `• Fund Sponsor → Target: <b>${escapeHtml(formatEthShort(sim.fundWei))}</b> (Buffer aman: ${escapeHtml(formatEthShort(sim.safetyBufferWei))})`,
    `• Salt: <code>${escapeHtml(sim.salt)}</code>`,
    `• Durasi Simulasi: <code>${sim.durationMs} ms</code>`,
  ].join('\n');
}

export function formatLaunchConfirm(sim: SimulationResult, profile: UserProfile): string {
  const { tokenDraft, settings } = profile;
  return [
    '⚠️ <b>Konfirmasi Eksekusi Launch Token</b>',
    'Pastikan seluruh parameter di bawah sudah benar sebelum mengirim transaksi on-chain:',
    '',
    `🪙 <b>Token:</b> ${escapeHtml(tokenDraft.name)} (<code>${escapeHtml(tokenDraft.symbol)}</code>)`,
    `🌐 <b>Jaringan:</b> ${escapeHtml(settings.network.chainName)} (Chain ID <code>${settings.network.chainId}</code>)`,
    '',
    '<b>Pemisahan Peran Wallet:</b>',
    `• <b>Sponsor Wallet:</b> <code>${escapeHtml(sim.sponsorAddress)}</code>`,
    `• <b>Token Creator (Target Wallet):</b> <code>${escapeHtml(sim.creator)}</code>`,
    `• <b>Creator Fee Recipient:</b> <code>${escapeHtml(sim.creatorFeeRecipient)}</code>`,
    `• <b>Creator Tax:</b> <b>${formatBpsPercent(sim.creatorTaxBps)}</b> (<code>${sim.creatorTaxBps} bps</code>)`,
    '',
    '<b>Prediksi Alamat Kontrak:</b>',
    `• Token: <code>${escapeHtml(sim.predictedToken)}</code>`,
    `• Curve: <code>${escapeHtml(sim.predictedCurve)}</code>`,
    '',
    '<b>Rincian Dana &amp; Eksekusi:</b>',
    `• Launch Fee: <b>${escapeHtml(formatEthShort(sim.fee))}</b>`,
    `• Fund ke Target: <b>${escapeHtml(formatEthShort(sim.fundWei))}</b> (estimasi perlu ${escapeHtml(formatEthShort(sim.needed))})`,
    `• Alur: <code>Pre-Sign 3 TX → Revoke EIP-7702 → Fund + Burst Launch (${settings.execution.launchRetries}x)</code>`,
    `• Salt Terkunci: <code>${escapeHtml(maskAddress(sim.salt))}</code> (berlaku 90 detik, 1x pakai)`,
    '',
    'Tekan tombol di bawah untuk mengeksekusi sekarang.',
  ].join('\n');
}

export function formatLaunchResult(result: LaunchResult, draft: TokenDraft): string {
  const header = result.success
    ? '✅ <b>LAUNCH TOKEN BERHASIL!</b>'
    : '❌ <b>TRANSAKSI LAUNCH REVERTED ON-CHAIN</b>';

  const fundLine = result.fundHash
    ? formatTxLink(result.explorerUrl, result.fundHash)
    : `⚠️ ${escapeHtml(result.fundError ?? 'Tidak ada hash')}`;

  return [
    header,
    '',
    `🪙 <b>Token:</b> ${escapeHtml(draft.name)} (<code>${escapeHtml(draft.symbol)}</code>)`,
    `📍 <b>Token Address:</b> ${formatAddressLink(result.explorerUrl, result.predictedToken, result.predictedToken)}`,
    `📈 <b>Bonding Curve:</b> ${formatAddressLink(result.explorerUrl, result.predictedCurve, result.predictedCurve)}`,
    '',
    '<b>Peran &amp; Fee:</b>',
    `• Token Creator (Target): <code>${escapeHtml(result.creator)}</code>`,
    `• Creator Fee Recipient: <code>${escapeHtml(result.creatorFeeRecipient)}</code> (${formatBpsPercent(result.creatorTaxBps)})`,
    '',
    '<b>Transaksi On-Chain:</b>',
    `• Revoke EIP-7702 TX: ${formatTxLink(result.explorerUrl, result.revokeHash)}`,
    `• Fund Target TX: ${fundLine}`,
    `• Launch Token TX: ${formatTxLink(result.explorerUrl, result.launchHash)}`,
    '',
    '<b>Metrik Eksekusi:</b>',
    `• Block: <code>${result.blockNumber.toString()}</code> | Gas Used: <code>${result.gasUsed.toString()}</code>`,
    `• Burst Attempts: <code>${result.attempts}</code> | Broadcast: <code>${result.broadcastDurationMs} ms</code> | Total: <code>${result.totalDurationMs} ms</code>`,
    `• Sisa Saldo Target: <b>${escapeHtml(formatEthShort(result.postTargetBalance))}</b>`,
    `• Waktu (UTC): <code>${escapeHtml(new Date().toISOString())}</code>`,
  ].join('\n');
}

export function formatRpcHealthReport(
  health: RpcHealthResult,
  walletStatus: WalletStatusResult,
  fee: FeeSettings,
  network: NetworkSettings,
): string {
  const rpcLines = health.ok
    ? [
        `• Status: ✅ <b>Online</b> (<code>${health.latencyMs} ms</code>)`,
        `• Block Terbaru: <code>${health.blockNumber.toString()}</code>`,
        `• Gas Price: <code>${escapeHtml(formatGweiShort(health.gasPrice))}</code>`,
        `• Factory Launch Fee: <b>${escapeHtml(formatEthShort(health.launchFee))}</b>`,
      ]
    : [
        `• Status: ❌ <b>Gagal Terhubung</b> (<code>${health.latencyMs} ms</code>)`,
        `• Error: <code>${escapeHtml(truncateText(health.error ?? 'Unknown error', 600))}</code>`,
      ];

  const sponsorLine = walletStatus.sponsorAddress
    ? `<code>${escapeHtml(maskAddress(walletStatus.sponsorAddress))}</code> — <b>${escapeHtml(formatEthShort(walletStatus.sponsorBalance))}</b>`
    : '❌ <i>Belum diatur</i>';

  const targetLine = walletStatus.targetAddress
    ? `<code>${escapeHtml(maskAddress(walletStatus.targetAddress))}</code> — <b>${escapeHtml(formatEthShort(walletStatus.targetBalance))}</b>`
    : '❌ <i>Belum diatur</i>';

  let delegationLine = '<i>-</i>';
  if (walletStatus.targetDelegation) {
    delegationLine = walletStatus.targetDelegation.isDelegated
      ? `⚠️ Terdelegasi ke <code>${escapeHtml(walletStatus.targetDelegation.delegateAddress ?? '-')}</code>`
      : '✅ Bersih';
  }

  return [
    '📡 <b>Laporan Kesehatan RPC &amp; Saldo</b>',
    '',
    `🌐 <b>Network:</b> ${escapeHtml(network.chainName)} (Chain ID <code>${network.chainId}</code>)`,
    `🔗 <b>RPC:</b> <code>${escapeHtml(maskRpcUrl(network.rpcUrl))}</code>`,
    ...rpcLines,
    '',
    '<b>Status Wallet:</b>',
    `• Sponsor: ${sponsorLine}`,
    `• Target (Creator): ${targetLine}`,
    `• Delegasi Target: ${delegationLine}`,
    `• Creator Fee Wallet: ${
      fee.creatorFeeRecipient
        ? `<code>${escapeHtml(maskAddress(fee.creatorFeeRecipient))}</code>`
        : '❌ <i>Belum diatur</i>'
    }`,
    '',
    `<i>Dicek pada ${escapeHtml(new Date().toISOString())}</i>`,
  ].join('\n');
}
