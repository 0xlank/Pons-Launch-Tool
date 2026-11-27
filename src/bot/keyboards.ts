import { InlineKeyboard } from 'grammy';
import type { AuthorizedUserEntry, TokenPreset } from '../types/domain.js';

export function buildMainMenuKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text('🚀 Launch Token', 'launch:prepare')
    .text('🧪 Simulasi (Dry Run)', 'launch:sim')
    .row()
    .text('🪙 Edit Data Token', 'tok:menu')
    .text('📚 Preset Token', 'pre:menu')
    .row()
    .text('👛 Wallet', 'wal:menu')
    .text('⚙️ Settings', 'set:menu')
    .row()
    .text('📡 Cek RPC & Saldo', 'rpc:check')
    .text('🧹 Reset Data Launch', 'rst:confirm');
}

export function buildWalletMenuKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text('🔑 Set / Ganti Sponsor PK', 'wal:set:sponsor')
    .row()
    .text('🎯 Set / Ganti Target PK', 'wal:set:target')
    .row()
    .text('💸 Set / Ganti Creator Fee Wallet', 'wal:set:fee_rec')
    .row()
    .text('🔄 Refresh Saldo & Delegasi', 'wal:refresh')
    .row()
    .text('🧹 Reset Data Launch', 'rst:confirm')
    .text('🗑️ Hapus Wallet', 'wal:clear')
    .row()
    .text('🏠 Menu Utama', 'menu:main');
}

export function buildWalletClearConfirmKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text('✅ Ya, Hapus Sponsor & Target PK', 'wal:clear:yes')
    .row()
    .text('❌ Batal', 'wal:menu');
}

export function buildResetConfirmKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text('✅ Ya, Reset Data Launch', 'rst:exec')
    .row()
    .text('❌ Batal', 'menu:main');
}

export function buildTokenMenuKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text('✏️ Nama', 'tok:edit:name')
    .text('🏷️ Symbol', 'tok:edit:symbol')
    .row()
    .text('🖼️ Logo (URL / Foto)', 'tok:edit:logo')
    .text('📝 Deskripsi', 'tok:edit:desc')
    .row()
    .text('🔗 Socials', 'tok:socials')
    .text('🧂 Custom Salt', 'tok:edit:salt')
    .row()
    .text('⚡ Quick Paste / Foto+Caption', 'tok:quick')
    .row()
    .text('💾 Simpan ke Preset', 'pre:save')
    .text('🗑️ Kosongkan Draft', 'tok:clear')
    .row()
    .text('🧪 Simulasi', 'launch:sim')
    .text('🏠 Menu Utama', 'menu:main');
}

export function buildSocialsMenuKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text('🐦 Twitter / X', 'tok:soc:twitter')
    .text('✈️ Telegram', 'tok:soc:telegram')
    .row()
    .text('💬 Discord', 'tok:soc:discord')
    .text('🌐 Website', 'tok:soc:website')
    .row()
    .text('💻 GitHub', 'tok:soc:github')
    .row()
    .text('⬅️ Kembali ke Data Token', 'tok:menu');
}

export function buildPresetsMenuKeyboard(presets: TokenPreset[]): InlineKeyboard {
  const kb = new InlineKeyboard();

  for (const preset of presets) {
    const shortLabel = preset.label.length > 22 ? `${preset.label.slice(0, 21)}…` : preset.label;
    kb.text(`📥 ${shortLabel}`, `pre:load:${preset.id}`)
      .text('🗑️', `pre:del:${preset.id}`)
      .row();
  }

  kb.text('💾 Simpan Draft Saat Ini', 'pre:save')
    .row()
    .text('🪙 Edit Token', 'tok:menu')
    .text('🏠 Menu Utama', 'menu:main');

  return kb;
}

export function buildSettingsMenuKeyboard(isOwner: boolean): InlineKeyboard {
  const kb = new InlineKeyboard()
    .text('🌐 Network & RPC', 'set:net:menu')
    .text('🏭 Factory & Contract', 'set:fac:menu')
    .row()
    .text('💰 Funding & Creator Fee', 'set:fee:menu')
    .text('⚡ Speed & Gas Tuning', 'set:spd:menu')
    .row()
    .text('🖼️ Pinata IPFS', 'set:pin:menu')
    .row();

  if (isOwner) {
    kb.text('👥 Kelola Akses (Owner)', 'set:access:menu').row();
  }

  kb.text('🏠 Menu Utama', 'menu:main');
  return kb;
}

export function buildNetworkSettingsKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text('🔗 Ubah RPC URL', 'set:net:rpc')
    .text('🔢 Ubah Chain ID', 'set:net:chainid')
    .row()
    .text('🏷️ Ubah Chain Name', 'set:net:name')
    .text('🔍 Ubah Explorer URL', 'set:net:explorer')
    .row()
    .text('📡 Tes Koneksi RPC', 'rpc:check')
    .text('↩️ Default Network', 'set:net:reset')
    .row()
    .text('⬅️ Kembali ke Settings', 'set:menu');
}

