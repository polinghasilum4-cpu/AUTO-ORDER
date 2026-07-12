

'use strict';

const sharp  = require('sharp');
const path   = require('path');
const os     = require('os');
const fs     = require('fs');
const config = require('./config.js');

function formatRupiah(n) {
  return 'Rp ' + new Intl.NumberFormat('id-ID').format(Number(n || 0));
}

function nowWIB() {
  return new Date().toLocaleString('id-ID', {
    timeZone : 'Asia/Jakarta',
    day      : '2-digit',
    month    : 'short',
    year     : 'numeric',
    hour     : '2-digit',
    minute   : '2-digit',
  }) + ' WIB';
}

function sensor(str, keepStart = 3, keepEnd = 2) {
  if (!str) return '***';
  const s = String(str);
  if (s.length <= keepStart + keepEnd + 2) return s.slice(0, keepStart) + '***';
  return s.slice(0, keepStart) + '•••' + s.slice(s.length - keepEnd);
}

function sensorPhone(num) {
  const s = String(num || '');
  if (s.length < 6) return '***';
  return s.slice(0, 4) + '****' + s.slice(s.length - 2);
}

function sensorUsername(u) {
  if (!u) return '***';
  const s = u.startsWith('@') ? u.slice(1) : u;
  if (s.length <= 3) return s[0] + '**';
  if (s.length <= 6) return s.slice(0, 2) + '•'.repeat(s.length - 2);
  return s.slice(0, 3) + '•••' + s.slice(-2);
}

function autoSensor(label, value) {
  const l = String(label).toLowerCase();
  if (l.includes('password') || l.includes('pass') || l.includes('pwd'))
    return sensor(String(value), 2, 0);
  if (l.includes('phone') || l.includes('nomor') || l.includes('number'))
    return sensorPhone(value);
  if (l.includes('username') || l.includes('user'))
    return sensorUsername(String(value));
  if (l.includes('session') || l.includes('token') || l.includes('secret'))
    return '••••••••••';
  return String(value);
}

function esc(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/[\u{1F300}-\u{1FFFF}]/gu, '')
    .replace(/[\u2000-\u2BFF]/g, '')
    .trim();
}

const TYPE_CFG = {
  panel    : { label: 'PEMBELIAN PANEL',    color: '#A78BFA' },
  nokos    : { label: 'PEMBELIAN NOKOS',    color: '#F472B6' },
  deposit  : { label: 'DEPOSIT SALDO',      color: '#F59E0B' },
  produk   : { label: 'PEMBELIAN PRODUK',   color: '#06B6D4' },
  reseller : { label: 'PEMBELIAN RESELLER', color: '#10B981' },
};

function buildReceiptSVG(opts = {}) {
  const {
    type          = 'pembelian',
    orderId       = '-',
    product       = null,
    harga         = 0,
    metode        = 'QRIS',
    pembeli       = '-',
    waktu         = nowWIB(),
    sensorInfo    = true,
    botUsername,
    panelUsername = null,   
  } = opts;

  const cfg = TYPE_CFG[type] || { label: 'STRUK TRANSAKSI', color: '#A78BFA' };

  const isGratis    = metode === 'gratis';
  const isSaldo     = !isGratis && (metode.toLowerCase().includes('saldo') || metode.toLowerCase().includes('balance'));
  const metodeLabel = isGratis ? 'Gratis / Reward' : isSaldo ? 'Saldo Bot' : 'QRIS';

  const pembeliDisplay = sensorInfo ? sensorUsername(pembeli) : pembeli;
  const orderShort     = sensorInfo ? sensor(orderId, 6, 4) : orderId;

  const W    = 1280;
  const PAD  = 80;
  const IW   = W - PAD * 2;

  const rows = [];
  if (product) rows.push({ label: 'Produk',   val: esc(product),      accent: false });
  if (panelUsername) rows.push({ label: 'Username Panel', val: esc(sensorInfo ? sensorUsername(panelUsername) : panelUsername), accent: false });
  rows.push({ label: 'Total',    val: formatRupiah(harga),             accent: true  });
  rows.push({ label: 'Metode',   val: esc(metodeLabel),                accent: false });
  rows.push({ label: 'Pembeli',  val: '@' + esc(pembeliDisplay).replace(/^@/,''), accent: false });
  rows.push({ label: 'Waktu',    val: esc(waktu),                      accent: false });
  rows.push({ label: 'Ref',      val: esc(orderShort),                 accent: false, mono: true });

  const HEADER_H  = 220;  
  const BADGE_H   = 100;  
  const DIV_H     = 48;   
  const ROW_H     = 116;  
  const STATUS_H  = 140;  
  const FOOTER_H  = 88;   
  const VPAD      = 48;   

  const H = VPAD + HEADER_H + DIV_H + BADGE_H + DIV_H + rows.length * ROW_H + DIV_H + STATUS_H + FOOTER_H + VPAD;

  const botName = esc((botUsername || config.BOT_USERNAME || 'AlexBOT').replace('@', ''));

  let els = '';

  els += `<defs>
    <linearGradient id="bgGrad" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#0A0A18"/>
      <stop offset="100%" stop-color="#12121F"/>
    </linearGradient>
    <linearGradient id="accentGrad" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0%" stop-color="${cfg.color}00"/>
      <stop offset="35%" stop-color="${cfg.color}CC"/>
      <stop offset="65%" stop-color="${cfg.color}CC"/>
      <stop offset="100%" stop-color="${cfg.color}00"/>
    </linearGradient>
    <linearGradient id="greenGrad" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0%" stop-color="#10B98100"/>
      <stop offset="30%" stop-color="#10B981BB"/>
      <stop offset="70%" stop-color="#10B981BB"/>
      <stop offset="100%" stop-color="#10B98100"/>
    </linearGradient>
    <filter id="glow">
      <feGaussianBlur stdDeviation="3" result="blur"/>
      <feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge>
    </filter>
  </defs>`;

  els += `<rect width="${W}" height="${H}" fill="url(#bgGrad)"/>`;

  for (let dx = PAD; dx < W - PAD; dx += 28)
    for (let dy = 20; dy < H - 20; dy += 28)
      els += `<circle cx="${dx}" cy="${dy}" r="1" fill="#FFFFFF" opacity="0.025"/>`;

  els += `<rect x="8" y="8" width="${W-16}" height="${H-16}" rx="44" fill="none" stroke="${cfg.color}" stroke-width="3" opacity="0.4"/>`;
  els += `<rect x="12" y="12" width="${W-24}" height="${H-24}" rx="40" fill="url(#bgGrad)" opacity="0.98"/>`;

  els += `<rect x="${PAD}" y="16" width="${IW}" height="6" rx="3" fill="url(#accentGrad)"/>`;

  let Y = VPAD + 4;

  els += `<text x="${W/2}" y="${Y+76}" font-family="Arial Black,Arial,sans-serif" font-size="64" font-weight="900" fill="${cfg.color}" text-anchor="middle" letter-spacing="6">${botName.toUpperCase()}</text>`;
  els += `<text x="${W/2}" y="${Y+124}" font-family="Arial,sans-serif" font-size="26" fill="#6B7280" text-anchor="middle" letter-spacing="2">— Official Store —</text>`;
  els += `<line x1="${PAD+80}" y1="${Y+160}" x2="${W-PAD-80}" y2="${Y+160}" stroke="#FFFFFF" stroke-width="1" opacity="0.1"/>`;

  Y += HEADER_H;

  const badgeW = Math.min(IW * 0.65, 640);
  const badgeX = (W - badgeW) / 2;
  els += `<rect x="${badgeX}" y="${Y}" width="${badgeW}" height="${BADGE_H}" rx="${BADGE_H/2}" fill="${cfg.color}22" stroke="${cfg.color}" stroke-width="3"/>`;
  els += `<text x="${W/2}" y="${Y + BADGE_H/2 + 14}" font-family="Arial Black,Arial,sans-serif" font-size="32" font-weight="900" fill="${cfg.color}" text-anchor="middle" letter-spacing="4">${esc(cfg.label)}</text>`;

  Y += BADGE_H + DIV_H;

  els += `<line x1="${PAD}" y1="${Y}" x2="${W-PAD}" y2="${Y}" stroke="${cfg.color}" stroke-width="1" opacity="0.3"/>`;
  Y += DIV_H;

  rows.forEach((r, i) => {
    const rowY = Y + i * ROW_H;
    if (i % 2 === 0)
      els += `<rect x="${PAD}" y="${rowY}" width="${IW}" height="${ROW_H}" rx="0" fill="#FFFFFF05"/>`;

    els += `<text x="${PAD + 20}" y="${rowY + 38}" font-family="Arial,sans-serif" font-size="22" fill="#6B7280" letter-spacing="2">${r.label.toUpperCase()}</text>`;

    const vColor  = r.accent ? '#F59E0B' : '#E5E7EB';
    const vSize   = r.accent ? '52' : '34';
    const vWeight = r.accent ? '900' : '600';
    const vFont   = r.mono ? 'Courier New,monospace' : 'Arial,sans-serif';
    els += `<text x="${W - PAD - 20}" y="${rowY + 90}" font-family="${vFont}" font-size="${vSize}" font-weight="${vWeight}" fill="${vColor}" text-anchor="end">${r.val}</text>`;

    if (r.accent) {
      els += `<line x1="${PAD}" y1="${rowY + ROW_H - 1}" x2="${W-PAD}" y2="${rowY + ROW_H - 1}" stroke="${cfg.color}" stroke-width="1" opacity="0.25"/>`;
    }
  });

  Y += rows.length * ROW_H + DIV_H;

  els += `<rect x="${PAD}" y="${Y}" width="${IW}" height="${STATUS_H}" rx="32" fill="#10B98118" stroke="url(#greenGrad)" stroke-width="3"/>`;
  els += `<circle cx="${PAD + 72}" cy="${Y + STATUS_H/2}" r="36" fill="#10B98125" stroke="#10B981" stroke-width="3"/>`;
  els += `<text x="${PAD + 72}" y="${Y + STATUS_H/2 + 14}" font-family="Arial,sans-serif" font-size="36" font-weight="bold" fill="#6EE7B7" text-anchor="middle">✓</text>`;
  els += `<text x="${PAD + 130}" y="${Y + STATUS_H/2 - 10}" font-family="Arial Black,Arial,sans-serif" font-size="36" font-weight="900" fill="#6EE7B7" letter-spacing="2">PEMBAYARAN BERHASIL</text>`;
  els += `<text x="${PAD + 130}" y="${Y + STATUS_H/2 + 34}" font-family="Arial,sans-serif" font-size="24" fill="#10B981" opacity="0.8">Transaksi telah dikonfirmasi</text>`;

  Y += STATUS_H + 16;

  els += `<text x="${W/2}" y="${Y + 36}" font-family="Arial,sans-serif" font-size="22" fill="#374151" text-anchor="middle">@${botName} · ${esc(nowWIB())}</text>`;

  els += `<rect x="${PAD}" y="${H - 24}" width="${IW}" height="6" rx="3" fill="url(#accentGrad)"/>`;

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" shape-rendering="geometricPrecision" text-rendering="optimizeLegibility">
${els}
</svg>`;
}

async function generateReceiptImage(opts = {}) {
  const svg = buildReceiptSVG(opts);
  return await sharp(Buffer.from(svg)).png().toBuffer();
}

function receiptPanel({ orderId, planKey, harga, metode, pembeli, username, domain, password, isAdmin, botUsername } = {}) {
  const product = isAdmin
    ? 'Admin Panel Pterodactyl'
    : `Panel ${planKey === 'unlimited' ? 'Unlimited' : (planKey || '').toUpperCase()}`;
  return generateReceiptImage({ type: 'panel', orderId, product, harga, metode, pembeli, panelUsername: username || null, sensorInfo: true, botUsername });
}

function receiptNokos({ orderId, nomor, harga, metode, pembeli, tgId, botUsername } = {}) {
  const nomorSensor = sensorPhone(String(nomor || ''));
  const tgIdSensor  = tgId ? sensor(String(tgId), 3, 3) : null;
  const productLabel = tgIdSensor
    ? `+${nomorSensor}  |  ${tgIdSensor}`
    : `Akun Telegram +${nomorSensor}`;
  return generateReceiptImage({
    type: 'nokos', orderId,
    product: productLabel,
    harga, metode, pembeli, sensorInfo: true, botUsername,
  });
}

function receiptDeposit({ orderId, nominal, saldoBaru, metode, pembeli, botUsername } = {}) {
  return generateReceiptImage({
    type: 'deposit', orderId, harga: nominal, metode, pembeli,
    sensorInfo: true, botUsername,
  });
}

function receiptProduk({ orderId, namaProduk, harga, metode, pembeli, botUsername } = {}) {
  return generateReceiptImage({ type: 'produk', orderId, product: namaProduk, harga, metode, pembeli, sensorInfo: true, botUsername });
}

function receiptReseller({ orderId, harga, metode, pembeli, resellerId, botUsername } = {}) {
  return generateReceiptImage({
    type: 'reseller', orderId, product: 'Upgrade Reseller', harga, metode, pembeli,
    sensorInfo: true, botUsername,
  });
}

async function sendReceiptPhoto(bot, chatId, imgBuf, opts = {}) {
  const buf      = Buffer.isBuffer(imgBuf) ? imgBuf : await imgBuf;
  const tmpPath  = path.join(os.tmpdir(), `hkreceipt_${Date.now()}_${Math.random().toString(36).slice(2)}.png`);
  fs.writeFileSync(tmpPath, buf);
  try {
    return await bot.sendPhoto(chatId, tmpPath, opts);
  } finally {
    try { fs.unlinkSync(tmpPath); } catch {}
  }
}

function buildChannelNotif({ type, orderId, product, harga, metode, pembeli, waktu, extra = {}, botUsername } = {}) {
  const typeLabel = {
    panel    : '🖥️ PEMBELIAN PANEL',
    nokos    : '📱 PEMBELIAN NOKOS',
    deposit  : '💰 DEPOSIT SALDO',
    produk   : '🛒 PEMBELIAN PRODUK',
    reseller : '👥 PEMBELIAN RESELLER',
  }[type] || '🧾 TRANSAKSI';

  const isSaldo   = (metode || '').toLowerCase().includes('saldo') || (metode || '').toLowerCase().includes('balance');
  const isGratis  = metode === 'gratis';
  const mEmoji    = isGratis ? '🎁' : isSaldo ? '💳' : '📷';
  const metodeTxt = isGratis ? 'Gratis/Reward' : isSaldo ? 'Saldo Bot' : 'QRIS Atlantic';

  const bname = (botUsername || config.BOT_USERNAME || 'AlexBOT').replace('@', '');
  const wm    = `· @${bname} ·`;

  const parts = [
    `<blockquote>`,
    `<b>✅ ${typeLabel}</b>`,
    `━━━━━━━━━━━━━━━━━━━━`,
  ];

  if (product) parts.push(`📦 <b>Produk :</b> ${product}`);
  parts.push(`💵 <b>Harga  :</b> ${formatRupiah(harga)}`);
  parts.push(`${mEmoji} <b>Metode :</b> ${metodeTxt}`);
  parts.push(`👤 <b>Pembeli:</b> <code>${sensorUsername(pembeli)}</code>`);
  parts.push(`🕐 <b>Waktu  :</b> ${waktu || nowWIB()}`);

  const extraKeys = Object.keys(extra);
  if (extraKeys.length) {
    parts.push(`━━━━━━━━━━━━━━━━━━━━`);
    for (const [label, value] of Object.entries(extra))
      parts.push(`• <b>${label}:</b> ${value}`);
  }

  parts.push(`━━━━━━━━━━━━━━━━━━━━`);
  parts.push(`<i>${wm}</i>`);
  parts.push(`</blockquote>`);

  return parts.join('\n');
}

function beliLagiKeyboard(botUsername) {
  const bname = (botUsername || config.BOT_USERNAME || '').replace('@', '');
  if (!bname) return null;
  return { inline_keyboard: [[{ text: '📞 Beli Lagi', url: `https://t.me/${bname}?start=start` }]] };
}