export function buildFactorySettingsKeyboard(buybackEnabled: boolean): InlineKeyboard {
  return new InlineKeyboard()
    .text('🏭 Factory Address', 'set:fac:addr')
    .text('🆔 Launch Config ID', 'set:fac:cfg')
    .row()
    .text('🪙 Pair Token', 'set:fac:pair')
    .text(buybackEnabled ? '🔄 Buyback: ON' : '🔄 Buyback: OFF', 'set:fac:buyback')
    .row()
    .text('🧬 Expected Economics', 'set:fac:econ')
    .text('↩️ Default Contract', 'set:fac:reset')
    .row()
    .text('⬅️ Kembali ke Settings', 'set:menu');
}

export function buildFeeSettingsKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text('💵 Fund Amount (ETH)', 'set:fee:fund')
    .row()
    .text('💸 Creator Fee Wallet', 'set:fee:rec')
    .row()
    .text('📊 Creator Tax (BPS)', 'set:fee:tax')
    .row()
    .text('⬅️ Kembali ke Settings', 'set:menu');
}

export function buildSpeedSettingsKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text('⛽ Gas Price Mult', 'set:spd:gpm')
    .text('📐 Gas Limit Mult', 'set:spd:glm')
    .row()
    .text('⚡ Priority Fee (wei)', 'set:spd:prio')
    .text('🔁 Launch Retries', 'set:spd:retries')
    .row()
    .text('⏱️ Retry Interval', 'set:spd:interval')
    .text('🛡️ Safety Buffer', 'set:spd:buffer')
    .row()
    .text('🏦 Sponsor Reserve', 'set:spd:reserve')
    .text('🔓 Revoke Gas Limit', 'set:spd:revgas')
    .row()
    .text('💸 Fund Gas Limit', 'set:spd:fundgas')
    .text('⏳ Receipt Polling', 'set:spd:poll')
    .row()
    .text('⌛ Receipt Timeout', 'set:spd:timeout')
    .text('↩️ Default Speed', 'set:spd:reset')
    .row()
    .text('⬅️ Kembali ke Settings', 'set:menu');
}

export function buildPinataSettingsKeyboard(hasJwt: boolean): InlineKeyboard {
  const kb = new InlineKeyboard()
    .text(hasJwt ? '🔑 Ganti Pinata JWT' : '🔑 Set Pinata JWT', 'set:pin:jwt')
    .row()
    .text('🌐 Ubah IPFS Gateway', 'set:pin:gw')
    .row();

  if (hasJwt) {
    kb.text('🧪 Tes Autentikasi Pinata', 'set:pin:test')
      .text('🗑️ Hapus JWT', 'set:pin:clear')
      .row();
  }

  kb.text('⬅️ Kembali ke Settings', 'set:menu');
  return kb;
}

export function buildAccessMenuKeyboard(authorizedUsers: AuthorizedUserEntry[]): InlineKeyboard {
  const kb = new InlineKeyboard().text('➕ Tambah User', 'set:access:add').row();

  for (const user of authorizedUsers) {
    const labelSuffix = user.label ? ` (${user.label.slice(0, 14)})` : '';
    kb.text(`🗑️ Hapus ${user.userId}${labelSuffix}`, `set:access:del:${user.userId}`).row();
  }

  if (authorizedUsers.length > 0) {
    kb.text('🧹 Hapus Semua User', 'set:access:clear').row();
  }

  kb.text('⬅️ Kembali ke Settings', 'set:menu');
  return kb;
}

export function buildAccessClearConfirmKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text('✅ Ya, Hapus Semua Non-Owner', 'set:access:clear:confirm')
    .row()
    .text('❌ Batal', 'set:access:menu');
}

export function buildLaunchConfirmKeyboard(confirmId: string): InlineKeyboard {
  return new InlineKeyboard()
    .text('🚀 Konfirmasi & Eksekusi Launch', `launch:exec:${confirmId}`)
    .row()
    .text('🔄 Simulasi Ulang', 'launch:prepare')
    .text('❌ Batal', 'menu:main');
}

export function buildPostSimulationKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text('🚀 Lanjut Konfirmasi Launch', 'launch:prepare')
    .row()
    .text('🔄 Simulasi Ulang', 'launch:sim')
    .text('🏠 Menu Utama', 'menu:main');
}

export function buildBackToMainKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text('🔄 Refresh', 'rpc:check')
    .text('🏠 Menu Utama', 'menu:main');
}

export function buildCancelInputKeyboard(): InlineKeyboard {
  return new InlineKeyboard().text('❌ Batal', 'input:cancel');
}