function buildPrivateDetailText({ type, orderId, product, harga, metode, pembeli, waktu, extra = {}, botUsername } = {}) {
  const isSaldo  = (metode || '').toLowerCase().includes('saldo') || (metode || '').toLowerCase().includes('balance');
  const isGratis = metode === 'gratis';
  const mEmoji   = isGratis ? '🎁' : isSaldo ? '💳' : '📷';
  const metodeTxt= isGratis ? 'Gratis/Reward' : isSaldo ? 'Saldo Bot' : 'QRIS Atlantic';

  const parts = [
    `<b>✨ PEMBAYARAN BERHASIL ✨</b>`,
    ``,
    `<b>> 📋 DETAIL TRANSAKSI</b>`,
    `├ 🆔 <b>ID:</b> <code>${orderId || '-'}</code>`,
    `├ 💵 <b>Total:</b> ${formatRupiah(harga)}`,
    `├ ${mEmoji} <b>Metode:</b> ${metodeTxt}`,
  ];

  if (product) parts.push(`└ 📦 <b>Produk:</b> ${product}`);

  const extraKeys = Object.keys(extra);
  if (extraKeys.length) {
    parts.push(``);
    parts.push(`<b>> 🔑 INFORMASI AKUN ANDA</b>`);
    const entries = Object.entries(extra);
    entries.forEach(([label, value], i) => {
      const isLast = i === entries.length - 1;
      parts.push(`${isLast ? '└' : '├'} ${label}: <code>${value}</code>`);
    });
  }

  parts.push(``);
  parts.push(`🕐 <i>${waktu || nowWIB()}</i>`);

  return parts.join('\n');
}

async function sendChannelReceiptPhoto(bot, channelTarget, imgBufPromise, notifText, replyMarkup) {
  const buf     = Buffer.isBuffer(imgBufPromise) ? imgBufPromise : await imgBufPromise;
  const tmpPath = path.join(os.tmpdir(), `hkchannel_${Date.now()}_${Math.random().toString(36).slice(2)}.png`);
  fs.writeFileSync(tmpPath, buf);
  try {
    return await bot.sendPhoto(channelTarget, tmpPath, {
      caption   : notifText,
      parse_mode: 'HTML',
      ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
    });
  } finally {
    try { fs.unlinkSync(tmpPath); } catch {}
  }
}

module.exports = {
  generateReceiptImage,
  receiptPanel,
  receiptNokos,
  receiptDeposit,
  receiptProduk,
  receiptReseller,

  sendReceiptPhoto,
  sendChannelReceiptPhoto,

  buildChannelNotif,
  buildPrivateDetailText,

  beliLagiKeyboard,

  formatRupiah,
  sensor,
  sensorPhone,
  sensorUsername,
  nowWIB,
};

;(function() {
  const _file = require.resolve(__filename);
  fs.watchFile(_file, { interval: 1000 }, () => {
    try {
      console.log('\x1b[34m>> Hot Reload :\x1b[0m', '\x1b[30m\x1b[47m' + __filename + '\x1b[0m');
      delete require.cache[_file];
      const newModule = require(_file);
      Object.assign(module.exports, newModule);
      console.log('\x1b[32m✅ receipt.js reloaded tanpa restart\x1b[0m');
    } catch(e) {
      console.error('\x1b[31m❌ Hot reload receipt.js gagal:\x1b[0m', e.message);
    }
  });
})();
