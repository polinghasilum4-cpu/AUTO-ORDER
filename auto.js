'use strict';

const TelegramBot        = require('node-telegram-bot-api');
const axios              = require('axios');
const fs                 = require('fs');
const path               = require('path');
const QRCode             = require('qrcode');
const archiver           = require('archiver');
const { TelegramClient } = require('telegram');
const { StringSession }  = require('telegram/sessions');
const { Api }            = require('telegram/tl');

const config         = require('./config');
const db             = require('./db');
const PaymentGateway = require('./payment');
const PterodactylAPI = require('./ptero');
const receipt        = require('./receipt');
const tools          = require('./tools');
const csai           = tools;
const aiscan         = require('./aiscan');
const { cacheGet: aiCacheGet, cacheDelete: aiCacheDelete, sensorDomain: aiSensorDomain, sensorStr: aiSensorStr, buildPageContent: aiBuildPage } = aiscan;

const bot   = new TelegramBot(config.BOT_TOKEN, { polling: true });
const pg    = new PaymentGateway(config, db);
const ptero = new PterodactylAPI();

function B(s) {
  const map = {
    A:'𝗔',B:'𝗕',C:'𝗖',D:'𝗗',E:'𝗘',F:'𝗙',G:'𝗚',H:'𝗛',I:'𝗜',J:'𝗝',K:'𝗞',L:'𝗟',M:'𝗠',
    N:'𝗡',O:'𝗢',P:'𝗣',Q:'𝗤',R:'𝗥',S:'𝗦',T:'𝗧',U:'𝗨',V:'𝗩',W:'𝗪',X:'𝗫',Y:'𝗬',Z:'𝗭',
    a:'𝗮',b:'𝗯',c:'𝗰',d:'𝗱',e:'𝗲',f:'𝗳',g:'𝗴',h:'𝗵',i:'𝗶',j:'𝗷',k:'𝗸',l:'𝗹',m:'𝗺',
    n:'𝗻',o:'𝗼',p:'𝗽',q:'𝗾',r:'𝗿',s:'𝘀',t:'𝘁',u:'𝘂',v:'𝘃',w:'𝘄',x:'𝗅',y:'𝘆',z:'𝘇',
    '0':'𝟬','1':'𝟭','2':'𝟮','3':'𝟯','4':'𝟰','5':'𝟱','6':'𝟲','7':'𝟳','8':'𝟴','9':'𝟵',
    ' ':' ',
  };
  return String(s).split('').map(c => map[c]||c).join('');
}

const fmt    = n  => Number(n||0).toLocaleString('id-ID');
const _errMsg = e => {
  if (e instanceof AggregateError)
    return e.errors?.map(x => x.message || String(x)).join('; ') || e.message || 'AggregateError';
  return e?.response?.data ? JSON.stringify(e.response.data) : (e?.message || String(e));
};
const genId  = () => `ORD-${Date.now()}-${Math.random().toString(36).slice(2,6).toUpperCase()}`;
const isOwner= id => Number(id) === Number(config.OWNER_ID);
const escH   = s  => String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');

const RESET='\x1b[0m', BOLD='\x1b[1m', DIM='\x1b[2m';
const GREEN='\x1b[32m', RED='\x1b[31m', YELLOW='\x1b[33m', CYAN='\x1b[36m', MAGENTA='\x1b[35m', BLUE='\x1b[34m', WHITE='\x1b[37m';
function tsNow() { return new Date().toLocaleTimeString('id-ID',{hour:'2-digit',minute:'2-digit',second:'2-digit'}); }
const log = {
  ok  : (...a) => console.log(`${DIM}[${tsNow()}]${RESET} ${BOLD}${GREEN}✔ OK   ${RESET}`, ...a),
  err : (...a) => console.error(`${DIM}[${tsNow()}]${RESET} ${BOLD}${RED}✖ ERR  ${RESET}`, ...a),
  warn: (...a) => console.warn(`${DIM}[${tsNow()}]${RESET} ${BOLD}${YELLOW}⚠ WARN ${RESET}`, ...a),
  info: (...a) => console.log(`${DIM}[${tsNow()}]${RESET} ${BOLD}${CYAN}ℹ INFO ${RESET}`, ...a),
  sale: (...a) => console.log(`${DIM}[${tsNow()}]${RESET} ${BOLD}${MAGENTA}💰 SALE ${RESET}`, ...a),
  bcast:(...a) => console.log(`${DIM}[${tsNow()}]${RESET} ${BOLD}${BLUE}📢 BC  ${RESET}`, ...a),
};

function sensorSensitive(str) {
  if (!str) return str;
  return String(str)
    .replace(/\d{8,12}:[A-Za-z0-9_-]{30,}/g, '***:***TOKEN***')
    .replace(/(\+?62|08)\d{6,}/g, m => m.slice(0,4)+'****'+m.slice(-2))
    .replace(/[A-Za-z0-9]{40,}/g, m => m.slice(0,6)+'***'+m.slice(-4))
    .replace(/(password|passwd|pwd|secret)\s*[:=]\s*\S+/gi, '$1: ***SENSOR***')
    .replace(/1[A-Za-z0-9+/=]{200,}/g, '***SESSION_STRING***');
}

async function notifyOwnerError(ctx, err, userId=null) {
  const safeMsg = sensorSensitive(err?.message || String(err)).slice(0, 300);
  const safeCtx = sensorSensitive(ctx);
  const errMsg =
    `🚨 <b>ERROR!</b>\n`+
    `━━━━━━━━━━━━━━━━━━━━\n`+
    `🔧 <code>${escH(safeCtx)}</code>\n`+
    `❌ ${escH(safeMsg)}\n`+
    (userId ? `👤 User: <code>${userId}</code>\n` : '')+
    `🕐 ${new Date().toLocaleString('id-ID',{timeZone:'Asia/Jakarta'})} WIB`;
  try { await bot.sendMessage(config.OWNER_ID, errMsg, { parse_mode:'HTML' }); } catch {}
}

async function tryDel(chatId, msgId) { try { await bot.deleteMessage(chatId, msgId); } catch {} }
async function answerCb(id, txt='', alert=false) { try { await bot.answerCallbackQuery(id,{text:txt,show_alert:alert}); } catch {} }

async function editOrReplace(chatId, msgId, text, opts = {}) {
  if (msgId) {
    try {
      if (opts._isCaption) {
        return await bot.editMessageCaption(text, {
          chat_id: chatId, message_id: msgId,
          parse_mode: 'HTML', reply_markup: opts.reply_markup
        });
      }
      return await bot.editMessageText(text, { chat_id:chatId, message_id:msgId, ...opts });
    } catch {
      await tryDel(chatId, msgId);
    }
  }
  if (opts._photo) {
    return bot.sendPhoto(chatId, opts._photo, {
      caption: text, parse_mode: opts.parse_mode||'HTML', reply_markup: opts.reply_markup
    });
  }
  return bot.sendMessage(chatId, text, opts);
}

async function genQrBuf(text) {
  try { return await QRCode.toBuffer(text, { type:'png', width:400, margin:2 }); } catch { return null; }
}

const activeSessions      = new Map();
const userStates          = new Map();
const activeNokosClients  = new Map();
const activeAddClients    = new Map();

async function checkJoins(userId) {
  const list = db.getRequiredJoins();
  if (!list.length) return { ok: true, missing: [] };
  const missing = [];
  for (const r of list) {
    try {
      const m = await bot.getChatMember(`@${r.username}`, userId);
      if (!['member','administrator','creator'].includes(m.status)) missing.push(r);
    } catch { missing.push(r); }
  }
  return { ok: !missing.length, missing };
}

async function enforceJoin(chatId, userId) {
  const { ok, missing } = await checkJoins(userId);
  if (ok) return true;
  const btns = missing.map(r => ([{ text: `${r.type==='ch'?'📢':'👥'} ${B('Join')} ${r.name}`, url:`https://t.me/${r.username}`, style: 'primary' }]));
  btns.push([{ text: B('✅ Sudah Join — Cek Ulang'), callback_data:'CHECK_JOIN', style: 'success' }]);
  await bot.sendMessage(chatId,
    `⚠️ <b>Kamu harus join dulu:</b>\n\n`+missing.map(r=>`• ${r.type==='ch'?'📢 Channel':'👥 Group'}: @${r.username} — <b>${escH(r.name)}</b>`).join('\n'),
    { parse_mode:'HTML', reply_markup:{ inline_keyboard: btns } }
  );
  return false;
}

async function notifNewUser(from) {
  const ch = config.NOTIF_CHANNEL;
  if (!ch) return;
  const uname = from.username ? `@${from.username}` : '-';
  const cap = `👋 <b>${B('User Baru Masuk')}</b>\n\n${B('Username')} : ${escH(uname)}\n${B('ID')}       : <code>${from.id}</code>`;
  const me  = await bot.getMe().catch(()=>({ username: '' }));
  const kb  = { inline_keyboard:[[{ text: B('🛒 Order Layanan'), url:`https://t.me/${me.username}?start=start`, style: 'primary' }]] };
  try {
    if (config.NEW_USER_FOTO) await bot.sendPhoto(ch, config.NEW_USER_FOTO, { caption: cap, parse_mode:'HTML', reply_markup: kb });
    else await bot.sendMessage(ch, cap, { parse_mode:'HTML', reply_markup: kb });
  } catch(e) { log.warn('notifNewUser:', e.message); }
}

async function sendChannelReceipt(imgPromise, notifText) {
  const ch = config.NOTIF_CHANNEL;
  if (!ch) return;
  try {
    const me = await bot.getMe().catch(()=>({ username:'' }));
    const kb = receipt.beliLagiKeyboard(me.username);
    // Tambahkan style ke kb receipt jika perlu
    await receipt.sendChannelReceiptPhoto(bot, ch, imgPromise, notifText, kb);
  } catch(e) { log.warn('sendChannelReceipt:', e.message); }
}

async function cancelSession(userId) {
  const s = activeSessions.get(userId);
  if (!s) return;
  clearTimeout(s.expTimer);
  try { await pg.cancel({ orderId: s.orderId, amount: s.amount, atlanticId: s.pgId }); } catch {}
  if (s.msgId) await tryDel(s.chatId, s.msgId);
  db.deleteTx(s.orderId);
  activeSessions.delete(userId);
  userStates.delete(userId);
}

const TAGLINE = [
  `✨ ${B('Layanan terpercaya & cepat')}`,
  `⚡ ${B('Proses otomatis 24/7')}`,
  `💎 ${B('Harga terjangkau & kompetitif')}`,
  `🔒 ${B('Aman & bergaransi')}`,
];

async function sendMainMenu(chatId, from, delMsgId=null) {
  const bal  = fmt(db.getBalance(from.id));
  const text =
    `🛍️ <b>${B('AUTO ORDER')}</b>\n\n`+
    `👤 ${B('Halo')}, <b>${escH(from.first_name)}</b>!\n`+
    `💰 ${B('Saldo')}: <b>Rp${bal}</b>\n\n`+
    TAGLINE.join('\n');
  const ownerLink = config.OWNER_USERNAME
    ? `https://t.me/${config.OWNER_USERNAME.replace('@','')}`
    : `https://t.me/${config.OWNER_ID}`;
  const kb = { inline_keyboard: [
    [{ text: B('🛒 Layanan'), callback_data:'LAYANAN_MENU', style: 'primary' }, { text: B('💰 Deposit'), callback_data:'DEPOSIT_MENU', style: 'primary' }],
    [{ text: B('📜 Panduan'), callback_data:'PANDUAN', style: 'primary' },      { text: B('📢 Channel'), url:`https://t.me/${(config.NOTIF_CHANNEL||'').replace('@','')}`, style: 'success' }],
    [{ text: B('🤖 CS AI (BETA)'), callback_data:'CSAI_START', style: 'primary' }, { text: B('📦 Panel Saya'), callback_data:'MYPANEL:0', style: 'primary' }],
    [{ text: B('📞 Contact Owner'), url: ownerLink, style: 'success' }],
    ...(isOwner(from.id) ? [[{ text: B('👑 Owner Panel'), callback_data:'OWNER_PANEL', style: 'danger' }]] : [])
  ]};
  const opts = { parse_mode:'HTML', reply_markup: kb };
  if (delMsgId) await tryDel(chatId, delMsgId);
  if (config.START_FOTO) return bot.sendPhoto(chatId, config.START_FOTO, { caption: text, ...opts });
  return bot.sendMessage(chatId, text, opts);
}

async function sendLayananMenu(chatId, from, delMsgId=null) {
  const nokosStok = db.countNokos();
  const text =
    `📱 <b>${B('MENU LAYANAN')}</b>\n\n`+
    TAGLINE.join('\n')+
    `\n\n👤 ${B('Halo')}, <b>${escH(from.first_name)}</b>! Silakan pilih layanan:\n`+
    `📱 ${B('Nokos')} — Stok: <b>${nokosStok}</b> akun`;
  const kb = { inline_keyboard: [
    [{ text: B('📱 Nokos'),    callback_data:'MENU_NOKOS', style: 'primary' }, { text: B('📂 Script'),    callback_data:'ORDER_SCRIPT', style: 'primary' }],
    [{ text: B('🤝 Reseller'), callback_data:'MENU_RESELLER', style: 'success' }, { text: B('🛠️ Admin'),    callback_data:'MENU_ADMIN', style: 'success' }],
    [{ text: B('📡 Panel'),    callback_data:'MENU_PANEL', style: 'primary' }],
    [{ text: B('⬅️ Kembali'), callback_data:'MAIN_MENU', style: 'danger' }]
  ]};
  const opts = { parse_mode:'HTML', reply_markup: kb };
  if (delMsgId) await tryDel(chatId, delMsgId);
  if (config.START_FOTO) return bot.sendPhoto(chatId, config.START_FOTO, { caption: text, ...opts });
  return bot.sendMessage(chatId, text, opts);
}

async function sendPanduan(chatId, delMsgId=null) {
  const text =
    `📜 <b>${B('PANDUAN PEMBELIAN')}</b>\n\n`+
    `1️⃣ ${B('Deposit')} saldo via menu Deposit\n`+
    `2️⃣ ${B('Pilih')} layanan yang diinginkan\n`+
    `3️⃣ ${B('Konfirmasi')} & tunggu proses\n\n`+
    `💡 Deposit via QRIS — timeout <b>10 menit</b>\n`+
    `📞 Hubungi owner jika ada masalah`;
  const kb = { inline_keyboard: [[{ text: B('⬅️ Kembali'), callback_data:'MAIN_MENU', style: 'danger' }]] };
  if (delMsgId) await tryDel(chatId, delMsgId);
  return bot.sendMessage(chatId, text, { parse_mode:'HTML', reply_markup:kb });
}

async function sendOwnerPanel(chatId, delMsgId=null) {
  const gw         = db.getPaymentGateway();
  const resellerOn = db.getSetting('reseller_enabled') !== false;
  const adminOn    = db.getSetting('admin_enabled')    !== false;
  const maintOn    = db.getMaintenance();
  const qrisManual = db.getQrisManual();

  const gwLabel = gw === 'pakasir' ? '🟡 Pakasir' : gw === 'manual' ? '🔵 Manual QRIS' : '🟢 AtlanticH2H';

  const text =
    `👑 <b>${B('OWNER PANEL')}</b>\n\n`+
    `💳 ${B('Gateway')}: <b>${gwLabel}</b>${gw==='manual'&&!qrisManual.file_id?' ⚠️ <i>QRIS belum diset!</i>':''}\n`+
    `🔧 ${B('Maintenance')}: <b>${maintOn ? '🔴 ON' : '🟢 OFF'}</b>\n`+
    `🤝 ${B('Reseller')}: <b>${resellerOn ? '✅ Aktif' : '❌ Nonaktif'}</b>\n`+
    `🛠️ ${B('Admin Panel')}: <b>${adminOn ? '✅ Aktif' : '❌ Nonaktif'}</b>\n`+
    `👥 ${B('Users')}: <b>${db.getAllUsers().length}</b>\n`+
    `📱 ${B('Nokos Stok')}: <b>${db.countNokos()}</b>\n`+
    `🖼️ ${B('QRIS Manual')}: <b>${qrisManual.file_id ? '✅ Sudah diset' : '❌ Belum diset'}</b>`;

  const kb = { inline_keyboard: [
    [{ text: B(`🔄 Ganti Gateway (${gwLabel})`), callback_data:'SWITCH_GW', style: 'primary' }],
    [{ text: B(maintOn?'🟢 Matikan Maintenance':'🔴 Aktifkan Maintenance'), callback_data:'TOGGLE_MAINTENANCE', style: 'danger' }],
    [{ text: B(resellerOn?'❌ Nonaktifkan Reseller':'✅ Aktifkan Reseller'), callback_data:'TOGGLE_RESELLER', style: 'success' },
     { text: B(adminOn?'❌ Nonaktifkan Admin':'✅ Aktifkan Admin'),           callback_data:'TOGGLE_ADMIN', style: 'success' }],
    [{ text: B('💰 Setharga Panel'), callback_data:'OWNER_SETHARGA_MENU', style: 'primary' }],
    [{ text: B('📋 List Req Join'), callback_data:'LIST_REQ', style: 'primary' }, { text: B('📡 List Server'), callback_data:'LIST_SERVER', style: 'primary' }],
    [{ text: B('💾 Backup DB'),     callback_data:'BACKUP_DB', style: 'success' },{ text: B('📊 Statistik'),   callback_data:'OWNER_STATS', style: 'success' }],
    [{ text: B('⬅️ Kembali'),      callback_data:'MAIN_MENU', style: 'danger' }]
  ]};
  if (delMsgId) await tryDel(chatId, delMsgId);
  return bot.sendMessage(chatId, text, { parse_mode:'HTML', reply_markup:kb });
}

async function sendDepositMenu(chatId, userId, delMsgId=null) {

  if (activeSessions.has(userId)) {
    const existing = activeSessions.get(userId);
    const pesan =
      `⚠️ <b>${B('TRANSAKSI AKTIF')}</b>\n\n`+
      `Kamu masih punya transaksi deposit yang belum selesai!\n\n`+
      `🆔 Order: <code>${existing.orderId}</code>\n`+
      `💰 Nominal: <b>Rp${fmt(existing.amount)}</b>\n\n`+
      `Selesaikan dulu atau ketik /bataltrx untuk membatalkan.`;
    const kb = { inline_keyboard: [
      [{ text: B('🔍 Cek Pembayaran'), callback_data:`CEK_BAYAR:${existing.orderId}`, style: 'success' }],
      [{ text: B('❌ Batalkan Transaksi'), callback_data:`CANCEL_DEPOSIT:${existing.orderId}`, style: 'danger' }],
      [{ text: B('⬅️ Kembali'), callback_data:'MAIN_MENU', style: 'danger' }]
    ]};
    if (delMsgId) await tryDel(chatId, delMsgId);
    return bot.sendMessage(chatId, pesan, { parse_mode:'HTML', reply_markup:kb });
  }

  const text =
    `💰 <b>${B('DEPOSIT SALDO')}</b>\n\n`+
    `${B('Min')}: Rp${fmt(config.MIN_DEPOSIT)} | ${B('Max')}: Rp${fmt(config.MAX_DEPOSIT)}\n\n`+
    `Ketik jumlah deposit:`;
  const kb = { inline_keyboard:[[{ text: B('❌ Batal'), callback_data:'MAIN_MENU', style: 'danger' }]] };
  if (delMsgId) await tryDel(chatId, delMsgId);
  userStates.delete(userId);
  const m = await bot.sendMessage(chatId, text, { parse_mode:'HTML', reply_markup:kb });
  userStates.set(userId, { state:'WAITING_DEPOSIT', msgId: m.message_id });
}

async function processDeposit(chatId, userId, from, amountStr) {
  const amount = parseInt(String(amountStr).replace(/\D/g,''));
  const st     = userStates.get(userId);
  if (st?.msgId) await tryDel(chatId, st.msgId);
  userStates.delete(userId);

  if (isNaN(amount)||amount < config.MIN_DEPOSIT)
    return bot.sendMessage(chatId, `❌ ${B('Minimal deposit')} Rp${fmt(config.MIN_DEPOSIT)}`);
  if (amount > config.MAX_DEPOSIT)
    return bot.sendMessage(chatId, `❌ ${B('Maksimal deposit')} Rp${fmt(config.MAX_DEPOSIT)}`);

  const fee        = parseInt(config.DEPOSIT_FEE) || 0;
  const totalBayar = amount + fee;
  const orderId    = genId();

  if (db.getPaymentGateway() === 'manual') {
    const qrisManual = db.getQrisManual();
    if (!qrisManual.file_id) {
      return bot.sendMessage(chatId, `❌ QRIS Manual belum diset oleh owner. Hubungi owner.`, { parse_mode:'HTML' });
    }
    const cap =
      `💳 <b>${B('DEPOSIT MANUAL QRIS')}</b>\n\n`+
      `💰 ${B('Nominal')}: <b>Rp${fmt(amount)}</b>\n`+
      (fee > 0 ? `💸 ${B('Biaya Admin')}: <b>Rp${fmt(fee)}</b>\n`+
                 `💳 ${B('Total Bayar')}: <b>Rp${fmt(totalBayar)}</b>\n` : '')+
      `🏦 ${B('Gateway')}: <b>Manual QRIS</b>\n`+
      `🆔 ${B('Order')}: <code>${orderId}</code>\n\n`+
      `📌 Bayar sesuai total di atas, dan jangan lupa screenshot bukti pembayaran SS DETAIL WOYYY.\n`+
      `Jika sudah bayar, klik tombol <b>Cek Pembayaran</b>.`;
    const kb = { inline_keyboard: [
      [{ text: B('🔍 Cek Pembayaran'), callback_data:`MANUAL_CHECK:${orderId}` }],
      [{ text: B('❌ Batalkan'),        callback_data:`MANUAL_CANCEL:${orderId}` }]
    ]};
    const sentMsg = await bot.sendPhoto(chatId, qrisManual.file_id, { caption: cap, parse_mode:'HTML', reply_markup: kb });
    const sess = { userId, chatId, orderId, amount, totalBayar, pgId: null, msgId: sentMsg.message_id, isManual: true };
    activeSessions.set(userId, sess);
    db.saveTx({ order_id: orderId, user_id: userId, amount, variant:'deposit', status:'pending', pg_id: null, is_manual: true });
    return;
  }

  
  const loadMsg = await bot.sendMessage(chatId, `⏳ ${B('Membuat QRIS...')}`);
  try {
    const result = await pg.createQris({ amount: totalBayar, orderId });
    await tryDel(chatId, loadMsg.message_id);
    const qrBuf  = await genQrBuf(result.qr_string);
    const gwName = pg.getName();
    const cap =
      `💳 <b>${B('DEPOSIT QRIS')}</b>\n\n`+
      `💰 ${B('Nominal')}: <b>Rp${fmt(amount)}</b>\n`+
      (fee > 0 ? `💸 ${B('Biaya Admin')}: <b>Rp${fmt(fee)}</b>\n`+
                 `💳 ${B('Total Bayar')}: <b>Rp${fmt(totalBayar)}</b>\n` : '')+
      `🏦 ${B('Gateway')}: <b>${gwName}</b>\n`+
      `🆔 ${B('Order')}: <code>${orderId}</code>\n\n`+
      `⏱️ Bayar dalam <b>10 menit</b>\n`+
      `Setelah bayar tekan tombol ${B('Cek Pembayaran')}`;
    const kb = { inline_keyboard: [
      [{ text: B('🔍 Cek Pembayaran'), callback_data:`CEK_BAYAR:${orderId}` }],
      [{ text: B('❌ Batalkan'),        callback_data:`CANCEL_DEPOSIT:${orderId}` }]
    ]};

    let sentMsg;
    if (qrBuf) sentMsg = await bot.sendPhoto(chatId, qrBuf, { caption: cap, parse_mode:'HTML', reply_markup: kb });
    else        sentMsg = await bot.sendMessage(chatId, cap+`\n\n<code>${result.qr_string}</code>`, { parse_mode:'HTML', reply_markup: kb });

    const sess = { userId, chatId, orderId, amount, totalBayar, pgId: result.id, msgId: sentMsg.message_id };
    activeSessions.set(userId, sess);
    db.saveTx({ order_id: orderId, user_id: userId, amount, variant:'deposit', status:'pending', pg_id: result.id });

    const expTimer = setTimeout(async () => {
      if (activeSessions.get(userId)?.orderId !== orderId) return;
      await cancelSession(userId);
      try { await bot.sendMessage(chatId, `⏰ <b>Deposit expired!</b>\nOrder <code>${orderId}</code> habis waktu.`, { parse_mode:'HTML' }); } catch {}
    }, config.DEPOSIT_TIMEOUT);
    activeSessions.get(userId).expTimer = expTimer;

  } catch(err) {
    log.err('processDeposit:', err.message);
    await tryDel(chatId, loadMsg.message_id);
    await bot.sendMessage(chatId, `❌ Gagal buat QRIS: ${escH(err.message)}`);
    await notifyOwnerError('processDeposit', err, userId);
  }
}

async function cekPembayaran(chatId, userId, from, orderId, cbId) {
  const sess = activeSessions.get(userId);
  if (!sess || sess.orderId !== orderId) {
    await answerCb(cbId, '❌ Sesi tidak ditemukan.', true); return;
  }
  await answerCb(cbId, '⏳ Mengecek...');
  try {
    const checkAmount = sess.totalBayar || sess.amount;
    const r = await pg.checkStatus({ id: sess.pgId, orderId, amount: checkAmount });
    if (r.status === 'completed') {
      clearTimeout(sess.expTimer);
      const qrMsgId = sess.msgId;
      activeSessions.delete(userId);
      db.updateTx(orderId, { status:'completed' });
      db.addBalance(userId, sess.amount);

      const uname = from.username || from.first_name || String(userId);
      const successText =
        `✅ <b>${B('PEMBAYARAN DITERIMA!')}</b>\n\n`+
        `🆔 Order: <code>${orderId}</code>\n`+
        `💰 Nominal: <b>Rp${fmt(sess.amount)}</b>\n`+
        `💳 Saldo baru: <b>Rp${fmt(db.getBalance(userId))}</b>\n\n`+
        `Terima kasih sudah top up! 🎉`;
      const successKb = { inline_keyboard:[[{ text: B('🛒 Belanja Sekarang'), callback_data:'LAYANAN_MENU' },{ text: B('🏠 Menu'), callback_data:'MAIN_MENU' }]] };
      try { await bot.editMessageCaption(successText, { chat_id:chatId, message_id:qrMsgId, parse_mode:'HTML', reply_markup:successKb }); }
      catch { try { await bot.editMessageText(successText, { chat_id:chatId, message_id:qrMsgId, parse_mode:'HTML', reply_markup:successKb }); } catch {
        await bot.sendMessage(chatId, successText, { parse_mode:'HTML', reply_markup:successKb });
      }}

      const imgP  = receipt.receiptDeposit({ orderId, nominal: sess.amount, metode:'qris', pembeli: uname, botUsername: config.BOT_USERNAME });
      const notif = receipt.buildChannelNotif({ type:'deposit', orderId, harga: sess.amount, metode:'qris', pembeli: uname, botUsername: config.BOT_USERNAME });
      sendChannelReceipt(imgP, notif);

    } else if (['cancelled','expired','failed'].includes(r.status)) {
      const qrMsgId = sess.msgId;
      await cancelSession(userId);
      const failText = `❌ <b>Transaksi ${r.status}.</b>\n\nSilakan coba deposit ulang.`;
      const failKb   = { inline_keyboard:[[{ text: B('💰 Deposit Ulang'), callback_data:'DEPOSIT_MENU' },{ text: B('🏠 Menu'), callback_data:'MAIN_MENU' }]] };
      try { await bot.editMessageCaption(failText, { chat_id:chatId, message_id:qrMsgId, parse_mode:'HTML', reply_markup:failKb }); }
      catch { try { await bot.editMessageText(failText, { chat_id:chatId, message_id:qrMsgId, parse_mode:'HTML', reply_markup:failKb }); } catch {
        await bot.sendMessage(chatId, failText, { parse_mode:'HTML', reply_markup:failKb });
      }}
    } else {
      await answerCb(cbId, '⏳ Pembayaran belum diterima, coba lagi.', true);
    }
  } catch(err) {
    log.err('cekPembayaran:', err.message);
    await answerCb(cbId, '❌ Gagal cek status, coba lagi.', true);
    await notifyOwnerError('cekPembayaran', err, userId);
  }
}
function extractOTP(msg) {
  if (!msg) return null;
  let m = msg.match(/(?:login code|kode login|verification code|kode verifikasi)[^\d]*(\d{5,6})/i);
  if (m) return m[1];
  if (msg.length < 80) { m = msg.match(/\b(\d{5,6})\b/); if (m) return m[1]; }
  return null;
}

function sensorNomor(n) {
  const s = String(n||'');
  if (s.length <= 6) return s.slice(0,2)+'***';
  return s.slice(0,4) + '•'.repeat(Math.max(3, s.length-6)) + s.slice(-2);
}

async function sendNokosMenu(chatId, from, delMsgId=null) {
  const stok   = db.countNokos();
  const sold   = db.countNokosSold();
  const groups = db.getNokosGroupedByTgId();
  const text =
    `📱 <b>${B('NOKOS STORE')}</b>\n\n`+
    `📦 ${B('Stok tersedia')}: <b>${stok} Akun</b>\n`+
    `✅ ${B('Terjual')}: <b>${sold} Akun</b>\n\n`+
    `${B('Keunggulan Nokos:')}\n`+
    `├ 📱 Akun Telegram asli & aktif\n`+
    `├ 🔑 OTP otomatis dikirim ke kamu\n`+
    `├ 🔒 Aman & bergaransi\n`+
    `└ ⚡ Proses instan setelah bayar\n\n`+
    `Pilih ${B('Daftar ID')}:`;

  const row1 = groups.slice(0,4).map(g=>({
    text: `${B('ID')} ${g.prefix} (${g.count})`,
    callback_data: `NOKOS_GROUP:${g.prefix}`
  }));
  const row2 = groups.slice(4,8).map(g=>({
    text: `${B('ID')} ${g.prefix} (${g.count})`,
    callback_data: `NOKOS_GROUP:${g.prefix}`
  }));
  const kb = { inline_keyboard: [
    row1,
    row2,
    [{ text: B('⬅️ Kembali'), callback_data:'LAYANAN_MENU' }]
  ]};
  if (delMsgId) await tryDel(chatId, delMsgId);
  return bot.sendMessage(chatId, text, { parse_mode:'HTML', reply_markup:kb });
}

function sensorTgId(id) {
  const s = String(id||'');
  if (s.length <= 5) return s.slice(0,2)+'***';
  return s.slice(0,3) + '•'.repeat(Math.max(3, s.length-5)) + s.slice(-3);
}

async function sendNokosGroupPage(chatId, from, prefix, page=0, delMsgId=null) {
  const list = db.getNokosAvailableByPrefix(prefix);
  if (!list.length) {
    const text = `❌ ${B('Stok ID')} ${prefix} habis!`;
    const kb   = { inline_keyboard:[[{ text: B('⬅️ Kembali'), callback_data:'MENU_NOKOS' }]] };
  if (delMsgId) await tryDel(chatId, delMsgId);
  return bot.sendMessage(chatId, text, { parse_mode:'HTML', reply_markup:kb });
  }
  const PER_PAGE = 8;
  const total    = list.length;
  const pages    = Math.ceil(total/PER_PAGE);
  const slice    = list.slice(page*PER_PAGE, page*PER_PAGE+PER_PAGE);

  const listLines = slice.map((n,i) =>
    `${page*PER_PAGE+i+1}. <code>${sensorNomor(n.number)}</code>  |  ID: <code>${sensorTgId(n.tg_id)}</code>  — Rp${fmt(n.price)}`
  ).join('\n');

  const text =
    `📋 <b>${B(`DAFTAR AKUN ID ${prefix}`)}</b>\n`+
    `${B('Halaman')} ${page+1}/${pages}\n\n`+
    listLines;

  const rows = slice.map(n => ([{
    text: `Beli ${sensorNomor(n.number)} | ${sensorTgId(n.tg_id)} — Rp${fmt(n.price)}`,
    callback_data: `NOKOS_BUY:${n.id}`
  }]));
  const nav = [];
  if (page > 0)       nav.push({ text: B('◀️ Prev'), callback_data:`NOKOS_GPAGE:${prefix}:${page-1}` });
  if (page < pages-1) nav.push({ text: B('Next ▶️'), callback_data:`NOKOS_GPAGE:${prefix}:${page+1}` });
  if (nav.length) rows.push(nav);
  rows.push([{ text: B('🏠 Home'), callback_data:'MAIN_MENU' }]);
  rows.push([{ text: B('« Kembali ke Daftar ID'), callback_data:'MENU_NOKOS' }]);

  const kb = { inline_keyboard: rows };
  if (delMsgId) await tryDel(chatId, delMsgId);
  return bot.sendMessage(chatId, text, { parse_mode:'HTML', reply_markup:kb });
}

async function handleNokosBuy(chatId, userId, from, nokosId, cbId, msgId) {
  const n = db.getNokosById(nokosId);
  if (!n || n.status !== 'available') {
    await answerCb(cbId, '❌ Akun tidak tersedia.', true); return;
  }
  const bal  = db.getBalance(userId);
  const text =
    `📱 <b>${B('KONFIRMASI PEMBELIAN NOKOS')}</b>\n\n`+
    `📞 ${B('Nomor')}: <code>${sensorNomor(n.number)}</code>\n`+
    `🆔 ${B('ID Akun')}: <code>${sensorTgId(n.tg_id)}</code>\n`+
    `💰 ${B('Harga')}: <b>Rp${fmt(n.price)}</b>\n`+
    `💳 ${B('Saldo kamu')}: <b>Rp${fmt(bal)}</b>\n`+
    `💳 ${B('Sisa saldo')}: <b>Rp${fmt(Math.max(0,bal-n.price))}</b>\n\n`+
    (bal >= n.price
      ? `✅ ${B('Konfirmasi pembelian?')}`
      : `❌ ${B('Saldo tidak cukup.')}\nKurang: Rp${fmt(n.price-bal)}`);
  const kb = { inline_keyboard: [
    ...(bal >= n.price
      ? [[{ text: B('✅ Ya, Beli Sekarang'), callback_data:`NOKOS_CONFIRM:${nokosId}` }]]
      : [[{ text: B('💰 Deposit Saldo'), callback_data:'DEPOSIT_MENU' }]]),
    [{ text: B('⬅️ Kembali'), callback_data:`NOKOS_GROUP:${String(n.tg_id||'0')[0]}` }]
  ]};
  await answerCb(cbId);
  return editOrReplace(chatId, msgId, text, { parse_mode:'HTML', reply_markup:kb });
}

async function handleNokosConfirm(chatId, userId, from, nokosId, cbId) {
  const n   = db.getNokosById(nokosId);
  if (!n || n.status !== 'available') {
    await answerCb(cbId, '❌ Akun sudah terjual.', true); return;
  }
  if (!db.reserveNokos(nokosId)) {
    await answerCb(cbId, '❌ Akun tidak tersedia.', true); return;
  }
  const ok = db.deductBalance(userId, n.price);
  if (!ok) {
    db.setNokosStatus(nokosId, 'available');
    await answerCb(cbId, '❌ Saldo tidak cukup.', true); return;
  }
  db.setNokosStatus(nokosId, 'sold');
  const orderId = genId();
  db.saveTx({ order_id: orderId, user_id: userId, amount: n.price, variant:'nokos', status:'completed', nokos_id: nokosId });
  await answerCb(cbId);

  const uname = from.username || from.first_name || String(userId);

  const infoLines = [
    `✅ <b>${B('PEMBELIAN NOKOS BERHASIL')}</b>\n`,
    `📱 <b>${B('Nomor Asli')}:</b> <code>${n.number}</code>`,
    n.v2l ? `🔑 <b>${B('V2L / Password')}:</b> <code>${n.v2l}</code>` : null,
    `💰 <b>${B('Harga')}:</b> Rp${fmt(n.price)}`,
    `🆔 <b>${B('Order')}:</b> <code>${orderId}</code>`,
    n.session_string
      ? `\n📲 <b>${B('Cara Login')}:</b> Buka Telegram → Login → masukkan nomor di atas\nBot otomatis kirim OTP — tinggal tunggu!\n⚠️ <i>Jangan share ke siapapun</i>`
      : `\n⚠️ Login manual. Hubungi admin jika perlu bantuan.`,
  ].filter(Boolean).join('\n');
  const detailKb = { inline_keyboard: [
    ...(n.session_string ? [[{ text: B('🚪 Logout Bot'), callback_data:`NOKOS_LOGOUT:${nokosId}` }]] : []),
    [{ text: B('🏠 Menu Utama'), callback_data:'MAIN_MENU' }]
  ]};
  await bot.sendMessage(chatId, infoLines, { parse_mode:'HTML', reply_markup: detailKb });

  const imgP = receipt.receiptNokos({ orderId, nomor: n.number, harga: n.price, metode:'saldo', pembeli: uname, tgId: n.tg_id, botUsername: config.BOT_USERNAME });
  const notif = receipt.buildChannelNotif({ type:'nokos', orderId, harga: n.price, metode:'saldo', pembeli: uname, botUsername: config.BOT_USERNAME,
    extra: { 'Nomor': n.number_masked||'***' } });
  sendChannelReceipt(imgP, notif);

  try { await bot.sendMessage(config.OWNER_ID,
    `📱 <b>${B('NOKOS TERJUAL')}</b>\n\n`+
    `👤 ${B('Pembeli')}: @${escH(uname)} (<code>${userId}</code>)\n`+
    `📞 ${B('Nomor')}: <code>${n.number_masked||sensorNomor(n.number)}</code>\n`+
    `💰 ${B('Harga')}: Rp${fmt(n.price)}\n`+
    `🆔 ${B('Order')}: <code>${orderId}</code>`,
    { parse_mode:'HTML' }); } catch {}

  if (n.session_string) {
    try {
      const session = new StringSession(n.session_string);
      const client  = new TelegramClient(session, parseInt(config.TG_API_ID||'0'), config.TG_API_HASH||'', { connectionRetries:5, useWSS:false });
      await client.connect();
      activeNokosClients.set(userId, { client, nokosId, number: n.number });
      client.addEventHandler(async (update) => {
        try {
          if (update?.message?.message) {
            const otp = extractOTP(update.message.message);
            if (otp) {
              const otpText =
                `🔑 <b>${B('OTP Masuk!')}</b>\n━━━━━━━━━━━━━━━━━━━━\n`+
                `📱 <b>${B('Nomor')}:</b> <code>${n.number}</code>\n`+
                `🔑 <b>${B('Kode OTP')}:</b> <code>${otp}</code>\n━━━━━━━━━━━━━━━━━━━━\n`+
                `Masukkan kode ini di Telegram.\n⚠️ Jangan bagikan ke siapapun!`;
              await bot.sendMessage(chatId, otpText, { parse_mode:'HTML',
                reply_markup:{ inline_keyboard:[[{ text: B('🏠 Menu Utama'), callback_data:'MAIN_MENU' }]] } });
            }
          }
        } catch {}
      }, new (require('telegram/events').NewMessage)({}));
    } catch(e) { log.err('[OTP_HANDLER]', e.message); }
  }
}

async function gramSendCode(apiId, apiHash, phoneNumber, ownerId) {
  if (activeAddClients.has(ownerId)) {
    try { await activeAddClients.get(ownerId).client.disconnect(); } catch {}
    activeAddClients.delete(ownerId);
  }
  const session = new StringSession('');
  const client  = new TelegramClient(session, apiId, apiHash, { connectionRetries:5, useWSS:false });
  await client.connect();
  const result = await client.invoke(new Api.auth.SendCode({ phoneNumber, apiId, apiHash, settings: new Api.CodeSettings({}) }));
  activeAddClients.set(ownerId, { client, session });
  return { phoneCodeHash: result.phoneCodeHash };
}

async function gramSignIn(ownerId, { phoneNumber, phoneCode, phoneCodeHash }) {
  const entry = activeAddClients.get(ownerId);
  if (!entry) throw new Error('Sesi SendCode tidak ditemukan. Silakan /add ulang.');
  return await entry.client.invoke(new Api.auth.SignIn({ phoneNumber, phoneCode, phoneCodeHash }));
}

async function gramSignInWithPassword(client, password) {
  const { computeCheck } = require('telegram/Password');
  const pwdInfo  = await client.invoke(new Api.account.GetPassword());
  const pwdCheck = await computeCheck(pwdInfo, password);
  return await client.invoke(new Api.auth.CheckPassword({ password: pwdCheck }));
}

const PANEL_PLANS = [
  { key:'1gb',  label:'1GB',   row:0 },
  { key:'2gb',  label:'2GB',   row:0 },
  { key:'3gb',  label:'3GB',   row:0 },
  { key:'4gb',  label:'4GB',   row:1 },
  { key:'5gb',  label:'5GB',   row:1 },
  { key:'6gb',  label:'6GB',   row:1 },
  { key:'7gb',  label:'7GB',   row:2 },
  { key:'8gb',  label:'8GB',   row:2 },
  { key:'9gb',  label:'9GB',   row:3 },
  { key:'10gb', label:'10GB',  row:3 },
  { key:'unli', label:'Unli🔥',row:4 },
];

function getPanelHarga(key) {
  return parseInt(db.getSetting(`harga_panel_${key}`) || config.HARGA[`panel_${key}`] || 10000);
}

const _panelSessionStore = new Map();
function panelStoreSet(userId, data) {
  const key = `${userId}_${Date.now().toString(36).slice(-6)}`;
  _panelSessionStore.set(key, data);

  setTimeout(() => _panelSessionStore.delete(key), 30 * 60 * 1000);
  return key;
}
function panelStoreGet(key) {
  return _panelSessionStore.get(key) || null;
}
function resolveDisplayUsername(username) {
  if (!username || !username.startsWith('__EX_TOKEN__')) return username;
  const token = username.slice(12);
  const exData = panelStoreGet(token);
  return exData ? exData.pteroUsername : '(akun lama)';
}

async function sendPanelMenu(chatId, userId, delMsgId=null) {

  const servers = db.getAllServers();
  if (!servers.length) {
    const text = `📡 <b>${B('PANEL')}</b>\n\n❌ ${B('Belum ada server terdaftar.')}\nHubungi owner untuk menambah server.`;
    const kb   = { inline_keyboard:[[{ text: B('⬅️ Kembali'), callback_data:'LAYANAN_MENU' }]] };
  if (delMsgId) await tryDel(chatId, delMsgId);
  return bot.sendMessage(chatId, text, { parse_mode:'HTML', reply_markup:kb });
  }

  const userPanels = db.getUserPanels(userId).filter(p => p.ptero_username);
  userStates.delete(userId);
  if (delMsgId) await tryDel(chatId, delMsgId);

  if (userPanels.length > 0) {
    const seen = new Set();
    const uniqueAccounts = userPanels.filter(p => {
      if (seen.has(p.ptero_username)) return false;
      seen.add(p.ptero_username); return true;
    });
    const text =
      `📡 <b>${B('ORDER PANEL')}</b>\n\n` +
      `👤 ${B('Pilih Akun')}\n` +
      `<i>Pilih akun lama atau buat akun baru:</i>`;

    const rows = uniqueAccounts.map((p, i) => [{
      text: `👤 ${p.ptero_username}`,
      callback_data: `PANEL_PICK_ACC:${i}`
    }]);
    rows.push([{ text: B('🆕 Akun Baru'), callback_data:'PANEL_ACCOUNT:new' }]);
    rows.push([{ text: B('❌ Batal'), callback_data:'LAYANAN_MENU' }]);

    const kb = { inline_keyboard: rows };
    const pm = await bot.sendMessage(chatId, text, { parse_mode:'HTML', reply_markup:kb });
    userStates.set(userId, { state:'WAITING_PANEL_ACCOUNT_CHOICE', promptMsgId: pm.message_id, accountList: uniqueAccounts });
    return;
  }

  const inputText =
    `📡 <b>${B('ORDER PANEL')}</b>\n\n` +
    `Masukkan ${B('username')} panel yang kamu inginkan:\n` +
    `<i>(Hanya huruf kecil, angka, dan underscore)</i>`;
  const inputKb = { inline_keyboard:[[{ text: B('❌ Batal'), callback_data:'LAYANAN_MENU' }]] };
  const pm = await bot.sendMessage(chatId, inputText, { parse_mode:'HTML', reply_markup:inputKb });
  userStates.set(userId, { state:'WAITING_PANEL_USERNAME', promptMsgId: pm.message_id });
}

async function execPanelOrderExisting(chatId, userId, from, pteroUsername, panelDomain, serverName, pteroEmail, planKey, durKey, cbId, msgId) {
  const harga = getPanelDurHarga(planKey, durKey);
  const dur   = PANEL_DURATIONS.find(d => d.key === durKey);
  const ok    = db.deductBalance(userId, harga);
  if (!ok) { await answerCb(cbId, '❌ Saldo tidak cukup!', true); return; }
  await answerCb(cbId);
  if (msgId) await tryDel(chatId, msgId);

  const loadMsg = await bot.sendMessage(chatId,
    `⏳ ${B('Memproses order panel...')}\nAkun: <code>${pteroUsername}</code>`,
    { parse_mode:'HTML' }
  );

  try {
    const servers = db.getAllServers();
    const targetServer = servers.find(s => s.domain === panelDomain);
    if (!targetServer) throw new Error(`Server dengan domain ${panelDomain} tidak ditemukan.`);

    const lang = userStates.get(userId)?.panelLang || 'javascript';

    const pteroUser   = await ptero.resolveExistingUser(targetServer, pteroUsername, pteroEmail);
    const pteroUserId = pteroUser.id;

    const RAM_OPTIONS = {
      '1gb':  { ram: 1000,  disk: 1000,  cpu: 40  },
      '2gb':  { ram: 2000,  disk: 1000,  cpu: 60  },
      '3gb':  { ram: 3000,  disk: 2000,  cpu: 80  },
      '4gb':  { ram: 4000,  disk: 2000,  cpu: 100 },
      '5gb':  { ram: 5000,  disk: 3000,  cpu: 120 },
      '6gb':  { ram: 6000,  disk: 3000,  cpu: 140 },
      '7gb':  { ram: 7000,  disk: 4000,  cpu: 160 },
      '8gb':  { ram: 8000,  disk: 4000,  cpu: 180 },
      '9gb':  { ram: 9000,  disk: 5000,  cpu: 200 },
      '10gb': { ram: 10000, disk: 5000,  cpu: 220 },
      'unli': { ram: 0,     disk: 0,     cpu: 0   },
    };
    const res        = RAM_OPTIONS[planKey] || RAM_OPTIONS['1gb'];
    const finalName  = ptero.capital(serverName || pteroUsername) + ' Server';

    const panelServer = await ptero.createServerOnPanel(targetServer, {
      name: finalName,
      description: `Buyer || t.me/AlexSTR10/ || ${lang === 'javascript' ? 'JS' : 'Py'}`,
      userId: pteroUserId,
      ram: parseInt(res.ram), disk: parseInt(res.disk), cpu: parseInt(res.cpu),
      featureLimits: { databases: 5, backups: 5, allocations: 5 }
    });

    await tryDel(chatId, loadMsg.message_id);
    const orderId  = genId();
    const expiryMs = Date.now() + (dur?.ms || 7*24*60*60*1000);
    db.saveTx({ order_id: orderId, user_id: userId, amount: harga, variant:'panel', status:'completed' });
    db.addPanelRecord({
      uuid: panelServer.uuid,
      name: panelServer.name,
      domain: panelDomain,
      owner_id: userId,
      owner_username: from.username || null,
      ptero_username: pteroUsername,
      ptero_email: pteroEmail,
      plan_key: planKey,
      expiry_ms: expiryMs,
    });
    scheduleExactSuspend(panelServer.uuid, expiryMs);

    const uname = from.username || from.first_name || String(userId);
    const plan  = PANEL_PLANS.find(p => p.key === planKey);
    const expiryStr = new Date(expiryMs).toLocaleString('id-ID', { timeZone:'Asia/Jakarta' });
    const imgP  = receipt.receiptPanel({ orderId, planKey, harga, metode:'saldo', pembeli: uname, username: pteroUsername, domain: panelDomain, isAdmin: false, botUsername: config.BOT_USERNAME });
    const detail = receipt.buildPrivateDetailText({ type:'panel', orderId, harga, metode:'saldo', pembeli: uname,
      extra: { 'Domain': panelDomain, 'Username': pteroUsername, 'Email': pteroEmail,
               'Nama Server': finalName, 'Link Panel': panelDomain,
               'Durasi': dur?.label||durKey, 'Masa Aktif': `Sampai dengan: ${expiryStr} WIB`,
               'Info': 'Server ditambahkan ke akun yang sudah ada' } });
    await bot.sendMessage(chatId, detail, { parse_mode:'HTML',
      reply_markup:{ inline_keyboard:[[{ text: B('🔑 Login Panel'), url: panelDomain }]] } });
    const notif = receipt.buildChannelNotif({ type:'panel', orderId, product: `Panel ${plan?.label||planKey} (${dur?.label||durKey}) [Tambah Acc]`, harga, metode:'saldo', pembeli: uname, botUsername: config.BOT_USERNAME });
    sendChannelReceipt(imgP, notif);
    try { await bot.sendMessage(config.OWNER_ID,
      `📡 <b>${B('PANEL TERJUAL (TAMBAH ACC)')}</b>\n\n` +
      `👤 @${escH(uname)} (<code>${userId}</code>)\n` +
      `💻 Domain: ${sensorSensitive(panelDomain)}\n` +
      `👤 Username: <code>${pteroUsername}</code>\n` +
      `📧 Email: <code>${pteroEmail}</code>\n` +
      `🖥️ Nama Server: ${finalName}\n` +
      `📦 Plan: ${plan?.label||planKey} | ${dur?.label||durKey}\n` +
      `💰 Rp${fmt(harga)}\n` +
      `⏱ Masa Aktif: ${expiryStr} WIB`,
      { parse_mode:'HTML' }); } catch {}
  } catch(err) {
    db.addBalance(userId, harga);
    await tryDel(chatId, loadMsg.message_id);
    await bot.sendMessage(chatId, `❌ ${B('Gagal buat panel!')}\n<code>${escH(err.message)}</code>`, { parse_mode:'HTML' });
    await notifyOwnerError('execPanelOrderExisting', err, userId);
  }
}

async function handlePanelUsername(chatId, userId, from, username) {
  const clean = username.toLowerCase().replace(/[^a-z0-9_]/g,'');
  if (!clean || clean.length < 3 || clean.length > 24) {
    const errMsg = await bot.sendMessage(chatId,
      `❌ ${B('Username tidak valid!')} Min 3 karakter, hanya huruf kecil/angka/underscore.\n\nSilakan ketik ulang:`,
      { parse_mode:'HTML', reply_markup:{ inline_keyboard:[[{ text: B('❌ Batal'), callback_data:'LAYANAN_MENU' }]] } }
    );
    userStates.set(userId, { state:'WAITING_PANEL_USERNAME', promptMsgId: errMsg.message_id });
    return;
  }

  const servers = db.getAllServers();
  let loadMsgId = null;
  try {
    const lm = await bot.sendMessage(chatId, `⏳ ${B('Mengecek server aktif...')}`);
    loadMsgId = lm.message_id;
  } catch {}
  let activeServer = null;
  for (const s of servers) {
    const r = await ptero.checkServerStatus(s).catch(()=>null);
    if (r?.success) { activeServer = s; break; }
  }
  if (!activeServer) {
    if (loadMsgId) await tryDel(chatId, loadMsgId);
    await bot.sendMessage(chatId, `❌ ${B('Semua server sedang offline!')} Mohon hubungi owner.`, { parse_mode:'HTML' });
    try { await bot.sendMessage(config.OWNER_ID, `⚠️ <b>Semua server offline!</b>\nUser <code>${userId}</code> mencoba order panel.`, { parse_mode:'HTML' }); } catch {}
    return;
  }

  const typeText =
    `📡 <b>${B('PILIH TIPE PANEL')}</b>\n\n` +
    `👤 ${B('Username')}: <code>${clean}</code>\n` +
    `Pilih bahasa/runtime panel kamu:`;
  const typeKb = { inline_keyboard: [
    [
      { text: '⚡ Node.js', callback_data:`PANEL_TYPE:${clean}:javascript` },
      { text: '🐍 Python',               callback_data:`PANEL_TYPE:${clean}:python` }
    ],
    [{ text: B('❌ Batal'), callback_data:'LAYANAN_MENU' }]
  ]};
  return editOrReplace(chatId, loadMsgId, typeText, { parse_mode:'HTML', reply_markup:typeKb });
}

const PANEL_DURATIONS = [
  { key:'3hari',  label:'3 Hari',  ms: 3  * 24*60*60*1000 },
  { key:'7hari',  label:'7 Hari',  ms: 7  * 24*60*60*1000 },
  { key:'14hari', label:'14 Hari', ms: 14 * 24*60*60*1000 },
  { key:'21hari', label:'21 Hari', ms: 21 * 24*60*60*1000 },
  { key:'30hari', label:'30 Hari', ms: 30 * 24*60*60*1000 },
];

function getPanelDurHarga(planKey, durKey) {
  const stored = db.getSetting(`harga_${planKey}_${durKey}`);
  if (stored !== undefined && stored !== null && stored !== '') {
    return parseInt(stored);
  }
  
  
  return getPanelHarga(planKey);
}

function fmtDurasi(ms) {
  if (ms <= 0) return '⛔ Habis';
  const totS = Math.floor(ms / 1000);
  const d    = Math.floor(totS / 86400);
  const h    = Math.floor((totS % 86400) / 3600);
  const m    = Math.floor((totS % 3600) / 60);
  const s    = totS % 60;
  const parts = [];
  if (d) parts.push(`${d}d`);
  if (h) parts.push(`${h}h`);
  if (m) parts.push(`${m}m`);
  if (s) parts.push(`${s}s`);
  return parts.length ? parts.join(' ') : '0s';
}

async function showPanelPlanMenu(chatId, userId, username, lang, msgId) {
  const rows = []; const rowMap = {};
  for (const p of PANEL_PLANS) {
    if (!rowMap[p.row]) rowMap[p.row] = [];
    rowMap[p.row].push({ text: `${p.label}`, callback_data:`PANEL_PLAN:${username}:${p.key}` });
  }
  for (const r of Object.values(rowMap)) rows.push(r);
  rows.push([{ text: B('⬅️ Ganti Tipe'), callback_data:`PANEL_RETYPE:${username}` }]);
  rows.push([{ text: B('❌ Batal'), callback_data:'LAYANAN_MENU' }]);
  const langLabel = lang === 'python' ? '🐍 Python' : '⚡ Node.Js';
  const displayName = resolveDisplayUsername(username);
  const planText =
    `📡 <b>${B('PILIH PLAN PANEL')}</b>\n\n` +
    `👤 ${B('Username')}: <code>${displayName}</code>\n` +
    `⚙️ ${B('Tipe')}: <b>${langLabel}</b>\n\n` +
    `Pilih kapasitas RAM:`;
  return editOrReplace(chatId, msgId, planText, { parse_mode:'HTML', reply_markup:{ inline_keyboard: rows } });
}

async function showPanelDurasiMenu(chatId, userId, username, planKey, msgId) {
  const plan = PANEL_PLANS.find(p => p.key === planKey);
  const availDurs = getAvailableDurations(planKey);
  if (!availDurs.length) {
    return editOrReplace(chatId, msgId, `❌ Tidak ada pilihan durasi untuk plan <b>${plan?.label||planKey}</b>.\nHubungi owner.`, { parse_mode:'HTML', reply_markup:{inline_keyboard:[[{text:B('⬅️ Kembali'),callback_data:`PANEL_REPLAN:${username}`}]]} });
  }
  const rows = availDurs.map(d => {
    const h = getPanelDurHarga(planKey, d.key);
    return [{ text: `${d.label} — Rp${fmt(h)}`, callback_data:`PANEL_DUR:${username}:${planKey}:${d.key}` }];
  });
  rows.push([{ text: B('⬅️ Ganti Plan'), callback_data:`PANEL_REPLAN:${username}` }]);
  rows.push([{ text: B('❌ Batal'), callback_data:'LAYANAN_MENU' }]);
  const displayName2 = resolveDisplayUsername(username);
  const text =
    `📡 <b>${B('SEWA BERAPA HARI?')}</b>\n\n` +
    `👤 ${B('Username')}: <code>${displayName2}</code>\n` +
    `📦 ${B('Plan')}: <b>${plan?.label||planKey}</b>\n\n` +
    `Pilih durasi sewa:`;
  return editOrReplace(chatId, msgId, text, { parse_mode:'HTML', reply_markup:{ inline_keyboard: rows } });
}

async function handlePanelOrder(chatId, userId, from, username, planKey, cbId, msgId) {
  await answerCb(cbId);
  return showPanelDurasiMenu(chatId, userId, username, planKey, msgId);
}

async function handlePanelDurOrder(chatId, userId, from, username, planKey, durKey, cbId, msgId) {
  const harga = getPanelDurHarga(planKey, durKey);
  const bal   = db.getBalance(userId);
  const plan  = PANEL_PLANS.find(p => p.key === planKey);
  const dur   = PANEL_DURATIONS.find(d => d.key === durKey);
  await answerCb(cbId);

  
  let displayUsername = username;
  let isExisting = false;
  if (username.startsWith('__EX_TOKEN__')) {
    isExisting = true;
    const sessionToken = username.slice(12);
    const exData = panelStoreGet(sessionToken);
    if (!exData) {
      await answerCb(cbId, '⚠️ Sesi expired, ulangi order.', true);
      await editOrReplace(chatId, msgId,
        `⚠️ <b>Sesi expired!</b>\n\nSilakan ulangi order dari menu Panel.`,
        { parse_mode:'HTML', reply_markup:{ inline_keyboard:[[{ text:'🔄 Menu Panel', callback_data:'MENU_PANEL' }]] } }
      );
      return;
    }
    displayUsername = exData.pteroUsername;
  }

  const text =
    `📡 <b>${B('KONFIRMASI ORDER PANEL')}</b>\n\n` +
    (isExisting
      ? `👤 ${B('Akun')}: <code>${displayUsername}</code> <i>(akun yang sudah ada)</i>\n`
      : `👤 ${B('Username')}: <code>${displayUsername}</code>\n`) +
    `📦 ${B('Plan')}: <b>${plan?.label||planKey}</b>\n` +
    `⏱ ${B('Durasi')}: <b>${dur?.label||durKey}</b>\n` +
    `💰 ${B('Harga')}: <b>Rp${fmt(harga)}</b>\n` +
    `💳 ${B('Saldo kamu')}: <b>Rp${fmt(bal)}</b>\n` +
    `💳 ${B('Sisa saldo')}: <b>Rp${fmt(Math.max(0,bal-harga))}</b>\n\n` +
    (bal >= harga ? `✅ ${B('Konfirmasi pembelian?')}` : `❌ ${B('Saldo tidak cukup.')}\nKurang: Rp${fmt(harga-bal)}`);
  const kb = { inline_keyboard: [
    ...(bal >= harga
      ? [[{ text: B('✅ Ya, Proses Sekarang'), callback_data:`PANEL_EXEC:${username}:${planKey}:${durKey}` }]]
      : [[{ text: B('💰 Deposit Saldo'), callback_data:'DEPOSIT_MENU' }]]),
    [{ text: B('⬅️ Ganti Durasi'), callback_data:`PANEL_PLAN:${username}:${planKey}` }],
    [{ text: B('❌ Batal'), callback_data:'LAYANAN_MENU' }]
  ]};
  return editOrReplace(chatId, msgId, text, { parse_mode:'HTML', reply_markup:kb });
}

async function execPanelOrder(chatId, userId, from, username, planKey, durKey, cbId, msgId) {
  
  if (username.startsWith('__EX_TOKEN__')) {
    const sessionToken = username.slice(12); 
    const exData       = panelStoreGet(sessionToken);
    if (!exData) {
      await answerCb(cbId, '❌ Sesi expired, ulangi order.', true);
      return sendPanelMenu(chatId, userId);
    }
    const { pteroUsername, panelDomain, exServerName, pteroEmail } = exData;
    return execPanelOrderExisting(chatId, userId, from, pteroUsername, panelDomain, exServerName, pteroEmail, planKey, durKey, cbId, msgId);
  }

  const harga = getPanelDurHarga(planKey, durKey);
  const dur   = PANEL_DURATIONS.find(d => d.key === durKey);
  const ok    = db.deductBalance(userId, harga);
  if (!ok) { await answerCb(cbId, '❌ Saldo tidak cukup!', true); return; }
  await answerCb(cbId);
  if (msgId) await tryDel(chatId, msgId);
  const loadMsg = await bot.sendMessage(chatId, `⏳ ${B('Memproses order panel...')}\nUsername: <code>${username}</code>`, { parse_mode:'HTML' });
  try {
    const lang   = userStates.get(userId)?.panelLang || 'javascript';
    const result = await ptero.createPanelMultiServer(db, { username, planKey, isAdmin: false, language: lang });
    await tryDel(chatId, loadMsg.message_id);
    const orderId  = genId();
    const expiryMs = Date.now() + (dur?.ms || 7*24*60*60*1000);
    db.saveTx({ order_id: orderId, user_id: userId, amount: harga, variant:'panel', status:'completed' });
    
    db.addPanelRecord({
      uuid: result.panelServer.uuid,
      name: result.panelServer.name,
      domain: result.domain,
      owner_id: userId,
      owner_username: from.username || null,
      ptero_username: username,
      ptero_email: result.user?.email || `${username.toLowerCase()}@hekaly.com`,
      plan_key: planKey,
      expiry_ms: expiryMs,
    });
    scheduleExactSuspend(result.panelServer.uuid, expiryMs);
    const uname = from.username || from.first_name || String(userId);
    const plan  = PANEL_PLANS.find(p => p.key === planKey);
    const expiryStr = new Date(expiryMs).toLocaleString('id-ID', { timeZone:'Asia/Jakarta' });
    const imgP  = receipt.receiptPanel({ orderId, planKey, harga, metode:'saldo', pembeli: uname, username, domain: result.domain, isAdmin: false, botUsername: config.BOT_USERNAME });
    const detail = receipt.buildPrivateDetailText({ type:'panel', orderId, harga, metode:'saldo', pembeli: uname,
      extra: { 'Domain': result.domain, 'Username': username, 'Password': result.password, 'Link Panel': result.domain,
               'Durasi': dur?.label||durKey, 'Masa Aktif': `Sampai dengan: ${expiryStr} WIB` } });
    await bot.sendMessage(chatId, detail, { parse_mode:'HTML',
    reply_markup:{ inline_keyboard:[[{ text: B('🔑 Login Panel'), url: result.domain }]] } });
    const notif = receipt.buildChannelNotif({ type:'panel', orderId, product: `Panel ${plan?.label||planKey} (${dur?.label||durKey})`, harga, metode:'saldo', pembeli: uname, botUsername: config.BOT_USERNAME });
    sendChannelReceipt(imgP, notif);
    try { await bot.sendMessage(config.OWNER_ID,
      `📡 <b>${B('PANEL TERJUAL')}</b>\n\n` +
      `👤 @${escH(uname)} (<code>${userId}</code>)\n` +
      `💻 Server: ${sensorSensitive(result.server||result.domain||'-')}\n` +
      `👤 Username: <code>${username}</code>\n` +
      `📦 Plan: ${plan?.label||planKey} | ${dur?.label||durKey}\n` +
      `💰 Rp${fmt(harga)}\n` +
      `⏱ Masa Aktif: ${expiryStr} WIB`,
      { parse_mode:'HTML' }); } catch {}
  } catch(err) {
    db.addBalance(userId, harga);
    await tryDel(chatId, loadMsg.message_id);
    await bot.sendMessage(chatId, `❌ ${B('Gagal buat panel!')}\n<code>${escH(err.message)}</code>`, { parse_mode:'HTML' });
    await notifyOwnerError('execPanelOrder', err, userId);
    try { await bot.sendMessage(config.OWNER_ID,
      `❌ <b>PANEL GAGAL</b>\nUser: <code>${userId}</code>\nUsername: ${username}\n<code>${escH(err.message)}</code>`,
      { parse_mode:'HTML' }); } catch {}
  }
}

async function sendAdminMenu(chatId, userId, delMsgId=null) {

  if (db.getSetting('admin_enabled') === false) {
    const text = `❌ ${B('Layanan Admin Panel sedang tidak tersedia.')}`;
    const kb   = { inline_keyboard:[[{ text: B('⬅️ Kembali'), callback_data:'LAYANAN_MENU' }]] };
  if (delMsgId) await tryDel(chatId, delMsgId);
  return bot.sendMessage(chatId, text, { parse_mode:'HTML', reply_markup:kb });
  }

  const servers = db.getAllServers();
  if (!servers.length) {
    const text = `🛠️ <b>${B('ADMIN PANEL')}</b>\n\n❌ ${B('Belum ada server terdaftar.')}\nHubungi owner untuk menambah server.`;
    const kb   = { inline_keyboard:[[{ text: B('⬅️ Kembali'), callback_data:'LAYANAN_MENU' }]] };
  if (delMsgId) await tryDel(chatId, delMsgId);
  return bot.sendMessage(chatId, text, { parse_mode:'HTML', reply_markup:kb });
  }

  const harga = parseInt(db.getSetting('harga_admin') || config.HARGA.admin);
  if (delMsgId) await tryDel(chatId, delMsgId);
  const lmAdmin = await bot.sendMessage(chatId, `⏳ ${B('Mengecek server aktif...')}`, { parse_mode:'HTML' });
  let loadMsgId = lmAdmin.message_id;

  let activeServer = null;
  for (const s of servers) {
    const r = await ptero.checkServerStatus(s).catch(()=>null);
    if (r?.success) { activeServer = s; break; }
  }

  if (!activeServer) {
    const text = `🛠️ <b>${B('ADMIN PANEL')}</b>\n\n❌ ${B('Semua server sedang offline!')}\nMohon hubungi owner.`;
    const kb   = { inline_keyboard:[[{ text: B('⬅️ Kembali'), callback_data:'LAYANAN_MENU' }]] };
    try { await bot.editMessageText(text, { chat_id:chatId, message_id:loadMsgId, parse_mode:'HTML', reply_markup:kb }); } catch {}
    try { await bot.sendMessage(config.OWNER_ID,
      `⚠️ <b>Semua server offline!</b>\nUser <code>${userId}</code> mencoba order Admin Panel.`, { parse_mode:'HTML' }); } catch {}
    return;
  }

  const text =
    `🛠️ <b>${B('ADMIN PANEL')}</b>\n\n`+
    `💰 ${B('Harga')}: <b>Rp${fmt(harga)}</b>\n`+
    `✅ ${B('Server')}: <b>${activeServer.name || activeServer.domain}</b>\n\n`+
    `${B('Keunggulan:')}\n`+
    `├ 🔑 Akses admin penuh ke panel\n`+
    `├ 👥 Bisa manage semua server\n`+
    `└ ⚡ Proses otomatis\n\n`+
    `Masukkan <b>username</b> yang kamu inginkan:\n<i>(huruf kecil, angka, underscore)</i>`;
  userStates.delete(userId);
  await tryDel(chatId, loadMsgId);
  const pm2 = await bot.sendMessage(chatId, text, { parse_mode:'HTML', reply_markup:{ inline_keyboard:[[{ text: B('❌ Batal'), callback_data:'LAYANAN_MENU' }]] } });
  userStates.set(userId, { state:'WAITING_ADP_USERNAME', promptMsgId: pm2.message_id });
}

async function handleAdminOrder(chatId, userId, from, username, msgId=null) {
  const harga = parseInt(db.getSetting('harga_admin') || config.HARGA.admin);
  const bal   = db.getBalance(userId);
  const text  =
    `🛠️ <b>${B('KONFIRMASI ADMIN PANEL')}</b>\n\n`+
    `👤 ${B('Username')}: <code>${username}</code>\n`+
    `💰 ${B('Harga')}: <b>Rp${fmt(harga)}</b>\n`+
    `💳 ${B('Saldo kamu')}: <b>Rp${fmt(bal)}</b>\n`+
    `💳 ${B('Sisa saldo')}: <b>Rp${fmt(Math.max(0,bal-harga))}</b>\n\n`+
    (bal >= harga
      ? `✅ ${B('Konfirmasi pembelian?')}`
      : `❌ ${B('Saldo tidak cukup.')}\nKurang: Rp${fmt(harga-bal)}`);
  const kb = { inline_keyboard: [
    ...(bal >= harga
      ? [[{ text: B('✅ Ya, Proses Sekarang'), callback_data:`ADP_CONFIRM:${username}` }]]
      : [[{ text: B('💰 Deposit Saldo'), callback_data:'DEPOSIT_MENU' }]]),
    [{ text: B('❌ Batal'), callback_data:'LAYANAN_MENU' }]
  ]};
  return editOrReplace(chatId, msgId, text, { parse_mode:'HTML', reply_markup:kb });
}

async function processAdminOrder(chatId, userId, from, username, cbId, msgId=null) {
  const harga = parseInt(db.getSetting('harga_admin') || config.HARGA.admin);
  const ok    = db.deductBalance(userId, harga);
  if (!ok) { await answerCb(cbId, '❌ Saldo tidak cukup!', true); return; }
  await answerCb(cbId);
  if (msgId) await tryDel(chatId, msgId);
  const loadMsg = await bot.sendMessage(chatId, `⏳ ${B('Memproses Admin Panel...')}\nUsername: <code>${username}</code>`, { parse_mode:'HTML' });
  try {
    const lang   = userStates.get(userId)?.panelLang || 'javascript';
    const result = await ptero.createPanelMultiServer(db, { username, planKey:'1gb', isAdmin: true, language: lang });
    await tryDel(chatId, loadMsg.message_id);
    const orderId = genId();
    db.saveTx({ order_id: orderId, user_id: userId, amount: harga, variant:'admin', status:'completed' });
    const uname = from.username || from.first_name || String(userId);

    const imgP   = receipt.receiptPanel({ orderId, planKey:'admin', harga, metode:'saldo', pembeli: uname, username, domain: result.domain, isAdmin: true, botUsername: config.BOT_USERNAME });
    const detail = receipt.buildPrivateDetailText({ type:'panel', orderId, harga, metode:'saldo', pembeli: uname,
      extra: { 'Domain': result.domain, 'Username': username, 'Password': result.password, 'Type': 'Admin Panel' } });

    await bot.sendMessage(chatId, detail, { parse_mode:'HTML',
      reply_markup:{ inline_keyboard:[[{ text: B('🏠 Menu'), callback_data:'MAIN_MENU' }]] } });

    const notif = receipt.buildChannelNotif({ type:'panel', orderId, product:'Admin Panel', harga, metode:'saldo', pembeli: uname, botUsername: config.BOT_USERNAME });
    sendChannelReceipt(imgP, notif);
    try { await bot.sendMessage(config.OWNER_ID,
      `🛠️ <b>${B('ADP TERJUAL')}</b>\n\n👤 @${escH(uname)} (<code>${userId}</code>)\n💻 Server: ${result.server}\n👤 Username: ${username}`,
      { parse_mode:'HTML' }); } catch {}
  } catch(err) {
    db.addBalance(userId, harga);
    await tryDel(chatId, loadMsg.message_id);
    await bot.sendMessage(chatId, `❌ ${B('Gagal buat Admin Panel!')}\n<code>${escH(err.message)}</code>`, { parse_mode:'HTML' });
    await notifyOwnerError('processAdminOrder', err, userId);
  }
}

async function sendResellerMenu(chatId, userId, delMsgId=null) {
  if (db.getSetting('reseller_enabled') === false) {
    if (delMsgId) await tryDel(chatId, delMsgId);
    return bot.sendMessage(chatId, `❌ ${B('Layanan Reseller sedang tidak tersedia.')}`, {
      parse_mode:'HTML', reply_markup:{ inline_keyboard:[[{ text: B('⬅️ Kembali'), callback_data:'LAYANAN_MENU' }]] }
    });
  }
  const harga = parseInt(db.getSetting('harga_reseller') || config.HARGA.reseller);
  const text  =
    `🤝 <b>${B('RESELLER')}</b>\n\n`+
    `💰 ${B('Harga')}: <b>Rp${fmt(harga)}</b>\n\n`+
    `${B('Keunggulan:')}\n`+
    `├ 💵 Komisi penjualan menarik\n`+
    `├ 🏷️ Harga khusus reseller\n`+
    `└ 👥 Akses grup reseller eksklusif\n\n`+
    `Masukkan ${B('ID Telegram')} kamu:`;
  const kb = { inline_keyboard:[[{ text: B('❌ Batal'), callback_data:'LAYANAN_MENU' }]] };
  userStates.delete(userId);
  if (delMsgId) await tryDel(chatId, delMsgId);
  const pm3 = await bot.sendMessage(chatId, text, { parse_mode:'HTML', reply_markup:kb });
  userStates.set(userId, { state:'WAITING_RESELLER_TGID', promptMsgId: pm3.message_id });
}

async function handleResellerOrder(chatId, userId, from, tgId, msgId=null) {
  const harga  = parseInt(db.getSetting('harga_reseller') || config.HARGA.reseller);
  const bal    = db.getBalance(userId);
  const text   =
    `🤝 <b>${B('KONFIRMASI RESELLER')}</b>\n\n`+
    `🆔 ${B('ID Telegram')}: <code>${tgId}</code>\n`+
    `💰 ${B('Harga')}: <b>Rp${fmt(harga)}</b>\n`+
    `💳 ${B('Saldo kamu')}: <b>Rp${fmt(bal)}</b>\n`+
    `💳 ${B('Sisa saldo')}: <b>Rp${fmt(Math.max(0,bal-harga))}</b>\n\n`+
    (bal >= harga
      ? `✅ ${B('Konfirmasi pembelian?')}`
      : `❌ ${B('Saldo tidak cukup.')}\nKurang: Rp${fmt(harga-bal)}`);
  const kb = { inline_keyboard: [
    ...(bal >= harga
      ? [[{ text: B('✅ Ya, Proses Sekarang'), callback_data:`RESELLER_CONFIRM:${tgId}` }]]
      : [[{ text: B('💰 Deposit Saldo'), callback_data:'DEPOSIT_MENU' }]]),
    [{ text: B('❌ Batal'), callback_data:'LAYANAN_MENU' }]
  ]};
  return editOrReplace(chatId, msgId, text, { parse_mode:'HTML', reply_markup:kb });
}

async function processResellerOrder(chatId, userId, from, tgId, cbId) {
  const harga = parseInt(db.getSetting('harga_reseller') || config.HARGA.reseller);
  const ok    = db.deductBalance(userId, harga);
  if (!ok) { await answerCb(cbId, '❌ Saldo tidak cukup!', true); return; }
  await answerCb(cbId);
  const orderId = genId();
  db.saveTx({ order_id: orderId, user_id: userId, amount: harga, variant:'reseller', status:'completed' });
  const uname = from.username || from.first_name || String(userId);
  const link  = db.getSetting('reseller_link') || '';

  const imgP   = receipt.receiptReseller({ orderId, harga, metode:'saldo', pembeli: uname, resellerId: tgId, botUsername: config.BOT_USERNAME });
  const detail = receipt.buildPrivateDetailText({ type:'reseller', orderId, harga, metode:'saldo', pembeli: uname,
    extra: { 'ID Reseller': tgId, ...(link?{'Link Grup':link}:{}) } });
  const kb = { inline_keyboard: [
    ...(link ? [[{ text: B('👥 Join Grup Reseller'), url: link }]] : []),
    [{ text: B('🏠 Menu'), callback_data:'MAIN_MENU' }]
  ]};

  await bot.sendMessage(chatId, detail, { parse_mode:'HTML', reply_markup: kb });

  const notif = receipt.buildChannelNotif({ type:'reseller', orderId, harga, metode:'saldo', pembeli: uname, botUsername: config.BOT_USERNAME });
  sendChannelReceipt(imgP, notif);
  try { await bot.sendMessage(config.OWNER_ID,
    `🤝 <b>${B('RESELLER BARU')}</b>\n\n👤 @${escH(uname)} (<code>${userId}</code>)\n🆔 ${tgId}\n💰 Rp${fmt(harga)}`,
    { parse_mode:'HTML' }); } catch {}
}

async function sendScriptMenu(chatId, userId, delMsgId=null) {
  const produk = db.getAllProduk();
  const text   =
    `📂 <b>${B('PILIH SCRIPT')}</b>\n\n`+
    `📁 ${B('Pilih Script Di Bawah Yang Ingin Kamu Beli')} :\n\n`+
    (produk.length ? `Total: <b>${produk.length}</b> produk tersedia` : `❌ Belum ada produk. Owner gunakan /addproduk`);
  const rows = produk.map(p => ([{
    text: `${escH(p.nama)} - Rp ${fmt(p.harga)}`,
    callback_data: `PRODUK_BUY:${p.id}`
  }]));
  rows.push([{ text: B('⬅️ Kembali'), callback_data:'LAYANAN_MENU' }]);
  const kb = { inline_keyboard: rows };
  if (delMsgId) await tryDel(chatId, delMsgId);
  return bot.sendMessage(chatId, text, { parse_mode:'HTML', reply_markup:kb });
}

async function handleProdukBuy(chatId, userId, from, produkId, cbId, msgId) {
  const p = db.getProdukById(produkId);
  if (!p) { await answerCb(cbId, '❌ Produk tidak ditemukan.', true); return; }
  const bal  = db.getBalance(userId);
  const text =
    `📂 <b>${B('KONFIRMASI PEMBELIAN')}</b>\n\n`+
    `📦 ${B('Produk')}: <b>${escH(p.nama)}</b>\n`+
    (p.deskripsi ? `📝 ${B('Deskripsi')}: ${escH(p.deskripsi)}\n` : '')+
    `💰 ${B('Harga')}: <b>Rp${fmt(p.harga)}</b>\n`+
    `💳 ${B('Saldo kamu')}: <b>Rp${fmt(bal)}</b>\n`+
    `💳 ${B('Sisa saldo')}: <b>Rp${fmt(Math.max(0,bal-p.harga))}</b>\n\n`+
    (bal >= p.harga
      ? `✅ ${B('Konfirmasi pembelian?')}`
      : `❌ ${B('Saldo tidak cukup.')}\nKurang: Rp${fmt(p.harga-bal)}`);
  const kb = { inline_keyboard: [
    ...(bal >= p.harga
      ? [[{ text: B('✅ Ya, Beli Sekarang'), callback_data:`PRODUK_CONFIRM:${produkId}` }]]
      : [[{ text: B('💰 Deposit Saldo'), callback_data:'DEPOSIT_MENU' }]]),
    [{ text: B('⬅️ Kembali'), callback_data:'ORDER_SCRIPT' }]
  ]};
  await answerCb(cbId);
  return editOrReplace(chatId, msgId, text, { parse_mode:'HTML', reply_markup:kb });
}

async function processProdukOrder(chatId, userId, from, produkId, cbId) {
  const p  = db.getProdukById(produkId);
  if (!p) { await answerCb(cbId, '❌ Produk tidak ditemukan.', true); return; }
  const ok = db.deductBalance(userId, p.harga);
  if (!ok) { await answerCb(cbId, '❌ Saldo tidak cukup!', true); return; }
  await answerCb(cbId);
  const orderId = genId();
  db.saveTx({ order_id: orderId, user_id: userId, amount: p.harga, variant:'script', status:'completed', produk_id: produkId });
  const uname = from.username || from.first_name || String(userId);
  const detail = receipt.buildPrivateDetailText({ type:'produk', orderId, harga: p.harga, metode:'saldo', pembeli: uname,
    extra:{ 'Produk': p.nama } });
  await bot.sendMessage(chatId, detail, { parse_mode:'HTML' });

  if (p.file_id) {
    await bot.sendDocument(chatId, p.file_id, {
      caption: `📦 <b>Isi Produk: ${escH(p.nama)}</b>`,
      parse_mode: 'HTML',
    });
  } else if (p.isi) {
    await bot.sendMessage(chatId,
      `📦 <b>Isi Produk: ${escH(p.nama)}</b>\n\n<code>${escH(p.isi)}</code>`,
      { parse_mode:'HTML', reply_markup: kb });
  } else {
    await bot.sendMessage(chatId,
      `⚠️ Konten produk belum tersedia. Hubungi owner: @${escH(config.OWNER_USERNAME||'owner')}`,
      { parse_mode:'HTML', reply_markup: kb });
  }

  const imgP  = receipt.receiptProduk({ orderId, namaProduk: p.nama, harga: p.harga, metode:'saldo', pembeli: uname, botUsername: config.BOT_USERNAME });
  const notif = receipt.buildChannelNotif({ type:'produk', orderId, product: p.nama, harga: p.harga, metode:'saldo', pembeli: uname, botUsername: config.BOT_USERNAME });
  sendChannelReceipt(imgP, notif);
  try { await bot.sendMessage(config.OWNER_ID,
    `📂 <b>${B('PRODUK TERJUAL')}</b>\n\n👤 @${escH(uname)} (<code>${userId}</code>)\n📦 ${escH(p.nama)}\n💰 Rp${fmt(p.harga)}`,
    { parse_mode:'HTML' }); } catch {}
}

const USER_COMMANDS = [
  { command:'start',    description:'🏠 Buka menu utama' },
  { command:'deposit',  description:'💰 Isi saldo' },
  { command:'mypanel',  description:'📦 Lihat panel saya' },
  { command:'stopai',   description:'🤖 Keluar dari mode CS AI' },
];
const OWNER_COMMANDS = [
  { command:'start',      description:'Buka menu utama' },
  { command:'deposit',    description:'Isi saldo' },
  { command:'mypanel',    description:'Lihat panel saya' },
  { command:'stopai',     description:'Keluar dari mode CS AI' },
  { command:'bataltrx',   description:'Batalkan transaksi deposit aktif' },
  { command:'bcs',        description:'Broadcast pesan (reply teks)' },
  { command:'bcsp',       description:'Broadcast + Pin pesan (reply teks)' },
  { command:'add',        description:'Tambah nokos: /add +62xxx 5000 [v2l]' },
  { command:'addserver',  description:'Tambah server ptero' },
  { command:'cekserver',  description:'Cek server ptero' },
  { command:'listsrv',    description:'List semua server di semua panel' },
  { command:'info',       description:'Info panel user: /info @username|id' },
  { command:'perpanjang', description:'Perpanjang panel: /perpanjang uuid' },
  { command:'kurangi',    description:'Kurangi masa aktif: /kurangi uuid durasi' },
  { command:'addpanel',   description:'Tambah panel manual: /addpanel uuid durasi @user/id' },
  { command:'scanall',    description:'Scan semua script pada panel' },
  { command:'suspend',    description:'Suspend server: /suspend uuid alasan' },
  { command:'unsuspend',  description:'Unsuspend panel: /unsuspend uuid' },
  { command:'addreq',     description:'Wajib join: /addreq @username NamaChannel' },
  { command:'delreq',     description:'Hapus req join: /delreq @username' },
  { command:'listreq',    description:'List req join' },
  { command:'addproduk',  description:'Tambah produk: /addproduk nama | harga' },
  { command:'delproduk',  description:'Hapus produk: /delproduk id' },
  { command:'listproduk', description:'List semua produk' },
  { command:'addlink',    description:'Set link reseller: /addlink url' },
  { command:'addsaldo',   description:'Tambah/kurangi saldo: /addsaldo @user|id +/-jumlah' },
  { command:'ceksaldo',   description:'Cek saldo user: /ceksaldo @user|id' },
  { command:'cairkan',    description:'Cairkan saldo Atlantic H2H ke rekening' },
  { command:'backup',     description:'Backup database' },
  { command:'dbrestore',  description:'Restore database (reply file .json)' },
];

bot.on('message', (msg) => {
  if (!msg.text || !msg.text.startsWith('/')) return;
  const cmd   = msg.text.split(' ')[0].replace('/', '').toLowerCase();
  const uname = msg.from.username ? `@${msg.from.username}` : msg.from.first_name;
  const role  = isOwner(msg.from.id) ? '\x1b[33m[OWNER]\x1b[0m' : '\x1b[32m[USER]\x1b[0m';
  console.log(`\x1b[36m[CMD]\x1b[0m ${role} /${cmd} » ${uname} (${msg.from.id})`);

  
  if (csai.isInCsAi(msg.from.id) && cmd !== 'stopai' && cmd !== 'start') {
    bot.sendMessage(msg.chat.id,
      `🤖 Kamu sedang dalam mode <b>CS AI (Beta)</b>!\n\n` +
      `Tidak bisa menggunakan command atau tombol apapun saat CS AI aktif.\n` +
      `Ketik <code>/stopai</code> dahulu untuk keluar dari mode CS AI.`,
      { parse_mode: 'HTML', reply_markup:{ inline_keyboard:[[{ text: B('❌ Keluar CS AI'), callback_data:'CSAI_STOP' }]] } }
    ).catch(()=>{});
    return;
  }
});

async function maintBlocked(msg) {
  if (!db.getMaintenance()) return false;
  if (isOwner(msg.from.id)) return false;
  const chatId     = msg.chat.id;
  const userId     = msg.from.id;
  const userPanels = db.getUserPanels(userId);
  if (userPanels.length > 0) {
    
    
    const ownerLink = config.OWNER_USERNAME
      ? `https://t.me/${config.OWNER_USERNAME.replace('@','')}`
      : `https://t.me/${config.OWNER_ID}`;
    await bot.sendMessage(chatId,
      `🔧 <b>Bot sedang dalam Maintenance!</b>\n\nSilakan gunakan menu terbatas:`,
      { parse_mode:'HTML', reply_markup:{ inline_keyboard:[
        [{ text:B('💰 Deposit'),    callback_data:'DEPOSIT_MENU' }],
        [{ text:B('📦 Panel Saya'), callback_data:'MYPANEL:0' }],
        [{ text:B('📞 Hubungi Owner'), url: ownerLink }],
      ]}}
    );
  } else {
    await bot.sendMessage(chatId,
      `🔧 <b>Bot sedang dalam Maintenance!</b>\n\nMohon tunggu hingga maintenance selesai.\nHubungi owner jika ada pertanyaan.`,
      { parse_mode:'HTML' }
    );
  }
  return true;
}

bot.onText(/^\/setqris$/, async (msg) => {
  if (!isOwner(msg.from.id)) return;
  const chatId = msg.chat.id;
  if (!msg.reply_to_message || !msg.reply_to_message.photo) {
    return bot.sendMessage(chatId,
      `📌 <b>Cara pakai:</b>\n\nReply sebuah foto QRIS dengan perintah <code>/setqris</code>\n\nContoh: reply foto QRIS → ketik /setqris`,
      { parse_mode:'HTML' }
    );
  }
  const photos  = msg.reply_to_message.photo;
  const fileId  = photos[photos.length - 1].file_id;
  const caption = msg.reply_to_message.caption || null;
  db.setQrisManual(fileId, caption);
  await bot.sendMessage(chatId,
    `✅ <b>QRIS Manual berhasil disimpan!</b>\n\nGanti gateway ke Manual dari Owner Panel untuk menggunakannya.`,
    { parse_mode:'HTML', reply_markup:{ inline_keyboard:[[{ text:B('👑 Owner Panel'), callback_data:'OWNER_PANEL' }]] } }
  );
});

bot.onText(/^\/start/, async (msg) => {
  if (msg.date < Math.floor(Date.now()/1000)-30) return;
  const chatId = msg.chat.id, from = msg.from;
  const { isNew } = db.upsertUser(from);
  if (isNew) notifNewUser(from).catch(()=>{});

  
  if (db.getMaintenance() && !isOwner(from.id)) {
    const userPanels = db.getUserPanels(from.id);
    if (userPanels.length > 0) {
      const ownerLink = config.OWNER_USERNAME
        ? `https://t.me/${config.OWNER_USERNAME.replace('@','')}`
        : `https://t.me/${config.OWNER_ID}`;
      return bot.sendMessage(chatId,
        `🔧 <b>Bot sedang dalam Maintenance!</b>\n\nMenu terbatas untuk pelanggan aktif:`,
        { parse_mode:'HTML', reply_markup:{ inline_keyboard:[
          [{ text: B('💰 Deposit'), callback_data:'DEPOSIT_MENU' }],
          [{ text: B('📦 Panel Saya'), callback_data:'MYPANEL:0' }],
          [{ text: B('📞 Hubungi Owner'), url: ownerLink }],
        ]} }
      );
    }
    return bot.sendMessage(chatId,
      `🔧 <b>Bot sedang dalam Maintenance!</b>\n\nMohon tunggu hingga maintenance selesai.\nHubungi owner jika ada pertanyaan.`,
      { parse_mode:'HTML' }
    );
  }

  if (!await enforceJoin(chatId, from.id)) return;
  await sendMainMenu(chatId, from);
});
bot.onText(/^\/stopai$/, async (msg) => {
  const chatId = msg.chat.id, from = msg.from;
  if (await maintBlocked(msg)) return;
  if (!csai.isInCsAi(from.id)) {
    return bot.sendMessage(chatId, '❌ Kamu tidak sedang dalam mode CS AI.', { parse_mode:'HTML' });
  }
  csai.exitCsAi(from.id);
  await bot.sendMessage(chatId, `✅ <b>CS AI dihentikan.</b>\n\nKembali ke menu utama:`, { parse_mode:'HTML' });
  await sendMainMenu(chatId, from);
});

bot.onText(/^\/deposit$/, async (msg) => {
  if (msg.date < Math.floor(Date.now()/1000)-30) return;
  const chatId = msg.chat.id, userId = msg.from.id;
  db.upsertUser(msg.from);
  if (await maintBlocked(msg)) return;
  if (!await enforceJoin(chatId, userId)) return;
  await sendDepositMenu(chatId, userId);
});

bot.onText(/^\/bataltrx$/, async (msg) => {
  if (msg.date < Math.floor(Date.now()/1000)-30) return;
  const chatId = msg.chat.id, userId = msg.from.id;
  db.upsertUser(msg.from);
  if (await maintBlocked(msg)) return;
  if (!activeSessions.has(userId)) {
    return bot.sendMessage(chatId,
      `ℹ️ <b>${B('Tidak Ada Transaksi Aktif')}</b>\n\nKamu tidak punya deposit yang sedang berjalan.`,
      { parse_mode:'HTML', reply_markup:{ inline_keyboard:[[{ text: B('💰 Deposit'), callback_data:'DEPOSIT_MENU' }]] } }
    );
  }
  const sess = activeSessions.get(userId);
  const savedOrderId = sess.orderId;
  const savedAmount  = sess.amount;
  await cancelSession(userId);
  await bot.sendMessage(chatId,
    `✅ <b>${B('Transaksi Dibatalkan')}</b>\n\n`+
    `🆔 Order: <code>${savedOrderId}</code>\n`+
    `💰 Nominal: <b>Rp${fmt(savedAmount)}</b>\n\n`+
    `Transaksi berhasil dibatalkan. Kamu bisa deposit ulang sekarang.`,
    { parse_mode:'HTML', reply_markup:{ inline_keyboard:[
      [{ text: B('💰 Deposit Ulang'), callback_data:'DEPOSIT_MENU' }],
      [{ text: B('🏠 Menu Utama'),    callback_data:'MAIN_MENU' }]
    ]}}
  );
});

bot.onText(/^\/add\s+(\+?\d+)\s+(\d+)(?:\s+(.+))?$/, async (msg, match) => {
  if (!isOwner(msg.from.id)) return;
  const number = match[1], price = parseInt(match[2]), v2l = match[3]||null;
  const maskNumber = n => n.slice(0,4)+'****'+n.slice(-2);

  const loadMsg = await bot.sendMessage(msg.chat.id, `⏳ Mengirim OTP...\n📱 Nomor: ${maskNumber(number)}`);
  try {
    const apiId   = parseInt(config.TG_API_ID||'0');
    const apiHash = config.TG_API_HASH||'';
    if (!apiId || !apiHash) throw new Error('TG_API_ID / TG_API_HASH belum diset di config.');
    const { phoneCodeHash } = await gramSendCode(apiId, apiHash, number, config.OWNER_ID);
    db.setAddSession(config.OWNER_ID, { number, v2l, price, phone_code_hash: phoneCodeHash, step:'otp' });
    await bot.editMessageText(
      `✅ OTP Terkirim!\n📱 Nomor: ${maskNumber(number)}\n💰 Harga: Rp${fmt(price)}${v2l?'\n🔑 V2L: tersimpan ✓':''}\n⏳ Timeout: ${config.OTP_ADD_TIMEOUT_MINUTES} menit\n\nKirim kode OTP 👆`,
      { chat_id: msg.chat.id, message_id: loadMsg.message_id }
    );

    setTimeout(async () => {
      const s = db.getAddSession(config.OWNER_ID);
      if (s && s.number === number) {
        db.deleteAddSession(config.OWNER_ID);
        await activeAddClients.get(config.OWNER_ID)?.client.disconnect().catch(()=>{});
        activeAddClients.delete(config.OWNER_ID);
        bot.sendMessage(msg.chat.id, `⏰ OTP Timeout! ${maskNumber(number)} kadaluarsa. /add ulang.`).catch(()=>{});
      }
    }, (config.OTP_ADD_TIMEOUT_MINUTES||5)*60*1000);
  } catch(e) {
    await bot.editMessageText(`❌ Gagal kirim OTP!\n${e.message}\nSilakan /add ulang.`, { chat_id: msg.chat.id, message_id: loadMsg.message_id }).catch(()=>{});
  }
});

bot.onText(/^\/addserver\s+(.+)$/, async (msg, match) => {
  if (!isOwner(msg.from.id)) return;
  const args = match[1].trim().split(/\s+/);
  if (args.length < 6) {
    return bot.sendMessage(msg.chat.id,
      `❌ Format salah!\n\n<code>/addserver domain ptla ptlc 1 5 15</code>\n<code>/addserver domain ptla ptlc 1 5 15,16</code>\n\neg: /addserver https://panel.com PTLA123 PTLC456 1 5 15,16`,
      { parse_mode:'HTML' }
    );
  }
  const [domain, api_key, client_key, location_id, nest_id, egg_raw] = args;
  if (!domain.startsWith('http')) return bot.sendMessage(msg.chat.id, '❌ Domain harus lengkap dengan https://');
  const [locId, nestId] = [parseInt(location_id), parseInt(nest_id)];
  if (isNaN(locId)||isNaN(nestId)) return bot.sendMessage(msg.chat.id, '❌ location_id dan nest_id harus angka!');
  const eggIds = egg_raw.split(',').map(e=>parseInt(e.trim())).filter(e=>!isNaN(e));
  if (!eggIds.length||eggIds.some(e=>![15,16].includes(e)))
    return bot.sendMessage(msg.chat.id, '❌ egg_id harus 15 (JavaScript) atau 16 (Python), bisa 15,16');

  const added = [];
  for (const egg_id of eggIds) {
    const lang = egg_id===15?'JavaScript':'Python';
    const existing = db.getAllServers();
    if (existing.find(s=>s.domain===domain&&s.egg_id===egg_id)) {
      added.push(`⚠️ Server ${lang} di domain ini sudah ada.`); continue;
    }
    const idx  = [...new Set(existing.map(s=>s.domain))].length + 1;
    const name = `SERVER ${idx} (${lang})`;
    db.addServer({ name, domain, api_key, client_key, location_id: locId, nest_id: nestId, egg_id, priority: 0 });
    added.push(`✅ ${name} berhasil ditambahkan`);

    const notifTxt =
      `🆕 <b>Server Panel Baru Tersedia!</b>\n\n`+
      `📡 <b>Bahasa:</b> ${lang}\n`+
      `✅ <b>Status:</b> Aktif & Siap Digunakan\n\n`+
      `Order panel sekarang, proses otomatis! 🚀`;
    const me2 = await bot.getMe().catch(()=>({username:''}));
    const notifKb = { inline_keyboard:[[{ text: B('🛒 Order Panel'), url:`https://t.me/${me2.username}?start=start` }]] };
    try {
      if (config.NOTIF_CHANNEL) await bot.sendMessage(config.NOTIF_CHANNEL, notifTxt, { parse_mode:'HTML', reply_markup: notifKb });
    } catch {}
    (async () => {
      const allUsers = db.getAllUsers();
      let bc=0;
      for (const u of allUsers) {
        try { await bot.sendMessage(u.id, notifTxt, { parse_mode:'HTML', reply_markup: notifKb }); bc++; } catch {}
        await new Promise(r=>setTimeout(r,35));
      }
      log.bcast(`Notif server baru: ${bc}/${allUsers.length} user`);
    })();
  }
  await bot.sendMessage(msg.chat.id, `📡 <b>Hasil Tambah Server:</b>\n\n${added.join('\n')}`, { parse_mode:'HTML' });
});

bot.onText(/^\/delserver\s+(\d+)$/, async (msg, match) => {
  if (!isOwner(msg.from.id)) return;
  const id = parseInt(match[1]);
  const srv = db.getAllServers().find(s=>s.id===id);
  if (!srv) return bot.sendMessage(msg.chat.id, '❌ Server tidak ditemukan.');
  db.removeServer(id);
  await bot.sendMessage(msg.chat.id, `✅ Server <b>${escH(srv.name)}</b> dihapus.`, { parse_mode:'HTML' });
});

bot.onText(/^\/addreq\s+(.+)$/, async (msg, match) => {
  if (!isOwner(msg.from.id)) return;
  const raw = (match[1]||'').trim();
  const m = raw.match(/^@?(\S+)\s+(.+)$/i);
  if (!m) return bot.sendMessage(msg.chat.id,
    `❌ Format: <code>/addreq @username NamaChannel</code>\n\nContoh:\n<code>/addreq @channelgw Toko Official</code>\n<code>/addreq @groupsupport Support Group</code>`,
    { parse_mode:'HTML' });
  const username = m[1].replace(/^@/,''), name = m[2].trim();
  try {
    const chatInfo = await bot.getChat(`@${username}`);
    const type = (chatInfo.type === 'channel') ? 'ch' : 'group';
    const ok = db.addRequiredJoin(type, username, name);
    if (!ok) return bot.sendMessage(msg.chat.id, `❌ @${username} sudah ada di list.`);
    const typeLabel = type === 'ch' ? '📢 Channel' : '👥 Group';
    await bot.sendMessage(msg.chat.id,
      `✅ Berhasil ditambahkan!\n\n${typeLabel}: @${username}\n🏷 Nama Tombol: <b>${escH(name)}</b>`,
      { parse_mode:'HTML' });
  } catch(e) {
    await bot.sendMessage(msg.chat.id, `❌ Gagal verif @${username}: ${e.message}\nPastikan bot sudah masuk ke channel/group tersebut.`);
  }
});

bot.onText(/^\/delreq\s+(\S+)$/, async (msg, match) => {
  if (!isOwner(msg.from.id)) return;
  const uname = match[1].replace(/^@/,'');
  const ok = db.removeRequiredJoin(uname);
  await bot.sendMessage(msg.chat.id, ok ? `✅ @${uname} dihapus.` : `❌ @${uname} tidak ditemukan.`);
});

bot.onText(/^\/listreq$/, async (msg) => {
  if (!isOwner(msg.from.id)) return;
  const list = db.getRequiredJoins();
  if (!list.length) return bot.sendMessage(msg.chat.id, '📋 Tidak ada required join.');
  await bot.sendMessage(msg.chat.id, `📋 <b>Required Join:</b>\n\n`+list.map((r,i)=>`${i+1}. @${r.username} — ${escH(r.name)}`).join('\n'), { parse_mode:'HTML' });
});
bot.onText(/^\/cekserver$/, async (msg) => {
  if (!isOwner(msg.from.id)) return;
  const chatId = msg.chat.id;

  const loading = await bot.sendMessage(chatId, `🔍 <i>Mengecek server...</i>`, { parse_mode: 'HTML' });
  const servers = db.getAllServers();

  if (!servers || servers.length === 0) {
    return bot.editMessageText(`📡 <b>Cek Server</b>\n\n❌ Belum ada server terdaftar.\nGunakan /addserver untuk menambah.`,
      { chat_id: chatId, message_id: loading.message_id, parse_mode: 'HTML' });
  }

  const domainMap = {};
  for (const srv of servers) {
    const key = srv.domain.replace(/https?:\/\//, '').replace(/\/$/, '');
    if (!domainMap[key]) domainMap[key] = { domain: key, entries: [], checked: false, online: false, count: 0 };
    domainMap[key].entries.push(srv);
  }

  await Promise.all(Object.values(domainMap).map(async (d) => {
    const status = await ptero.checkServerStatus(d.entries[0]);
    d.online  = status.success;
    d.count   = status.success ? await ptero.getServerCount(d.entries[0]) : 0;
  }));

  const groups  = Object.values(domainMap);
  const onlineCt  = groups.filter(d => d.online).length;
  const offlineCt = groups.length - onlineCt;

  let lines = [];
  lines.push(`📡 <b>Status Server Panel</b>`);
  lines.push(`✅ ${onlineCt} Online  ❌ ${offlineCt} Offline  •  ${groups.length} Domain\n`);

  groups.forEach((d, i) => {
    const icon = d.online ? '🟢' : '🔴';
    lines.push(`${icon} <code>${d.domain}</code>${d.online ? ` — ${d.count} server` : ' — Offline'}`);
    d.entries.forEach(srv => {
      const egg = srv.egg_id == 15 ? 'JS' : srv.egg_id == 16 ? 'PY' : `Egg${srv.egg_id}`;
      lines.push(`  └ <b>${srv.name||'—'}</b>  <code>#${srv.id}</code>  [${egg}]`);
    });
    if (i < groups.length - 1) lines.push('');
  });

  lines.push(`\n<i>ID digunakan untuk /delserver</i>`);

  await bot.editMessageText(lines.join('\n'), {
    chat_id: chatId, message_id: loading.message_id, parse_mode: 'HTML'
  });
});
bot.onText(/^\/addlink\s+(.+)$/, async (msg, match) => {
  if (!isOwner(msg.from.id)) return;
  const link = match[1].trim();
  db.setSetting('reseller_link', link);
  await bot.sendMessage(msg.chat.id, `✅ Link reseller disimpan:\n${link}`);
});

async function findServerByUuid(servers, uuid) {
  const ax = require('axios');
  for (const srv of servers) {
    try {
      const headers = { Accept:'application/json', Authorization:'Bearer '+srv.api_key };
      let page = 1;
      while (true) {
        const { data } = await ax.get(
          `${srv.domain}/api/application/servers?per_page=100&page=${page}`,
          { headers, timeout: 15000 }
        );
        const entries = data?.data || [];
        for (const item of entries) {
          const a = item.attributes || item;
          if (a.uuid === uuid || a.identifier === uuid || a.uuid?.startsWith(uuid)) {
            return { srv, internalId: a.id, serverName: a.name || uuid };
          }
        }
        const pg = data?.meta?.pagination;
        if (!pg || pg.current_page >= pg.total_pages) break;
        page++;
      }
    } catch {}
  }
  return null;
}

bot.onText(/^\/suspend\s+(\S+)(?:\s+([\s\S]+))?$/, async (msg, match) => {
  if (!isOwner(msg.from.id)) return;
  const chatId  = msg.chat.id;
  const uuid    = match[1].trim();
  const alasan  = (match[2] || '').trim() || 'Tidak disebutkan';
  const servers = db.getAllServers();
  if (!servers.length) return bot.sendMessage(chatId, '❌ Tidak ada server terdaftar.', { parse_mode:'HTML' });

  const load = await bot.sendMessage(chatId, `⏳ <i>Mencari server <code>${escH(uuid)}</code>...</i>`, { parse_mode:'HTML' });

  const found = await findServerByUuid(servers, uuid);
  if (!found) {
    return bot.editMessageText(
      `❌ UUID <code>${escH(uuid)}</code> tidak ditemukan di semua panel.`,
      { chat_id: chatId, message_id: load.message_id, parse_mode:'HTML' }
    );
  }

  const { srv, internalId, serverName } = found;

  try {
    await ptero.suspendServer(srv, internalId);

    const panelRec = db.getPanelByUuid(uuid);
    if (panelRec) {
      db.setPanelExpiry(uuid, Date.now());
      if (_suspendTimers.has(uuid)) { clearTimeout(_suspendTimers.get(uuid)); _suspendTimers.delete(uuid); }
      const allP = db.getAllPanelRecords();
      const prr  = allP.find(x => x.uuid === uuid);
      if (prr) { prr.suspended = true; prr.suspended_at = Date.now(); db._setPanels(allP); }
      const deleteAt = Date.now() + 3 * 24 * 60 * 60 * 1000;
      db.addPendingDeletion({
        uuid,
        owner_id          : panelRec.owner_id,
        server_internal_id: internalId,
        ptero_user_id     : null,
        delete_at         : deleteAt,
        domain            : srv.domain,
        server_name       : serverName,
      });
    }

    const uuidSensor = uuid.length > 4 ? uuid.slice(0, 4) + '****' : '****';

    await bot.editMessageText(
      `✅ <b>Server disuspend!</b>\n🆔 UUID: <code>${escH(uuid)}</code>\n🖥️ Server: ${escH(serverName)}\n📦 Panel: ${escH(srv.domain)}\n📋 Alasan: ${escH(alasan)}\n\n⚠️ Masa aktif panel telah dihabiskan.\n🗑️ Server akan dihapus otomatis dalam <b>3 hari</b>.`,
      { chat_id: chatId, message_id: load.message_id, parse_mode:'HTML' }
    );

    
    const ownerName = panelRec?.owner_username ? `@${panelRec.owner_username}` : (panelRec?.owner_id ? `ID:${panelRec.owner_id}` : '—');
    const planLabel = panelRec ? (PANEL_PLANS.find(x=>x.key===panelRec.plan_key)?.label || panelRec.plan_key) : '—';

    
    if (panelRec) {
      try {
        await bot.sendMessage(panelRec.owner_id,
          `🔴 <b>${B('PANEL KAMU DISUSPEND')}</b>\n\n` +
          `📛 Server: <b>${escH(serverName)}</b>\n` +
          `📋 Alasan: <b>${escH(alasan)}</b>\n\n` +
          `⚠️ <b>Masa aktif panel telah dihabiskan.</b>\n` +
          `🗑️ Server akan dihapus permanen dalam <b>3 hari</b> jika tidak ada tindak lanjut.\n\n` +
          `Hubungi owner untuk perpanjang atau info lebih lanjut.`,
          { parse_mode:'HTML' });
      } catch {}
    }

    const channelText =
      `🔴 <b>Server Disuspend</b>\n\n` +
      `🆔 UUID: <code>${escH(uuidSensor)}</code>\n` +
      `🖥️ Server: ${escH(serverName)}\n` +
      `👤 Pemilik: ${escH(ownerName)}\n` +
      `📦 Plan: ${escH(planLabel)}\n` +
      `📋 Alasan: ${escH(alasan)}\n\n` +
      `<i>Akan dihapus otomatis dalam 3 hari.</i>`;
    await bot.sendMessage(config.NOTIF_CHANNEL, channelText, { parse_mode:'HTML' }).catch(() => {});

  } catch (e) {
    await bot.editMessageText(
      `❌ <b>Gagal suspend:</b>\n<code>${escH(e.message)}</code>`,
      { chat_id: chatId, message_id: load.message_id, parse_mode:'HTML' }
    );
  }
});

bot.onText(/^\/unsuspend\s+(\S+)$/, async (msg, match) => {
  if (!isOwner(msg.from.id)) return;
  const chatId  = msg.chat.id;
  const uuid    = match[1].trim();
  const servers = db.getAllServers();
  if (!servers.length) return bot.sendMessage(chatId, '❌ Tidak ada server terdaftar.', { parse_mode:'HTML' });

  const load = await bot.sendMessage(chatId, `⏳ <i>Mencari server <code>${escH(uuid)}</code>...</i>`, { parse_mode:'HTML' });

  const found = await findServerByUuid(servers, uuid);
  if (!found) {
    return bot.editMessageText(
      `❌ UUID <code>${escH(uuid)}</code> tidak ditemukan di semua panel.`,
      { chat_id: chatId, message_id: load.message_id, parse_mode:'HTML' }
    );
  }

  const { srv, internalId, serverName } = found;
  try {
    await ptero.unsuspendServer(srv, internalId);
    await bot.editMessageText(
      `✅ <b>Server aktif kembali!</b>\n🆔 UUID: <code>${escH(uuid)}</code>\n🖥️ Server: ${escH(serverName)}\n📦 Panel: ${escH(srv.domain)}`,
      { chat_id: chatId, message_id: load.message_id, parse_mode:'HTML' }
    );
  } catch (e) {
    await bot.editMessageText(
      `❌ <b>Gagal unsuspend:</b>\n<code>${escH(e.message)}</code>`,
      { chat_id: chatId, message_id: load.message_id, parse_mode:'HTML' }
    );
  }
});

const listsrvState = new Map(); 

async function sendListsrvPage(chatId, msgId, page) {
  const state = listsrvState.get(chatId);
  if (!state) return;
  const { items } = state;
  const PER_PAGE = 5;
  const total    = items.length;
  const maxPage  = Math.max(0, Math.ceil(total / PER_PAGE) - 1);
  page = Math.min(Math.max(0, page), maxPage);
  state.page = page;

  const slice = items.slice(page * PER_PAGE, page * PER_PAGE + PER_PAGE);
  const now   = Date.now();
  const lines = [`📋 <b>${B('DAFTAR SERVER')}</b> (${total} total — hal ${page+1}/${maxPage+1})\n`];
  for (let i = 0; i < slice.length; i++) {
    const it    = slice[i];
    const no    = page * PER_PAGE + i + 1;
    const status = it.suspended ? '🔴' : '🟢';
    const rec   = db.getPanelByUuid(it.uuid);
    const owner = rec ? (rec.owner_username ? `@${rec.owner_username}` : `ID:${rec.owner_id}`) : '—';
    const ownerId = rec?.owner_id || '—';
    const expiry = rec ? (rec.expiry_ms > now ? fmtDurasi(rec.expiry_ms - now) : '⛔ Habis') : '—';
    lines.push(
      `${no}. ${status} <b>${escH(it.name)}</b>\n` +
      `   UUID: <code>${it.uuid}</code>\n` +
      `   Pemilik: ${escH(owner)} (<code>${ownerId}</code>)\n` +
      `   Masa Aktif: <b>${expiry}</b>`
    );
  }

  const nav = [];
  if (page > 0)        nav.push({ text: '◀️ Prev', callback_data:`LISTSRV_PAGE:${page-1}` });
  if (page < maxPage)  nav.push({ text: 'Next ▶️', callback_data:`LISTSRV_PAGE:${page+1}` });
  const kb = { inline_keyboard: [
    ...(nav.length ? [nav] : []),
    [{ text: B('🔄 Refresh'), callback_data:'LISTSRV_PAGE:0' }]
  ]};
  const text = lines.join('\n');
  if (msgId) {
    try { await bot.editMessageText(text, { chat_id: chatId, message_id: msgId, parse_mode:'HTML', reply_markup: kb }); return; } catch {}
  }
  await bot.sendMessage(chatId, text, { parse_mode:'HTML', reply_markup: kb });
}

bot.onText(/^\/listsrv$/, async (msg) => {
  if (!isOwner(msg.from.id)) return;
  const chatId  = msg.chat.id;
  const servers = db.getAllServers();
  if (!servers.length) return bot.sendMessage(chatId, '❌ Tidak ada server terdaftar.', { parse_mode:'HTML' });

  const domainMap = {};
  for (const s of servers) { if (!domainMap[s.domain]) domainMap[s.domain] = s; }
  const panels = Object.values(domainMap);

  const load = await bot.sendMessage(chatId, `⏳ <i>Mengambil daftar server...</i>`, { parse_mode:'HTML' });
  const allItems = [];
  for (const srv of panels) {
    try {
      let page = 1;
      while (true) {
        const resp = await ptero.listAllServers(srv, page);
        for (const item of (resp.data || [])) allItems.push({ ...(item.attributes||item), _domain: srv.domain });
        if (!resp.meta?.pagination || resp.meta.pagination.current_page >= resp.meta.pagination.total_pages) break;
        page++;
      }
    } catch {}
  }
  await tryDel(chatId, load.message_id);
  if (!allItems.length) return bot.sendMessage(chatId, '📭 Tidak ada server ditemukan.', { parse_mode:'HTML' });
  listsrvState.set(chatId, { items: allItems, page: 0 });
  await sendListsrvPage(chatId, null, 0);
});

bot.onText(/^\/scanall$/, async (msg) => {
  if (!isOwner(msg.from.id)) return;
  await aiscan.scanAllPanels(bot, msg.chat.id, db, config.OWNER_ID);
});

bot.on('message', async (msg) => {
  if (!msg.text || !/^\/addproduk(\s|$)/i.test(msg.text)) return;
  if (!isOwner(msg.from.id)) return;
  const rawFull = msg.text.replace(/^\/addproduk\s*/i, '').trim();
  if (!rawFull) return bot.sendMessage(msg.chat.id,
    `❌ Format:\n<b>Teks/Link:</b> <code>/addproduk Nama | Harga | Isi/Link</code>\n(deskripsi bisa di baris bawahnya)\n\nContoh:\n<code>/addproduk Auto Order v2.1 | 15000 | https://link.sc\n- Payment gateway 2\n- database .json</code>`,
    { parse_mode:'HTML' });
  const pipeIdx1 = rawFull.indexOf('|');
  const pipeIdx2 = pipeIdx1 >= 0 ? rawFull.indexOf('|', pipeIdx1+1) : -1;
  const pipeIdx3 = pipeIdx2 >= 0 ? rawFull.indexOf('|', pipeIdx2+1) : -1;
  const rawParts = pipeIdx1<0 ? [rawFull] :
                   pipeIdx2<0 ? [rawFull.slice(0,pipeIdx1), rawFull.slice(pipeIdx1+1)] :
                   [rawFull.slice(0,pipeIdx1), rawFull.slice(pipeIdx1+1,pipeIdx2), rawFull.slice(pipeIdx2+1)];
  const parts = rawParts.map(s=>s.trim());
  const raw = rawFull; 

  const replyMsg = msg.reply_to_message;
  const fileId   = replyMsg?.document?.file_id || replyMsg?.video?.file_id || replyMsg?.audio?.file_id || null;
  const fileName = replyMsg?.document?.file_name || replyMsg?.video?.file_name || replyMsg?.audio?.file_name || null;

  if (fileId) {

    if (parts.length < 2) return bot.sendMessage(msg.chat.id,
      `❌ Format (reply file): /addproduk Nama | Harga | Deskripsi(opsional)\n\nContoh (reply ke file):\n<code>/addproduk SC ORDER VPS | 5000</code>`,
      { parse_mode:'HTML' });
    const nama  = parts[0];
    const harga = parseInt(parts[1]);
    const deskr = parts[2] || '';
    if (!nama || isNaN(harga) || harga <= 0) return bot.sendMessage(msg.chat.id, '❌ Nama dan harga harus valid.');
    const p = db.addProduk({ nama, harga, deskripsi: deskr, isi: '', file_id: fileId, file_name: fileName||nama });
    await bot.sendMessage(msg.chat.id,
      `✅ <b>Produk ditambahkan!</b>\n\n📦 ${escH(nama)}\n💰 Rp${fmt(harga)}\n📎 File: <code>${escH(fileName||'-')}</code>${deskr?`\n📝 ${escH(deskr)}`:''}`,
      { parse_mode:'HTML' });
    const me3f = await bot.getMe().catch(()=>({username:''}));
    const notifF = `🆕 <b>Produk/Script Baru Tersedia!</b>\n\n📦 <b>${escH(nama)}</b>\n`+(deskr?`📝 ${escH(deskr)}\n`:'')+`\nCek harga & beli langsung di bot! 🛒`;
    const notifKbF = { inline_keyboard:[[{ text: B('📂 Lihat Script'), url:`https://t.me/${me3f.username}?start=start` }]] };
    try { if (config.NOTIF_CHANNEL) await bot.sendMessage(config.NOTIF_CHANNEL, notifF, { parse_mode:'HTML', reply_markup: notifKbF }); } catch {}
    (async () => {
      const allUsers = db.getAllUsers(); let bc=0;
      for (const u of allUsers) {
        try { await bot.sendMessage(u.id, notifF, { parse_mode:'HTML', reply_markup: notifKbF }); bc++; } catch {}
        await new Promise(r=>setTimeout(r,35));
      }
      log.bcast(`Notif produk baru: ${bc}/${allUsers.length} user`);
    })();
    return;
  }

  if (parts.length < 3) return bot.sendMessage(msg.chat.id,
    `❌ Format:\n<b>Teks/Link:</b>\n<code>/addproduk Nama | Harga | Isi/Link</code>\n(deskripsi boleh ditulis di baris bawah isi)\n\n<b>File:</b> Reply ke file lalu:\n<code>/addproduk Nama | Harga | Deskripsi(opsional)</code>\n\n<b>Contoh dengan deskripsi panjang:</b>\n<code>/addproduk Auto Order v2.1 | 15000 | https://link.sc\n- Payment gateway 2 (atl &amp; Pakasir)\n- database pakai .json\n- setting dari bot</code>`,
    { parse_mode:'HTML' });
  const nama  = parts[0];
  const harga = parseInt(parts[1]);
  const isiDeskrRaw = parts[2] || '';
  const newlineIdx  = isiDeskrRaw.indexOf('\n');
  const isi   = newlineIdx >= 0 ? isiDeskrRaw.slice(0, newlineIdx).trim() : isiDeskrRaw.trim();
  const deskr = newlineIdx >= 0 ? isiDeskrRaw.slice(newlineIdx+1).trim() : (parts[3] || '');
  if (!nama || isNaN(harga) || harga <= 0) return bot.sendMessage(msg.chat.id, '❌ Nama dan harga harus valid.');
  if (!isi) return bot.sendMessage(msg.chat.id, '❌ Isi/link produk wajib diisi (bagian ke-3).');
  const p = db.addProduk({ nama, harga, deskripsi: deskr, isi, file_id: null, file_name: null });
  await bot.sendMessage(msg.chat.id,
    `✅ <b>Produk ditambahkan!</b>\n\n📦 ${escH(nama)}\n💰 Rp${fmt(harga)}\n📎 Isi: <code>${escH(isi)}</code>${deskr?`\n📝 ${escH(deskr)}`:''}`,
    { parse_mode:'HTML' });

  const me3 = await bot.getMe().catch(()=>({username:''}));
  const notifProduk =
    `🆕 <b>Produk/Script Baru Tersedia!</b>\n\n`+
    `📦 <b>${escH(nama)}</b>\n`+
    (deskr ? `📝 ${escH(deskr)}\n` : '')+
    `\nCek harga & beli langsung di bot! 🛒`;
  const notifKbProduk = { inline_keyboard:[[{ text: B('📂 Lihat Script'), url:`https://t.me/${me3.username}?start=start` }]] };
  try {
    if (config.NOTIF_CHANNEL) await bot.sendMessage(config.NOTIF_CHANNEL, notifProduk, { parse_mode:'HTML', reply_markup: notifKbProduk });
  } catch {}
  (async () => {
    const allUsers = db.getAllUsers();
    let bc=0;
    for (const u of allUsers) {
      try { await bot.sendMessage(u.id, notifProduk, { parse_mode:'HTML', reply_markup: notifKbProduk }); bc++; } catch {}
      await new Promise(r=>setTimeout(r,35));
    }
    log.bcast(`Notif produk baru: ${bc}/${allUsers.length} user`);
  })();
});

bot.onText(/^\/delproduk\s+(\d+)$/, async (msg, match) => {
  if (!isOwner(msg.from.id)) return;
  const id  = parseInt(match[1]);
  const p   = db.getProdukById(id);
  if (!p) return bot.sendMessage(msg.chat.id, '❌ Produk tidak ditemukan.');
  db.deleteProduk(id);
  await bot.sendMessage(msg.chat.id, `✅ Produk <b>${escH(p.nama)}</b> dihapus.`, { parse_mode:'HTML' });
});

bot.onText(/^\/listproduk$/, async (msg) => {
  if (!isOwner(msg.from.id)) return;
  const list = db.getAllProduk();
  if (!list.length) return bot.sendMessage(msg.chat.id, '📂 Belum ada produk.\n<code>/addproduk nama | harga</code>', { parse_mode:'HTML' });
  const text = list.map((p,i)=>`${i+1}. <b>${escH(p.nama)}</b> — Rp${fmt(p.harga)}\n   ID: <code>${p.id}</code>`).join('\n\n');
  await bot.sendMessage(msg.chat.id, `📂 <b>Daftar Produk:</b>\n\n${text}`, { parse_mode:'HTML' });
});

bot.onText(/^\/ceksaldo(?:\s+(\S+))?$/, async (msg, match) => {
  if (!isOwner(msg.from.id)) return;
  const target = (match[1] || '').trim();
  if (!target) return bot.sendMessage(msg.chat.id, '❌ Format: <code>/ceksaldo &lt;id&gt;</code> atau <code>/ceksaldo @username</code>', { parse_mode:'HTML' });
  let u = null;
  if (target.startsWith('@')) u = db.getUserByUsername(target.slice(1));
  else if (/^\d+$/.test(target)) u = db.getUser(parseInt(target));
  else u = db.getUserByUsername(target);
  if (!u) return bot.sendMessage(msg.chat.id, `❌ User <code>${escH(target)}</code> tidak ditemukan.`, { parse_mode:'HTML' });
  const uname = u.username ? `@${u.username}` : '-';
  await bot.sendMessage(msg.chat.id,
    `💰 <b>Info Saldo User</b>\n\n` +
    `👤 Nama     : <b>${escH(u.first_name)}</b>\n` +
    `🆔 ID       : <code>${u.id}</code>\n` +
    `📛 Username : ${escH(uname)}\n` +
    `💳 Saldo    : <b>Rp${fmt(u.balance || 0)}</b>`,
    { parse_mode:'HTML' });
});

bot.onText(/^\/addsaldo\s+(\S+)\s+([+-]?\d+)$/, async (msg, match) => {
  if (!isOwner(msg.from.id)) return;
  const target = match[1].trim();
  const amt    = parseInt(match[2]);
  if (isNaN(amt) || amt === 0) return bot.sendMessage(msg.chat.id, '❌ Jumlah tidak valid. Contoh: /addsaldo @user 5000 atau /addsaldo @user -2000', { parse_mode:'HTML' });
  let u = null;
  if (target.startsWith('@')) u = db.getUserByUsername(target.slice(1));
  else if (/^\d+$/.test(target)) u = db.getUser(parseInt(target));
  else u = db.getUserByUsername(target);
  if (!u) return bot.sendMessage(msg.chat.id, `❌ User <code>${escH(target)}</code> tidak ditemukan.`, { parse_mode:'HTML' });
  const saldobefore = u.balance || 0;
  if (amt > 0) {
    db.addBalance(u.id, amt);
  } else {
    const kurang = Math.abs(amt);
    if (saldobefore < kurang) return bot.sendMessage(msg.chat.id, `❌ Saldo tidak cukup.\nSaldo: <b>Rp${fmt(saldobefore)}</b> | Kurangi: <b>Rp${fmt(kurang)}</b>`, { parse_mode:'HTML' });
    db.deductBalance(u.id, kurang);
  }
  const saldoAfter = db.getBalance(u.id);
  const sign       = amt > 0 ? `+Rp${fmt(amt)}` : `-Rp${fmt(Math.abs(amt))}`;
  const uname      = u.username ? `@${u.username}` : String(u.id);
  await bot.sendMessage(msg.chat.id,
    `✅ <b>Saldo diperbarui</b>\n\n` +
    `👤 User      : ${escH(uname)} (<code>${u.id}</code>)\n` +
    `📊 Perubahan : <b>${sign}</b>\n` +
    `💳 Sebelum   : Rp${fmt(saldobefore)}\n` +
    `💳 Sesudah   : <b>Rp${fmt(saldoAfter)}</b>`,
    { parse_mode:'HTML' });
});

function createBackupZip() {
  return new Promise((resolve, reject) => {
    const chunks = [];
    const archive = archiver('zip', { zlib: { level: 6 } });
    archive.on('data',    chunk => chunks.push(chunk));
    archive.on('end',     ()    => resolve(Buffer.concat(chunks)));
    archive.on('error',   err   => reject(err));

    const dbDir = db.getDbDir();
    const files = db.getDbFiles();
    for (const { file } of files) {
      if (fs.existsSync(file)) {
        archive.file(file, { name: require('path').basename(file) });
      }
    }
    archive.finalize();
  });
}
const cairkanPending = new Map(); 

bot.onText(/^\/cairkan(?:\s+(\S+)\s+(\S+)\s+(.+))?$/, async (msg, match) => {
  const chatId = msg.chat.id, userId = msg.from.id;
  if (!isOwner(userId)) return;

  const kodeBank    = (match[1] || '').toLowerCase().trim();
  const nomorAkun   = (match[2] || '').trim();
  const namaPemilik = (match[3] || '').trim();

  if (!kodeBank || !nomorAkun || !namaPemilik) {
    return bot.sendMessage(chatId,
      `❌ <b>Format salah!</b>\n\n` +
      `Gunakan: <code>/cairkan &lt;ewallet&gt; &lt;nomor&gt; &lt;atas nama&gt;</code>\n\n` +
      `Contoh:\n` +
      `• <code>/cairkan gopay 082131053393 Firnando</code>\n` +
      `• <code>/cairkan dana 082131053393 Budi Santoso</code>`,
      { parse_mode: 'HTML' });
  }

  const wait = await bot.sendMessage(chatId, '⏳ Mengambil saldo Atlantic...', { parse_mode: 'HTML' });
  let saldoRaw = 0;
  try {
    const profile = await pg.getAtlanticProfile();
    saldoRaw = parseInt(profile.balance || profile.saldo || profile.amount || 0);
  } catch (e) {
    await bot.deleteMessage(chatId, wait.message_id).catch(() => {});
    return bot.sendMessage(chatId, `❌ Gagal ambil saldo: <code>${escH(_errMsg(e))}</code>`, { parse_mode: 'HTML' });
  }
  await bot.deleteMessage(chatId, wait.message_id).catch(() => {});

  const fee     = 2000;
  const nominal = Math.max(0, saldoRaw - fee);

  if (nominal <= 0) {
    return bot.sendMessage(chatId,
      `❌ Saldo tidak cukup.\nSaldo: <b>Rp${fmt(saldoRaw)}</b> (min fee Rp${fmt(fee)})`,
      { parse_mode: 'HTML' });
  }

  cairkanPending.set(userId, { kodeBank, nomorAkun, namaPemilik, nominal, saldoRaw });

  await bot.sendMessage(chatId,
    `📋 <b>Konfirmasi Pencairan</b>\n\n` +
    `💰 Saldo   : <b>Rp${fmt(saldoRaw)}</b>\n` +
    `━━━━━━━━━━━━━━━━━\n` +
    `🏦 EWallet : <b>${escH(kodeBank.toUpperCase())}</b>\n` +
    `🔢 Nomor   : <b>${escH(nomorAkun)}</b>\n` +
    `👤 Nama    : <b>${escH(namaPemilik)}</b>\n` +
    `💸 Nominal : <b>Rp${fmt(nominal)}</b>\n` +
    `━━━━━━━━━━━━━━━━━\n\n` +
    `Lanjutkan pencairan?`,
    {
      parse_mode: 'HTML',
      reply_markup: { inline_keyboard: [[
        { text: '✅ Lanjutkan', callback_data: 'CAIRKAN_CONFIRM' },
        { text: '❌ Batal',     callback_data: 'CAIRKAN_CANCEL'  }
      ]]}
    });
});

bot.onText(/^\/backup$/, async (msg) => {
  if (!isOwner(msg.from.id)) return;
  const waitMsg = await bot.sendMessage(msg.chat.id, '⏳ Membuat backup ZIP...');
  try {
    const now    = new Date().toLocaleString('id-ID',{timeZone:'Asia/Jakarta'})
                     .replace(/[/:]/g,'-').replace(/,/,'').replace(/ /g,'_');
    const zipBuf = await createBackupZip();
    const files  = db.getDbFiles();
    const caption =
      `🗄️ <b>Backup Database</b>\n`+
      `🕐 ${new Date().toLocaleString('id-ID',{timeZone:'Asia/Jakarta'})} WIB\n`+
      `📦 ${files.length} file terkemas\n`+
      `💾 ${(zipBuf.length/1024).toFixed(1)} KB`;
    await tryDel(msg.chat.id, waitMsg.message_id);
    await bot.sendDocument(msg.chat.id, zipBuf,
      { caption, parse_mode:'HTML' },
      { filename:`backup-db-${now}.zip`, contentType:'application/zip' }
    );
  } catch(e) {
    await tryDel(msg.chat.id, waitMsg.message_id);
    await bot.sendMessage(msg.chat.id, `❌ Backup gagal: ${escH(e.message)}`);
  }
});

bot.onText(/^\/dbrestore$/, async (msg) => {
  if (!isOwner(msg.from.id)) return;
  if (!msg.reply_to_message?.document) {
    return bot.sendMessage(msg.chat.id,
      `❌ <b>Cara pakai:</b>\n`+
      `Reply file <code>.json</code> atau <code>.zip</code> lalu kirim <code>/dbrestore</code>\n\n`+
      `ℹ️ File .zip = backup ZIP terbaru\nFile .json = backup legacy (1 file)`,
      { parse_mode:'HTML' });
  }
  const doc = msg.reply_to_message.document;
  const fname = doc.file_name || '';
  const isZip  = fname.endsWith('.zip');
  const isJson = fname.endsWith('.json');
  if (!isZip && !isJson) {
    return bot.sendMessage(msg.chat.id, '❌ File harus <code>.zip</code> atau <code>.json</code>', { parse_mode:'HTML' });
  }
  const waitMsg = await bot.sendMessage(msg.chat.id, '⏳ Mengunduh & memvalidasi...');
  try {
    const url       = await bot.getFileLink(doc.file_id);
    const { data: rawData } = await axios.get(url, { responseType: isZip ? 'arraybuffer' : 'text', timeout: 30000 });

    let stats;
    if (isZip) {

      const AdmZip = require('adm-zip');
      const zip    = new AdmZip(Buffer.from(rawData));
      const entries = zip.getEntries();
      const merged  = {};

      const keyMap = {
        'users.json'    : 'users',
        'trx.json'      : 'transactions',
        'nokos.json'    : '_nokos_raw',
        'servers.json'  : 'servers',
        'settings.json' : 'settings',
        'sessions.json' : 'add_sessions',
        'produk.json'   : 'produk',
      };
      for (const entry of entries) {
        const key = keyMap[entry.entryName];
        if (!key) continue;
        try {
          const parsed = JSON.parse(entry.getData().toString('utf8'));
          if (key === '_nokos_raw') {
            merged.nokos        = Array.isArray(parsed) ? parsed : (parsed.items  || []);
            merged.nokos_orders = Array.isArray(parsed) ? []     : (parsed.orders || []);
          } else {
            merged[key] = parsed;
          }
        } catch(pe) { throw new Error(`File ${entry.entryName} tidak valid JSON: ${pe.message}`); }
      }
      if (!merged.users)    throw new Error('File users.json tidak ditemukan di ZIP.');
      if (!merged.settings) throw new Error('File settings.json tidak ditemukan di ZIP.');
      stats = db.restoreFromJson(JSON.stringify(merged));
    } else {

      stats = db.restoreFromJson(rawData);
    }

    await tryDel(msg.chat.id, waitMsg.message_id);
    await bot.sendMessage(msg.chat.id,
      `✅ <b>Restore Berhasil!</b>\n\n`+
      `👥 Users       : <b>${stats.users}</b>\n`+
      `💳 Transaksi   : <b>${stats.transactions}</b>\n`+
      `📱 Nokos       : <b>${stats.nokos}</b>\n`+
      `📡 Servers     : <b>${stats.servers}</b>\n`+
      `📦 Produk      : <b>${stats.produk}</b>`,
      { parse_mode:'HTML' }
    );
  } catch(e) {
    await tryDel(msg.chat.id, waitMsg.message_id);
    await bot.sendMessage(msg.chat.id, `❌ <b>Restore Gagal!</b>\n\n${escH(e.message)}`, { parse_mode:'HTML' });
  }
});

bot.on('message', async (msg) => {
  if (!msg.text||msg.text.startsWith('/')) return;
  if (msg.date < Math.floor(Date.now()/1000)-30) return;
  const chatId = msg.chat.id, userId = msg.from.id, from = msg.from;
  db.upsertUser(from);

  if (csai.isInCsAi(userId)) {
    await csai.handleCsAiText(bot, chatId, userId, msg.text);
    return;
  }

  const st = userStates.get(userId);
  if (!st) return;

  if (st.state === 'WAITING_DEPOSIT') {
    if (!await enforceJoin(chatId, userId)) return;
    await processDeposit(chatId, userId, from, msg.text);
    return;
  }

  if (st.state === 'WAITING_PANEL_USERNAME') {
    userStates.delete(userId);
    if (!await enforceJoin(chatId, userId)) return;
    await tryDel(chatId, msg.message_id);
    await tryDel(chatId, st.promptMsgId);
    await handlePanelUsername(chatId, userId, from, msg.text.trim());
    return;
  }

  
  if (st.state === 'WAITING_EX_SERVER_NAME') {
    if (!await enforceJoin(chatId, userId)) return;
    await tryDel(chatId, msg.message_id);
    const rawName = msg.text.trim().toLowerCase().replace(/[^a-z0-9_]/g,'');
    if (!rawName || rawName.length < 3 || rawName.length > 24) {
      const errMsg = await bot.sendMessage(chatId,
        `❌ ${B('Nama server tidak valid!')} Min 3 karakter, hanya huruf kecil/angka/underscore.\n\nSilakan ketik ulang:`,
        { parse_mode:'HTML', reply_markup:{ inline_keyboard:[
          [{ text: B('❌ Batal'), callback_data:'LAYANAN_MENU' }]
        ]}}
      );
      userStates.set(userId, { ...st, promptMsgId: errMsg.message_id });
      return;
    }

    const { pteroUsername, panelDomain, pteroEmail } = st;
    
    userStates.set(userId, { ...st, state:'WAITING_EX_TYPE', exServerName: rawName });

    
    if (st.promptMsgId) await tryDel(chatId, st.promptMsgId);
    const typeText =
      `📡 <b>${B('PILIH TIPE PANEL')}</b>\n\n` +
      `👤 ${B('Akun')}: <code>${pteroUsername}</code>\n` +
      `📧 ${B('Email')}: <code>${pteroEmail}</code>\n` +
      `🖥️ ${B('Nama Server')}: <code>${rawName}</code>\n\n` +
      `Pilih bahasa/runtime server kamu:`;
    const typeKb = { inline_keyboard: [
      [
        { text: '⚡ Node.js', callback_data:'PANEL_EX_TYPE:js' },
        { text: '🐍 Python',  callback_data:'PANEL_EX_TYPE:py' }
      ],
      [{ text: B('⬅️ Kembali'), callback_data:'MENU_PANEL' }],
      [{ text: B('❌ Batal'), callback_data:'LAYANAN_MENU' }]
    ]};
    await bot.sendMessage(chatId, typeText, { parse_mode:'HTML', reply_markup:typeKb });
    return;
  }

  if (st.state === 'WAITING_ADP_USERNAME') {
    userStates.delete(userId);
    if (!await enforceJoin(chatId, userId)) return;
    const rawUsername = msg.text.trim().toLowerCase().replace(/[^a-z0-9_]/g,'');
    await tryDel(chatId, msg.message_id);
    if (!rawUsername || rawUsername.length < 3 || rawUsername.length > 24) {
      const errMsg = await bot.sendMessage(chatId,
        `❌ ${B('Username tidak valid!')} Min 3 karakter, hanya huruf kecil/angka/underscore.\n\nSilakan ketik ulang:`,
        { parse_mode:'HTML', reply_markup:{ inline_keyboard:[[{ text: B('❌ Batal'), callback_data:'LAYANAN_MENU' }]] } }
      );

      await tryDel(chatId, st.promptMsgId);
      userStates.set(userId, { state:'WAITING_ADP_USERNAME', promptMsgId: errMsg.message_id });
      return;
    }
    await tryDel(chatId, st.promptMsgId);
    await handleAdminOrder(chatId, userId, from, rawUsername);
    return;
  }

  if (st.state === 'WAITING_RESELLER_TGID') {
    userStates.delete(userId);
    if (!await enforceJoin(chatId, userId)) return;
    const tgId = msg.text.trim();
    if (isNaN(parseInt(tgId))) return bot.sendMessage(chatId, '❌ ID Telegram harus berupa angka!');
    await tryDel(chatId, st.promptMsgId);
    await handleResellerOrder(chatId, userId, from, tgId);
    return;
  }

  if (isOwner(userId) && st.state === 'WAITING_SETHARGA') {
    userStates.delete(userId);
    const { planKey, durKey, promptMsgId } = st;
    const amt = parseInt(msg.text.trim().replace(/\D/g,''));
    await tryDel(chatId, promptMsgId);
    await tryDel(chatId, msg.message_id);
    if (isNaN(amt) || amt < 0) {
      await bot.sendMessage(chatId, '❌ Harga tidak valid. Harus angka.', { parse_mode:'HTML' });
      return sendOwnerSetHargaPlanDur(chatId, planKey, null);
    }
    db.setSetting(`harga_${planKey}_${durKey}`, amt);
    const plan = PANEL_PLANS.find(p=>p.key===planKey);
    const dur  = PANEL_DURATIONS.find(d=>d.key===durKey);
    await bot.sendMessage(chatId,
      `✅ <b>Harga diperbarui!</b>\n\n📦 ${plan?.label||planKey} | ${dur?.label||durKey}\n💰 Harga baru: <b>Rp${fmt(amt)}</b>`,
      { parse_mode:'HTML' });
    return sendOwnerSetHargaPlanDur(chatId, planKey, null);
  }

  if (isOwner(userId) && st.state === 'WAITING_SETHARGA_SINGLE') {
    userStates.delete(userId);
    const { settingKey, label, promptMsgId } = st;
    const amt = parseInt(msg.text.trim().replace(/\D/g,''));
    await tryDel(chatId, promptMsgId);
    await tryDel(chatId, msg.message_id);
    if (isNaN(amt) || amt < 0) {
      await bot.sendMessage(chatId, '❌ Harga tidak valid. Harus angka.', { parse_mode:'HTML' });
      return sendOwnerSetHargaMenu(chatId, null);
    }
    db.setSetting(settingKey, amt);
    await bot.sendMessage(chatId,
      `✅ <b>Harga diperbarui!</b>\n\n📦 ${label}\n💰 Harga baru: <b>Rp${fmt(amt)}</b>`,
      { parse_mode:'HTML' });
    return sendOwnerSetHargaMenu(chatId, null);
  }

  if (isOwner(userId)) {
    const sess = db.getAddSession(config.OWNER_ID);
    if (sess) {
      const otp  = msg.text.trim();
      const chatOwn = msg.chat.id;
      if (sess.step === 'otp') {
        await bot.sendMessage(chatOwn, `⏳ ${B('Memverifikasi OTP...')}`);
        try {
          const sigResult = await gramSignIn(config.OWNER_ID, { phoneNumber: sess.number, phoneCode: otp, phoneCodeHash: sess.phone_code_hash });
          const client = activeAddClients.get(config.OWNER_ID)?.client;
          const sessionStr = client.session.save();
          const me2    = sigResult?.user?.id ? String(sigResult.user.id) : null;
          const masked = sess.number.slice(0,4)+'****'+sess.number.slice(-2);
          const n      = db.addNokos({ number: sess.number, number_masked: masked, v2l: sess.v2l, price: sess.price, session_string: sessionStr, tg_id: me2 });
          db.deleteAddSession(config.OWNER_ID);
          await bot.sendMessage(chatOwn, `✅ ${B('Nokos berhasil ditambahkan!')}\n📱 ${masked}\n💰 Rp${fmt(sess.price)}\nTotal stok: ${db.countNokos()}`);
          try { client.disconnect(); } catch {}
          activeAddClients.delete(config.OWNER_ID);

          const me4 = await bot.getMe().catch(()=>({username:''}));
          const notifNokos =
            `📱 <b>Stok Akun Telegram Tersedia!</b>\n\n`+
            `✅ Akun Telegram asli & aktif\n`+
            `⚡ OTP otomatis, proses instan\n`+
            `🔒 Aman & bergaransi\n\n`+
            `Beli sekarang sebelum kehabisan! 🔥`;
          const notifKbNokos = { inline_keyboard:[[{ text: B('📱 Order Nokos'), url:`https://t.me/${me4.username}?start=start` }]] };
          try {
            if (config.NOTIF_CHANNEL) await bot.sendMessage(config.NOTIF_CHANNEL, notifNokos, { parse_mode:'HTML', reply_markup: notifKbNokos });
          } catch {}
          (async () => {
            const allUsers = db.getAllUsers();
            let bc=0;
            for (const u of allUsers) {
              try { await bot.sendMessage(u.id, notifNokos, { parse_mode:'HTML', reply_markup: notifKbNokos }); bc++; } catch {}
              await new Promise(r=>setTimeout(r,35));
            }
            log.bcast(`Notif stok nokos baru: ${bc}/${allUsers.length} user`);
          })();
        } catch(err) {
          if (err.message.includes('SESSION_PASSWORD_NEEDED')||err.message.includes('2FA')) {
            db.updateAddSession(config.OWNER_ID, { step:'2fa' });
            await bot.sendMessage(chatOwn, `🔐 ${B('Akun ini punya 2FA.')} Kirim password 2FA:`);
          } else {
            db.deleteAddSession(config.OWNER_ID);
            activeAddClients.delete(config.OWNER_ID);
            await bot.sendMessage(chatOwn, `❌ OTP salah/kadaluarsa: ${err.message}\nSilakan /add ulang.`);
          }
        }
      } else if (sess.step === '2fa') {
        await bot.sendMessage(chatOwn, `⏳ ${B('Memverifikasi 2FA...')}`);
        try {
          const client = activeAddClients.get(config.OWNER_ID)?.client;
          if (!client) throw new Error('Client tidak ditemukan. Silakan /add ulang.');
          await gramSignInWithPassword(client, otp);
          const sessionStr = client.session.save();
          const masked = sess.number.slice(0,4)+'****'+sess.number.slice(-2);
          db.addNokos({ number: sess.number, number_masked: masked, v2l: sess.v2l, price: sess.price, session_string: sessionStr, tg_id: null });
          db.deleteAddSession(config.OWNER_ID);
          await bot.sendMessage(chatOwn, `✅ ${B('Nokos + 2FA berhasil ditambahkan!')}\n📱 ${masked}\nTotal stok: ${db.countNokos()}`);
          try { client.disconnect(); } catch {}
          activeAddClients.delete(config.OWNER_ID);
        } catch(err) {
          db.deleteAddSession(config.OWNER_ID);
          activeAddClients.delete(config.OWNER_ID);
          await bot.sendMessage(chatOwn, `❌ 2FA salah: ${err.message}\nSilakan /add ulang.`);
        }
      }
    }
  }
});

bot.on('callback_query', async (query) => {
  const msg    = query.message;
  const chatId = msg.chat.id;
  const userId = query.from.id;
  const from   = query.from;
  const data   = query.data;
  const cbId   = query.id;
  const msgId  = msg.message_id;
  db.upsertUser(from);

  
  if (db.getMaintenance() && !isOwner(userId)) {
    const userPanels = db.getUserPanels(userId);
    if (userPanels.length > 0) {
      
      const allowedPanel = [
        'DEPOSIT_MENU','MYPANEL:','CEK_BAYAR:','CANCEL_DEPOSIT:',
        'MANUAL_CHECK:','MANUAL_CANCEL:','MAIN_MENU','CHECK_JOIN',
        'PANEL_EXTEND:','PANEL_INFO:',
      ];
      const isAllowed = allowedPanel.some(a => data === a || data.startsWith(a));
      if (!isAllowed) {
        await answerCb(cbId, '🔧 Maintenance — hanya Deposit & Panel Saya tersedia.', true);
        return;
      }
    } else {
      
      await answerCb(cbId, '🔧 Bot sedang Maintenance. Mohon tunggu!', true);
      return;
    }
  }

  if (data === 'CAIRKAN_CANCEL') {
    cairkanPending.delete(userId);
    await bot.editMessageText('❌ <b>Pencairan dibatalkan.</b>', { chat_id: chatId, message_id: msgId, parse_mode: 'HTML' });
    return answerCb(cbId);
  }

  if (data === 'CAIRKAN_CONFIRM') {
    const pending = cairkanPending.get(userId);
    if (!pending) {
      await bot.editMessageText('❌ Sesi pencairan tidak ditemukan. Ulangi perintah /cairkan.', { chat_id: chatId, message_id: msgId, parse_mode: 'HTML' });
      return answerCb(cbId);
    }
    cairkanPending.delete(userId);
    await answerCb(cbId, '⏳ Memproses...');
    await bot.editMessageText('⏳ <b>Memproses pencairan...</b>', { chat_id: chatId, message_id: msgId, parse_mode: 'HTML' });
    try {
      const result = await pg.transferCreate({
        refId      : `CAIRKAN-${Date.now()}`,
        kodeBank   : pending.kodeBank,
        nomorAkun  : pending.nomorAkun,
        namaPemilik: pending.namaPemilik,
        nominal    : pending.nominal
      });
      const status = result?.data?.status || result?.status || 'submitted';
      await bot.editMessageText(
        `✅ <b>Pencairan Berhasil Diajukan!</b>\n\n` +
        `💰 Saldo   : <b>Rp${fmt(pending.saldoRaw)}</b>\n` +
        `━━━━━━━━━━━━━━━━━\n` +
        `🏦 EWallet : <b>${escH(pending.kodeBank.toUpperCase())}</b>\n` +
        `🔢 Nomor   : <b>${escH(pending.nomorAkun)}</b>\n` +
        `👤 Nama    : <b>${escH(pending.namaPemilik)}</b>\n` +
        `💸 Nominal : <b>Rp${fmt(pending.nominal)}</b>\n` +
        `📊 Status  : <b>${escH(String(status))}</b>`,
        { chat_id: chatId, message_id: msgId, parse_mode: 'HTML' });
    } catch (e) {
      await bot.editMessageText(
        `❌ <b>Pencairan Gagal!</b>\n<code>${escH(_errMsg(e))}</code>`,
        { chat_id: chatId, message_id: msgId, parse_mode: 'HTML' });
    }
    return;
  }

  
  if (data === 'AISCAN_CLOSE') {
    if (!isOwner(userId)) { await answerCb(cbId, '⛔ Hanya owner.', true); return; }
    await answerCb(cbId, '🗑️ Pesan dihapus.');
    await bot.deleteMessage(chatId, msgId).catch(() => {});
    return;
  }

  
  
  if (data === 'AISCAN_NOOP') {
    await answerCb(cbId);
    return;
  }

  if (data.startsWith('AISCAN_PAGE:')) {
    if (!isOwner(userId)) { await answerCb(cbId, '⛔ Hanya owner.', true); return; }
    await answerCb(cbId);
    const parts      = data.split(':');
    const sessionKey = parts[1];
    const pageIdx    = parseInt(parts[2]) || 0;
    const session    = aiCacheGet(sessionKey);
    if (!session || !session.threatList) {
      await bot.editMessageText('⚠️ <i>Sesi sudah kadaluarsa. Jalankan /scanall lagi.</i>',
        { chat_id: chatId, message_id: msgId, parse_mode: 'HTML' }).catch(() => {});
      return;
    }
    const { threatList } = session;
    const pageContent    = aiBuildPage(threatList, pageIdx, threatList.length, db);
    if (!pageContent) return;
    await bot.editMessageText(pageContent.text, {
      chat_id: chatId, message_id: msgId,
      parse_mode: 'HTML', reply_markup: pageContent.keyboard,
    }).catch(() => {});
    return;
  }

  
  if (data.startsWith('AISCAN_SUSPEND:')) {
    if (!isOwner(userId)) { await answerCb(cbId, '⛔ Hanya owner.', true); return; }

    
    const parts2      = data.split(':');
    const uuid        = parts2[1]; 
    const sessionKey  = parts2[2];
    const pageIdx     = parseInt(parts2[3]) || 0;
    const cacheKey    = `AISCAN_${uuid}`; 
    const cached      = aiCacheGet(cacheKey);
    const session     = sessionKey ? aiCacheGet(sessionKey) : null;

    await answerCb(cbId, '⏳ Memproses suspend...');

    
    const rebuildKeyboard = (actionBtn) => {
      const totalPages = session?.threatList?.length || 1;
      const navRow     = [];
      if (totalPages > 1) {
        if (pageIdx > 0)               navRow.push({ text: '◀️ Prev', callback_data: `AISCAN_PAGE:${sessionKey}:${pageIdx - 1}` });
        navRow.push({ text: `${pageIdx + 1}/${totalPages}`, callback_data: 'AISCAN_NOOP' });
        if (pageIdx < totalPages - 1)  navRow.push({ text: 'Next ▶️', callback_data: `AISCAN_PAGE:${sessionKey}:${pageIdx + 1}` });
      }
      const actionRow = [actionBtn, { text: '✖️ Tutup', callback_data: 'AISCAN_CLOSE' }];
      return { inline_keyboard: navRow.length ? [navRow, actionRow] : [actionRow] };
    };

    if (!cached) {
      await bot.editMessageReplyMarkup(
        rebuildKeyboard({ text: '⚠️ Cache kadaluarsa', callback_data: 'AISCAN_NOOP' }),
        { chat_id: chatId, message_id: msgId }
      ).catch(() => {});
      return;
    }

    const srv        = cached.srv;
    const internalId = cached.internalId;
    const fullUuid   = cached.uuid || uuid;   
    const serverName = cached.serverName || uuid;

    if (!srv || !internalId) {
      await bot.editMessageReplyMarkup(
        rebuildKeyboard({ text: '⚠️ Data tidak lengkap', callback_data: 'AISCAN_NOOP' }),
        { chat_id: chatId, message_id: msgId }
      ).catch(() => {});
      return;
    }

    
    await bot.editMessageReplyMarkup(
      rebuildKeyboard({ text: '⏳ Menyuspend...', callback_data: 'AISCAN_NOOP' }),
      { chat_id: chatId, message_id: msgId }
    ).catch(() => {});

    try {
      await ptero.suspendServer(srv, internalId);

      const panelRec  = db.getPanelByUuid(fullUuid);
      const allPanels = db.getAllPanelRecords();
      const pr        = allPanels.find(x => x.uuid === uuid);
      if (pr) {
        pr.suspended    = true;
        pr.suspended_at = Date.now();
        db._setPanels(allPanels);
      }
      if (panelRec) {
        db.setPanelExpiry(fullUuid, Date.now());
        if (_suspendTimers.has(fullUuid)) { clearTimeout(_suspendTimers.get(fullUuid)); _suspendTimers.delete(fullUuid); }
        const deleteAt = Date.now() + 3 * 24 * 60 * 60 * 1000;
        db.addPendingDeletion({
          uuid              : fullUuid,
          owner_id          : panelRec.owner_id,
          server_internal_id: internalId,
          ptero_user_id     : null,
          delete_at         : deleteAt,
          domain            : srv.domain,
          server_name       : serverName,
        });
      }

      
      const planLabel = panelRec ? (PANEL_PLANS.find(x => x.key === panelRec.plan_key)?.label || panelRec.plan_key) : '—';
      const types      = cached.types      || '—';
      const icon       = cached.icon       || '🔴';
      const suspFiles  = cached.suspFiles  || '';
      const summary    = cached.sr?.summary || '—';
      const userEmail  = cached.userEmail  || '—';
      const confidence = cached.sr?.confidence || '—';
      const totalPagesLabel = session?.threatList?.length || '?';

      
      const confMsg =
        `✅ <b>Server Disuspend via AI Scan</b> [${pageIdx + 1}/${totalPagesLabel}]\n\n` +
        `${icon} Confidence : <b>${escH(confidence)}</b>\n` +
        `⚔️ Tipe       : <b>${escH(types)}</b>\n` +
        `📡 Panel      : <code>${escH(srv.domain)}</code>\n` +
        `🆔 UUID       : <code>${escH(fullUuid)}</code>\n` +
        `🖥️ Server     : ${escH(serverName)}\n` +
        `👤 User       : ${escH(userEmail)}\n` +
        `📦 Plan       : ${escH(planLabel)}\n\n` +
        (suspFiles ? `📄 <b>File mencurigakan:</b>\n${suspFiles}\n\n` : '') +
        `🔍 <b>Analisis:</b>\n${escH(summary)}\n\n` +
        `⚠️ <i>Panel akan dihapus otomatis dalam 3 hari jika tidak diperpanjang.</i>`;

      
      
      await bot.editMessageText(confMsg, {
        chat_id: chatId, message_id: msgId, parse_mode: 'HTML',
        reply_markup: rebuildKeyboard({ text: '✅ Sudah Disuspend', callback_data: 'AISCAN_NOOP' }),
      });

      
      if (panelRec) {
        try {
          const fileSummaryForOwner = (cached.sr?.suspicious_files || []).slice(0, 3)
            .map(f => {
              const riskEmoji = { HIGH: '🔴', MEDIUM: '🟠', LOW: '🟡' }[f.risk] || '🔴';
              return `${riskEmoji} <code>${escH(f.path)}</code>\n   └ ${escH(f.reason)}`;
            })
            .join('\n');
          const deleteDate = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000)
            .toLocaleString('id-ID', { timeZone: 'Asia/Jakarta', day: '2-digit', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit' });
          await bot.sendMessage(panelRec.owner_id,
            `🔴 <b>PANEL KAMU DISUSPEND</b>\n\n` +
            `📛 Server  : <b>${escH(serverName)}</b>\n` +
            `📋 Alasan  : <b>Terdeteksi script berbahaya</b>\n` +
            `⚔️ Tipe    : <b>${escH(types)}</b>\n\n` +
            (fileSummaryForOwner ? `📄 <b>File yang bermasalah:</b>\n${fileSummaryForOwner}\n\n` : '') +
            `🔍 <b>Keterangan:</b>\n${escH(summary)}\n\n` +
            `━━━━━━━━━━━━━━━━━\n` +
            `⚠️ <b>Tindakan selanjutnya:</b>\n` +
            `• Hapus semua script berbahaya dari server\n` +
            `• Hubungi owner untuk reaktivasi panel\n` +
            `• Jika tidak ada tindak lanjut, panel akan <b>dihapus permanen</b> pada:\n` +
            `  📅 <b>${deleteDate} WIB</b>`,
            { parse_mode: 'HTML' }
          );
        } catch {}
      }

      
      const uuidSensor    = fullUuid.length > 8 ? fullUuid.slice(0, 4) + '****' + fullUuid.slice(-4) : '****';
      const domainSensor  = aiSensorDomain(srv.domain);
      const ownerSensor   = panelRec?.owner_username
        ? `@${aiSensorStr(panelRec.owner_username, 2)}`
        : (panelRec?.owner_id ? `ID:${aiSensorStr(String(panelRec.owner_id), 2)}` : '—');
      const suspFilesSensor = (cached.sr?.suspicious_files || []).slice(0, 5)
        .map(f => {
          const fparts       = (f.path || '').split('/');
          const fileName     = fparts.pop() || '';
          const ext          = fileName.includes('.') ? fileName.slice(fileName.lastIndexOf('.')) : '';
          const sensoredFile = aiSensorStr(fileName.replace(ext, ''), 2) + ext;
          const sensoredPath = (fparts.length ? '***/' : '') + sensoredFile;
          return `  ├ <code>${escH(sensoredPath)}</code> [${f.risk}]\n     📌 ${escH(f.reason)}`;
        })
        .join('\n');
      const channelText =
        `🔴 <b>Server Disuspend — Ancaman AI Scan</b>\n\n` +
        `${icon} Confidence : <b>${escH(confidence)}</b>\n` +
        `⚔️ Tipe       : <b>${escH(types)}</b>\n` +
        `📡 Panel      : <code>${escH(domainSensor)}</code>\n` +
        `🆔 UUID       : <code>${escH(uuidSensor)}</code>\n` +
        `🖥️ Server     : ${escH(aiSensorStr(serverName, 3))}\n` +
        `👤 Pemilik    : ${escH(ownerSensor)}\n` +
        `📦 Plan       : ${escH(planLabel)}\n\n` +
        (suspFilesSensor ? `📄 <b>File mencurigakan:</b>\n${suspFilesSensor}\n\n` : '') +
        `🔍 <b>Analisis AI:</b>\n${escH(summary)}\n\n` +
        `<i>⚠️ Server disuspend otomatis oleh sistem AI Scan.\nAkan dihapus permanen dalam 3 hari jika tidak ada tindak lanjut.</i>`;
      await bot.sendMessage(config.NOTIF_CHANNEL, channelText, { parse_mode: 'HTML' }).catch(() => {});

      aiCacheDelete(cacheKey);

    } catch (e) {
      
      await bot.editMessageReplyMarkup(
        rebuildKeyboard({ text: '🔴 Suspend (Retry)', callback_data: `AISCAN_SUSPEND:${uuid}:${sessionKey}:${pageIdx}` }),
        { chat_id: chatId, message_id: msgId }
      ).catch(() => {});
      await answerCb(cbId, `❌ Gagal: ${e.message}`, true);
    }
    return;
  }

  if (data === 'CHECK_JOIN') {
    const { ok } = await checkJoins(userId);
    if (ok) {
      await answerCb(cbId);
      await tryDel(chatId, msgId);
      await sendMainMenu(chatId, from);
    } else {
      await answerCb(cbId, '😂 Lu belum masuk kocak! Join dulu semua channel/group di atas!', true);
    }
    return;
  }

  if (csai.isInCsAi(userId) && data !== 'CSAI_STOP') {
    await answerCb(cbId, '⚠️ Kamu sedang dalam CS AI! Ketik /stopai dulu.', true);
    await bot.sendMessage(chatId,
      `🤖 Kamu sedang dalam mode <b>CS AI (Beta)</b>!\n\n` +
      `Tidak bisa menggunakan command atau tombol apapun saat CS AI aktif.\n` +
      `Ketik <code>/stopai</code> dahulu untuk keluar dari mode CS AI.`,
      { parse_mode: 'HTML', reply_markup:{ inline_keyboard:[[{ text: B('❌ Keluar CS AI'), callback_data:'CSAI_STOP' }]] } }
    ).catch(()=>{});
    return;
  }

  if (!['MAIN_MENU','PANDUAN'].includes(data) && !data.startsWith('CHECK_JOIN')) {
    if (!await enforceJoin(chatId, userId)) { await answerCb(cbId); return; }
  }

  const NAV_ACTIONS = ['MAIN_MENU','LAYANAN_MENU','PANDUAN','DEPOSIT_MENU','MENU_NOKOS','MENU_PANEL','MENU_ADMIN','MENU_RESELLER','MENU_RESSVPS','MENU_PTVPS','ORDER_SCRIPT'];
  if (NAV_ACTIONS.includes(data)) userStates.delete(userId);

  if (data === 'CSAI_START') {
    await answerCb(cbId);
    userStates.delete(userId);
    if (msgId) await tryDel(chatId, msgId);
    return csai.sendCsAiWelcome(bot, chatId, from);
  }
  if (data === 'CSAI_STOP') {
    await answerCb(cbId, '✅ CS AI dihentikan');
    csai.exitCsAi(userId);
    if (msgId) await tryDel(chatId, msgId);
    return sendMainMenu(chatId, from);
  }

  
  if (data === 'OWNER_SETHARGA_MENU') {
    if (!isOwner(userId)) { await answerCb(cbId,'⛔',true); return; }
    await answerCb(cbId);
    await tryDel(chatId, msgId);
    return sendOwnerSetHargaMenu(chatId, null);
  }
  if (data.startsWith('SETHARGA_PLAN:')) {
    if (!isOwner(userId)) { await answerCb(cbId,'⛔',true); return; }
    const planKey = data.split(':')[1];
    await answerCb(cbId);
    await tryDel(chatId, msgId);
    return sendOwnerSetHargaPlanDur(chatId, planKey, null);
  }
  if (data.startsWith('SETHARGA_DEL:')) {
    if (!isOwner(userId)) { await answerCb(cbId,'⛔',true); return; }
    const parts = data.split(':'); const planKey = parts[1], durKey = parts[2];
    db.setSetting(`harga_dur_deleted_${planKey}_${durKey}`, true);
    await answerCb(cbId, `✅ Durasi ${durKey} dihapus dari plan ${planKey}`, true);
    await tryDel(chatId, msgId);
    return sendOwnerSetHargaPlanDur(chatId, planKey, null);
  }
  if (data.startsWith('SETHARGA_RESTORE:')) {
    if (!isOwner(userId)) { await answerCb(cbId,'⛔',true); return; }
    const parts = data.split(':'); const planKey = parts[1], durKey = parts[2];
    db.setSetting(`harga_dur_deleted_${planKey}_${durKey}`, false);
    await answerCb(cbId, `✅ Durasi ${durKey} diaktifkan kembali`, true);
    await tryDel(chatId, msgId);
    return sendOwnerSetHargaPlanDur(chatId, planKey, null);
  }
  if (data.startsWith('SETHARGA_INPUT:')) {
    if (!isOwner(userId)) { await answerCb(cbId,'⛔',true); return; }
    const parts = data.split(':'); const planKey = parts[1], durKey = parts[2];
    const plan  = PANEL_PLANS.find(p=>p.key===planKey);
    const dur   = PANEL_DURATIONS.find(d=>d.key===durKey);
    const curHarga = db.getSetting(`harga_${planKey}_${durKey}`);
    await answerCb(cbId);
    await tryDel(chatId, msgId);
    const pm = await bot.sendMessage(chatId,
      `🔧 <b>Set Harga ${plan?.label||planKey} — ${dur?.label||durKey}</b>\n\n` +
      (curHarga ? `💰 Harga saat ini: <b>Rp${fmt(curHarga)}</b>\n\n` : '') +
      `Ketik harga baru (angka saja):`,
      { parse_mode:'HTML', reply_markup:{ inline_keyboard:[[{ text:B('❌ Batal'), callback_data:`SETHARGA_PLAN:${planKey}` }]] } }
    );
    userStates.set(userId, { state:'WAITING_SETHARGA', planKey, durKey, promptMsgId: pm.message_id });
    return;
  }

  if (data === 'SETHARGA_RESELLER') {
    if (!isOwner(userId)) { await answerCb(cbId,'⛔',true); return; }
    const cur = db.getSetting('harga_reseller') || config.HARGA.reseller;
    await answerCb(cbId);
    await tryDel(chatId, msgId);
    const pm = await bot.sendMessage(chatId,
      `👑 <b>Set Harga Reseller Panel</b>\n\n💰 Harga saat ini: <b>Rp${fmt(cur)}</b>\n\nKetik harga baru (angka saja):`,
      { parse_mode:'HTML', reply_markup:{ inline_keyboard:[[{ text:B('❌ Batal'), callback_data:'OWNER_SETHARGA_MENU' }]] } }
    );
    userStates.set(userId, { state:'WAITING_SETHARGA_SINGLE', settingKey:'harga_reseller', label:'Reseller Panel', promptMsgId: pm.message_id });
    return;
  }

  if (data === 'SETHARGA_ADMIN') {
    if (!isOwner(userId)) { await answerCb(cbId,'⛔',true); return; }
    const cur = db.getSetting('harga_admin') || config.HARGA.admin;
    await answerCb(cbId);
    await tryDel(chatId, msgId);
    const pm = await bot.sendMessage(chatId,
      `🛠️ <b>Set Harga Admin Panel</b>\n\n💰 Harga saat ini: <b>Rp${fmt(cur)}</b>\n\nKetik harga baru (angka saja):`,
      { parse_mode:'HTML', reply_markup:{ inline_keyboard:[[{ text:B('❌ Batal'), callback_data:'OWNER_SETHARGA_MENU' }]] } }
    );
    userStates.set(userId, { state:'WAITING_SETHARGA_SINGLE', settingKey:'harga_admin', label:'Admin Panel', promptMsgId: pm.message_id });
    return;
  }

  if (data === 'MAIN_MENU')     { await answerCb(cbId); return sendMainMenu(chatId, from, msgId); }
  if (data === 'LAYANAN_MENU')  { await answerCb(cbId); return sendLayananMenu(chatId, from, msgId); }
  if (data === 'PANDUAN')       { await answerCb(cbId); return sendPanduan(chatId, msgId); }
  if (data === 'DEPOSIT_MENU')  { await answerCb(cbId); return sendDepositMenu(chatId, userId, msgId); }
  if (data === 'MENU_NOKOS')    { await answerCb(cbId); return sendNokosMenu(chatId, from, msgId); }
  if (data === 'MENU_PANEL')    { await answerCb(cbId); return sendPanelMenu(chatId, userId, msgId); }
  if (data === 'MENU_ADMIN')    { await answerCb(cbId); return sendAdminMenu(chatId, userId, msgId); }
  if (data === 'MENU_RESELLER') { await answerCb(cbId); return sendResellerMenu(chatId, userId, msgId); }
  if (data === 'MENU_RESSVPS') { await answerCb(cbId); return sendVpsMenu(chatId, userId, msgId); }
  if (data === 'MENU_PTVPS') { await answerCb(cbId); return sendPtMenu(chatId, userId, msgId); }
  if (data === 'ORDER_SCRIPT')  { await answerCb(cbId); return sendScriptMenu(chatId, userId, msgId); }

  if (data.startsWith('NOKOS_GROUP:')) {
    const prefix = data.split(':')[1];
    await answerCb(cbId);
    return sendNokosGroupPage(chatId, from, prefix, 0, msgId);
  }
  if (data.startsWith('NOKOS_GPAGE:')) {
    const [,prefix,pageStr] = data.split(':');
    await answerCb(cbId);
    return sendNokosGroupPage(chatId, from, prefix, parseInt(pageStr), msgId);
  }
  if (data.startsWith('NOKOS_BUY:')) {
    const id = parseInt(data.split(':')[1]);
    return handleNokosBuy(chatId, userId, from, id, cbId, msgId);
  }
  if (data.startsWith('NOKOS_CONFIRM:')) {
    const id = parseInt(data.split(':')[1]);
    return handleNokosConfirm(chatId, userId, from, id, cbId);
  }
  if (data.startsWith('NOKOS_LOGOUT:')) {
    const id = parseInt(data.split(':')[1]);
    await answerCb(cbId);
    if (activeNokosClients.has(userId)) {
      try { await activeNokosClients.get(userId).client.disconnect(); } catch {}
      activeNokosClients.delete(userId);
    }
    return bot.sendMessage(chatId, `✅ ${B('Bot berhasil di-logout.')}`);
  }

  
  if (data.startsWith('PANEL_ACCOUNT:')) {
    const choice = data.split(':')[1];
    await answerCb(cbId);
    if (choice === 'new') {
      const inputText =
        `📡 <b>${B('ORDER PANEL')}</b>\n\n` +
        `Masukkan ${B('username')} panel yang kamu inginkan:\n` +
        `<i>(Hanya huruf kecil, angka, dan underscore)</i>`;
      const inputKb = { inline_keyboard:[[{ text: B('❌ Batal'), callback_data:'LAYANAN_MENU' }]] };
      userStates.delete(userId);
      if (msgId) await tryDel(chatId, msgId);
      const pm = await bot.sendMessage(chatId, inputText, { parse_mode:'HTML', reply_markup:inputKb });
      userStates.set(userId, { state:'WAITING_PANEL_USERNAME', promptMsgId: pm.message_id });
    }
    return;
  }

  
  if (data.startsWith('PANEL_PICK_ACC:')) {
    
    const idx    = parseInt(data.split(':')[1]) || 0;
    const st     = userStates.get(userId) || {};
    const picked = (st.accountList || [])[idx];
    await answerCb(cbId);

    
    let pteroUsername, panelDomain, pteroEmail;
    if (picked) {
      pteroUsername = picked.ptero_username;
      panelDomain   = picked.domain;
      pteroEmail    = picked.ptero_email || `${picked.ptero_username}@hekaly.com`;
    } else {
      
      const panels = db.getUserPanels(userId).filter(p => p.ptero_username);
      const seen   = new Set();
      const unique = panels.filter(p => { if (seen.has(p.ptero_username)) return false; seen.add(p.ptero_username); return true; });
      const p      = unique[idx] || unique[0];
      if (!p) { await bot.sendMessage(chatId, '❌ Sesi expired. Silakan tekan tombol Panel lagi.', { parse_mode:'HTML' }); return; }
      pteroUsername = p.ptero_username;
      panelDomain   = p.domain;
      pteroEmail    = p.ptero_email || `${p.ptero_username}@hekaly.com`;
    }

    
    const promptText =
      `📡 <b>${B('NAMA PANEL')}</b>\n\n` +
      `👤 ${B('Akun')}: <code>${pteroUsername}</code>\n` +
      `📧 ${B('Email')}: <code>${pteroEmail}</code>\n\n` +
      `Masukkan ${B('nama server')} yang kamu inginkan:\n` +
      `<i>(Hanya huruf kecil, angka, dan underscore)</i>`;
    const promptKb = { inline_keyboard:[
      [{ text: B('⬅️ Kembali'), callback_data:'MENU_PANEL' }],
      [{ text: B('❌ Batal'), callback_data:'LAYANAN_MENU' }]
    ]};
    const promptMsg = await editOrReplace(chatId, msgId, promptText, { parse_mode:'HTML', reply_markup:promptKb });
    userStates.set(userId, { state:'WAITING_EX_SERVER_NAME', pteroUsername, panelDomain, pteroEmail, promptMsgId: promptMsg?.message_id || msgId });
  }

  
  if (data.startsWith('PANEL_EX_TYPE:')) {
    const langKey = data.split(':')[1]; 
    const lang    = langKey === 'py' ? 'python' : 'javascript';
    await answerCb(cbId);
    
    const st = userStates.get(userId) || {};
    const { pteroUsername, panelDomain, pteroEmail, exServerName } = st;
    if (!pteroUsername || !panelDomain) {
      await bot.sendMessage(chatId, '❌ Sesi expired. Silakan tekan tombol Panel lagi.'); return;
    }
    userStates.set(userId, { ...st, panelLang: lang });
    
    const exData      = { isExisting: true, pteroUsername, panelDomain, exServerName: exServerName||pteroUsername, pteroEmail: pteroEmail||`${pteroUsername}@hekaly.com` };
    const sessionToken = panelStoreSet(userId, exData);
    const usernameKey  = `__EX_TOKEN__${sessionToken}`;
    return showPanelPlanMenu(chatId, userId, usernameKey, lang, msgId);
  }

  
  

  if (data.startsWith('PANEL_TYPE:')) {
    const parts = data.split(':'); const username = parts[1], lang = parts[2];
    await answerCb(cbId);

    const prevState = userStates.get(userId) || {};
    userStates.set(userId, { ...prevState, panelLang: lang });
    return showPanelPlanMenu(chatId, userId, username, lang, msgId);
  }
  if (data.startsWith('PANEL_RETYPE:')) {
    const username = data.split(':')[1];
    await answerCb(cbId);
    const typeText = `📡 <b>${B('PILIH TIPE PANEL')}</b>\n\n👤 ${B('Username')}: <code>${username}</code>\n\nPilih bahasa/runtime panel kamu:`;
    const typeKb = { inline_keyboard: [
      [
        { text: '🟨 JavaScript (Node.js)', callback_data:`PANEL_TYPE:${username}:javascript` },
        { text: '🐍 Python',               callback_data:`PANEL_TYPE:${username}:python` }
      ],
      [{ text: B('❌ Batal'), callback_data:'LAYANAN_MENU' }]
    ]};
    return editOrReplace(chatId, msgId, typeText, { parse_mode:'HTML', reply_markup:typeKb });
  }
  if (data.startsWith('PANEL_PLAN:')) {
    const parts = data.split(':'); const username = parts[1], planKey = parts[2];
    return handlePanelOrder(chatId, userId, from, username, planKey, cbId, msgId);
  }
  if (data.startsWith('PANEL_DUR:')) {
    const parts = data.split(':'); const username = parts[1], planKey = parts[2], durKey = parts[3];
    return handlePanelDurOrder(chatId, userId, from, username, planKey, durKey, cbId, msgId);
  }
  if (data.startsWith('PANEL_EXEC:')) {
    const parts = data.split(':'); const username = parts[1], planKey = parts[2], durKey = parts[3];
    return execPanelOrder(chatId, userId, from, username, planKey, durKey, cbId, msgId);
  }
  if (data.startsWith('PANEL_REPLAN:')) {
    const username = data.split(':')[1];
    await answerCb(cbId);
    const lang = userStates.get(userId)?.panelLang || 'javascript';
    return showPanelPlanMenu(chatId, userId, username, lang, msgId);
  }

  
  if (data.startsWith('MYPANEL:')) {
    const page = parseInt(data.split(':')[1]) || 0;
    await answerCb(cbId);
    return sendMyPanel(chatId, userId, page, msgId);
  }
  if (data.startsWith('PANEL_INFO:')) {
    const parts = data.split(':'); const uuid = parts[1], backPage = parseInt(parts[2])||0;
    await answerCb(cbId);
    return sendPanelInfo(chatId, userId, uuid, backPage, msgId);
  }
  if (data.startsWith('PANEL_PWR:')) {
    const parts  = data.split(':');
    const uuid   = parts[1], action = parts[2], backPage = parseInt(parts[3])||0;
    await answerCb(cbId, `⏳ ${action}...`);
    const rec    = db.getPanelByUuid(uuid);
    if (!rec || String(rec.owner_id) !== String(userId)) return;
    const servers = db.getAllServers();
    const srv    = servers.find(s => s.domain === rec.domain);
    if (!srv) { await bot.answerCallbackQuery(cbId,{text:'❌ Server tidak ditemukan.',show_alert:true}); return; }
    try {
      await ptero.sendPowerAction(srv, uuid, action);
      await new Promise(r=>setTimeout(r,1500));
    } catch(e) {
      await bot.answerCallbackQuery(cbId,{text:`❌ Gagal: ${e.message.slice(0,60)}`,show_alert:true});
    }
    return sendPanelInfo(chatId, userId, uuid, backPage, msgId);
  }
  if (data.startsWith('PANEL_EXTEND:')) {
    const parts = data.split(':'); const uuid = parts[1], backPage = parseInt(parts[2])||0;
    await answerCb(cbId);
    return sendPanelExtend(chatId, userId, uuid, backPage, msgId);
  }
  if (data.startsWith('PANEL_EXT_CONF:')) {
    const parts = data.split(':'); const uuid = parts[1], durKey = parts[2], backPage = parseInt(parts[3])||0;
    return handlePanelExtendConfirm(chatId, userId, uuid, durKey, backPage, cbId, msgId);
  }
  if (data.startsWith('PANEL_EXT_EXEC:')) {
    const parts = data.split(':'); const uuid = parts[1], durKey = parts[2], backPage = parseInt(parts[3])||0;
    return execPanelExtend(chatId, userId, uuid, durKey, backPage, cbId, msgId);
  }

  
  if (data.startsWith('OWNERINFO_PAGE:')) {
    if (!isOwner(userId)) { await answerCb(cbId,'⛔',true); return; }
    await answerCb(cbId);
    const parts  = data.split(':'); const ownerId = parts[1], page = parseInt(parts[2])||0;
    const cached = ownerInfoCache.get(`${chatId}_${ownerId}`);
    if (!cached) return;
    const PER_PAGE = 5; const now = Date.now();
    const slice  = cached.slice(page*PER_PAGE, page*PER_PAGE+PER_PAGE);
    const maxPage = Math.ceil(cached.length/PER_PAGE)-1;
    const lines  = [`📋 <b>Panel (hal ${page+1}/${maxPage+1})</b>\n`];
    for (let i=0;i<slice.length;i++) {
      const p = slice[i]; const rem = p.expiry_ms-now;
      lines.push(`${page*PER_PAGE+i+1}. <b>${escH(p.name)}</b>\n   UUID: <code>${p.uuid}</code>\n   Masa Aktif: <b>${rem>0?fmtDurasi(rem):'⛔ Habis'}</b>`);
    }
    const nav = [];
    if (page>0)       nav.push({text:'◀️ Prev',callback_data:`OWNERINFO_PAGE:${ownerId}:${page-1}`});
    if (page<maxPage) nav.push({text:'Next ▶️',callback_data:`OWNERINFO_PAGE:${ownerId}:${page+1}`});
    const kb = nav.length ? {inline_keyboard:[nav]} : undefined;
    return bot.sendMessage(chatId, lines.join('\n'), {parse_mode:'HTML', reply_markup:kb});
  }

  
  if (data.startsWith('OWNER_EXT:')) {
    if (!isOwner(userId)) { await answerCb(cbId,'⛔',true); return; }
    const parts = data.split(':'); const uuid = parts[1], durKey = parts[2];
    const dur   = PANEL_DURATIONS.find(d=>d.key===durKey);
    if (!dur) { await answerCb(cbId,'❌',true); return; }
    const newExp = db.adjustPanelExpiry(uuid, dur.ms);
    if (!newExp) { await answerCb(cbId,'❌ UUID tidak ditemukan.',true); return; }
    await answerCb(cbId, `✅ Diperpanjang ${dur.label}`, true);
    const rec    = db.getPanelByUuid(uuid);
    const expStr = new Date(newExp).toLocaleString('id-ID',{timeZone:'Asia/Jakarta'});
    if (msgId) { try { await bot.editMessageText(
      `✅ <b>Perpanjang Berhasil (Owner)</b>\n\n📛 <b>${escH(rec?.name||uuid)}</b>\n➕ Ditambah: <b>${dur.label}</b>\n📅 Sampai: <b>${expStr} WIB</b>\n🕐 Sisa: <b>${fmtDurasi(newExp-Date.now())}</b>`,
      {chat_id:chatId,message_id:msgId,parse_mode:'HTML'}); } catch {} }
    return;
  }
  if (data === 'OWNER_EXT_CLOSE') {
    await answerCb(cbId);
    if (msgId) await tryDel(chatId, msgId);
    return;
  }

  
  if (data.startsWith('LISTSRV_PAGE:')) {
    if (!isOwner(userId)) { await answerCb(cbId,'⛔',true); return; }
    await answerCb(cbId);
    const page = parseInt(data.split(':')[1]) || 0;
    if (page === 0) {
      
      const servers = db.getAllServers();
      const domainMap = {};
      for (const s of servers) { if (!domainMap[s.domain]) domainMap[s.domain] = s; }
      const panels = Object.values(domainMap);
      const allItems = [];
      for (const srv of panels) {
        try {
          let pg2 = 1;
          while(true) {
            const resp = await ptero.listAllServers(srv, pg2);
            for (const item of (resp.data||[])) allItems.push({...(item.attributes||item),_domain:srv.domain});
            if (!resp.meta?.pagination || resp.meta.pagination.current_page >= resp.meta.pagination.total_pages) break;
            pg2++;
          }
        } catch {}
      }
      listsrvState.set(chatId, { items: allItems, page: 0 });
    }
    return sendListsrvPage(chatId, msgId, page);
  }

  if (data.startsWith('ADP_CONFIRM:')) {
    const username = data.split(':')[1];
    return processAdminOrder(chatId, userId, from, username, cbId, msgId);
  }

  if (data.startsWith('RESELLER_CONFIRM:')) {
    const tgId = data.split(':')[1];
    return processResellerOrder(chatId, userId, from, tgId, cbId);
  }
  if (data.startsWith('RESELLERVPS_CONFIRM:')) {
    const tgId = data.split(':')[1];
    return processResellerVpsOrder(chatId, userId, from, tgId, cbId);
  }
  if (data.startsWith('PTVPS_CONFIRM:')) {
    const tgId = data.split(':')[1];
    return processPtVpsOrder(chatId, userId, from, tgId, cbId);
  }
  

  if (data.startsWith('PRODUK_BUY:')) {
    const id = parseInt(data.split(':')[1]);
    return handleProdukBuy(chatId, userId, from, id, cbId, msgId);
  }
  if (data.startsWith('PRODUK_CONFIRM:')) {
    const id = parseInt(data.split(':')[1]);
    return processProdukOrder(chatId, userId, from, id, cbId);
  }

  if (data === 'SCRIPT_CONFIRM') { await answerCb(cbId); return sendScriptMenu(chatId, userId, msgId); }

  if (data.startsWith('CEK_BAYAR:')) {
    const orderId = data.slice('CEK_BAYAR:'.length);
    return cekPembayaran(chatId, userId, from, orderId, cbId);
  }
  if (data.startsWith('CANCEL_DEPOSIT:')) {
    const orderId = data.slice('CANCEL_DEPOSIT:'.length);
    const sess    = activeSessions.get(userId);
    if (!sess||sess.orderId!==orderId) { await answerCb(cbId,'❌ Sesi tidak ditemukan.',true); return; }
    const savedAmount = sess.amount;
    await cancelSession(userId);
    await answerCb(cbId);
    const cancelText =
      `✅ <b>${B('Deposit Dibatalkan')}</b>\n\n`+
      `🆔 Order: <code>${orderId}</code>\n`+
      `💰 Nominal: <b>Rp${fmt(savedAmount)}</b>\n\n`+
      `Kamu bisa deposit ulang sekarang.`;
    const cancelKb = { inline_keyboard: [
      [{ text: B('💰 Deposit Ulang'), callback_data:'DEPOSIT_MENU' }],
      [{ text: B('🏠 Menu Utama'),    callback_data:'MAIN_MENU' }]
    ]};
    return editOrReplace(chatId, msgId, cancelText, { parse_mode:'HTML', reply_markup:cancelKb });
  }

  
  if (data.startsWith('MANUAL_CHECK:')) {
    const orderId = data.slice('MANUAL_CHECK:'.length);
    const sess    = activeSessions.get(userId);
    if (!sess || sess.orderId !== orderId) { await answerCb(cbId,'❌ Sesi tidak ditemukan.',true); return; }
    await answerCb(cbId);
    
    userStates.set(userId, { state:'WAITING_MANUAL_PROOF', orderId, chatId, qrisMsgId: msgId });
    const kb = { inline_keyboard:[[{ text:B('❌ Batalkan'), callback_data:`MANUAL_CANCEL:${orderId}` }]] };
    const proofText =
      `📸 <b>${B('KIRIM BUKTI PEMBAYARAN')}</b>\n\n` +
      `🆔 Order: <code>${orderId}</code>\n\n` +
      `Kirim screenshot/foto bukti transfer DAN HARUS SS DETAIL, SEKALI LAGI SS DETAIL kamu sekarang untuk dikonfirmasi owner.`;
    
    try {
      await bot.editMessageCaption(proofText, { chat_id:chatId, message_id:msgId, parse_mode:'HTML', reply_markup:kb });
    } catch {
      try {
        await bot.editMessageText(proofText, { chat_id:chatId, message_id:msgId, parse_mode:'HTML', reply_markup:kb });
      } catch {
        
        const m = await bot.sendMessage(chatId, proofText, { parse_mode:'HTML', reply_markup:kb });
        userStates.set(userId, { state:'WAITING_MANUAL_PROOF', orderId, chatId, qrisMsgId: m.message_id });
      }
    }
    return;
  }

  
  if (data.startsWith('MANUAL_CANCEL:')) {
    const orderId = data.slice('MANUAL_CANCEL:'.length);
    const sess    = activeSessions.get(userId);
    if (!sess || sess.orderId !== orderId) { await answerCb(cbId,'❌ Sesi tidak ditemukan.',true); return; }
    const savedAmount = sess.amount;
    activeSessions.delete(userId);
    userStates.delete(userId);
    db.updateTx(orderId, { status:'cancelled' });
    await answerCb(cbId);
    const cancelText =
      `✅ <b>${B('Transaksi Dibatalkan')}</b>\n\n`+
      `🆔 Order: <code>${orderId}</code>\n`+
      `💰 Nominal: <b>Rp${fmt(savedAmount)}</b>\n\n`+
      `Kamu bisa deposit ulang sekarang.`;
    const cancelKb = { inline_keyboard:[
      [{ text:B('💰 Deposit Ulang'), callback_data:'DEPOSIT_MENU' }],
      [{ text:B('🏠 Menu Utama'),    callback_data:'MAIN_MENU' }]
    ]};
    return editOrReplace(chatId, msgId, cancelText, { parse_mode:'HTML', reply_markup:cancelKb });
  }

  
  if (data.startsWith('MANUAL_VALID:')) {
    if (!isOwner(userId)) { await answerCb(cbId,'⛔ Owner only!',true); return; }
    const parts   = data.split(':');
    const orderId = parts[1];
    const buyerId = parts[2];
    const tx      = db.getTx(orderId);
    if (!tx || tx.status !== 'pending_manual') { await answerCb(cbId,'❌ Transaksi tidak ditemukan / sudah diproses.',true); return; }
    await answerCb(cbId, '✅ Memproses...', false);
    const creditAmount = tx.amount;
    db.addBalance(buyerId, creditAmount);
    db.updateTx(orderId, { status:'completed' });
    const newBal = db.getBalance(buyerId);
    
    try {
      await bot.editMessageCaption(
        `✅ <b>PEMBAYARAN VALID — SUDAH DIKREDITKAN</b>\n\n`+
        `🆔 Order: <code>${orderId}</code>\n`+
        `💰 Dikreditkan: <b>Rp${fmt(creditAmount)}</b>\n`+
        `👤 User ID: <code>${buyerId}</code>`,
        { chat_id: chatId, message_id: msgId, parse_mode:'HTML' }
      );
    } catch { try { await bot.editMessageText(`✅ <b>SUDAH VALID & DIKREDITKAN</b>`, { chat_id:chatId, message_id:msgId, parse_mode:'HTML' }); } catch {} }
    
    try {
      await bot.sendMessage(buyerId,
        `✅ <b>${B('PEMBAYARAN DITERIMA')}</b>\n\n`+
        `💰 ${B('Nominal')}: <b>Rp${fmt(creditAmount)}</b>\n`+
        `💳 ${B('Saldo Baru')}: <b>Rp${fmt(newBal)}</b>\n\n`+
        `Terima kasih! Saldo kamu sudah ditambahkan.`,
        { parse_mode:'HTML', reply_markup:{ inline_keyboard:[
          [{ text:B('🛒 Beli Layanan'), callback_data:'LAYANAN_MENU' }],
          [{ text:B('🏠 Menu Utama'),   callback_data:'MAIN_MENU' }]
        ]}}
      );
    } catch {}
    
    activeSessions.delete(parseInt(buyerId));
    userStates.delete(parseInt(buyerId));

    const buyerUser = db.getUser(buyerId);
    const uname     = buyerUser?.username ? `@${buyerUser.username}` : `ID:${buyerId}`;
    const imgP      = receipt.receiptDeposit({ orderId, nominal: creditAmount, metode:'Manual QRIS', pembeli: uname, botUsername: config.BOT_USERNAME });
    const notifText = receipt.buildChannelNotif({ type:'deposit', orderId, harga:creditAmount, metode:'Manual QRIS', pembeli:uname, botUsername:config.BOT_USERNAME });
    sendChannelReceipt(imgP, notifText);
    return;
  }

  
  if (data.startsWith('MANUAL_INVALID:')) {
    if (!isOwner(userId)) { await answerCb(cbId,'⛔ Owner only!',true); return; }
    const parts   = data.split(':');
    const orderId = parts[1];
    const buyerId = parts[2];
    const tx      = db.getTx(orderId);
    if (!tx || tx.status !== 'pending_manual') { await answerCb(cbId,'❌ Transaksi tidak ditemukan / sudah diproses.',true); return; }
    await answerCb(cbId, '❌ Ditolak', false);
    db.updateTx(orderId, { status:'rejected' });
    activeSessions.delete(parseInt(buyerId));
    
    try {
      await bot.editMessageCaption(
        `❌ <b>BUKTI DITOLAK</b>\n\n🆔 Order: <code>${orderId}</code>`,
        { chat_id: chatId, message_id: msgId, parse_mode:'HTML' }
      );
    } catch { try { await bot.editMessageText(`❌ <b>BUKTI DITOLAK</b>`, { chat_id:chatId, message_id:msgId, parse_mode:'HTML' }); } catch {} }
    
    try {
      await bot.sendMessage(buyerId,
        `❌ <b>Mohon Maaf, Bukti Pembayaran Tidak Diterima</b>\n\n`+
        `🆔 Order: <code>${orderId}</code>\n\n`+
        `Silakan coba deposit ulang atau hubungi owner jika ada kendala.`,
        { parse_mode:'HTML', reply_markup:{ inline_keyboard:[
          [{ text:B('💰 Deposit Ulang'), callback_data:'DEPOSIT_MENU' }],
          [{ text:B('📞 Hubungi Owner'), url:`https://t.me/${(config.OWNER_USERNAME||'').replace('@','')}` }]
        ]}}
      );
    } catch {}
    return;
  }

  if (data === 'OWNER_PANEL') {
    if (!isOwner(userId)) { await answerCb(cbId,'⛔ Owner only!',true); return; }
    await answerCb(cbId);
    await tryDel(chatId, msgId);
    return sendOwnerPanel(chatId);
  }
  if (data === 'SWITCH_GW') {
    if (!isOwner(userId)) { await answerCb(cbId,'⛔ Owner only!',true); return; }
    await answerCb(cbId);
    const cur    = db.getPaymentGateway();
    const qm     = db.getQrisManual();
    const gwLabel = cur === 'pakasir' ? '🟡 Pakasir' : cur === 'manual' ? '🔵 Manual QRIS' : '🟢 AtlanticH2H';
    const pickText =
      `👑 <b>${B('OWNER PANEL')}</b>\n\n`+
      `💳 ${B('Gateway aktif')}: <b>${gwLabel}</b>\n\n`+
      `Pilih payment gateway yang ingin digunakan:`;
    const pickKb = { inline_keyboard: [
      [
        { text: `🟢 Atlantic${cur==='atlantic'?' ✓':''}`,    callback_data:'GW_SET:atlantic' },
        { text: `🟡 Pakasir${cur==='pakasir'?' ✓':''}`,     callback_data:'GW_SET:pakasir'  },
        { text: `🔵 Manual${cur==='manual'?' ✓':qm.file_id?'':' ⚠️'}`,  callback_data:'GW_SET:manual'   },
      ],
      [{ text: B('⬅️ Kembali'), callback_data:'OWNER_PANEL' }]
    ]};
    try {
      await bot.editMessageText(pickText, { chat_id:chatId, message_id:msgId, parse_mode:'HTML', reply_markup:pickKb });
    } catch {
      await tryDel(chatId, msgId);
      await bot.sendMessage(chatId, pickText, { parse_mode:'HTML', reply_markup:pickKb });
    }
    return;
  }
  if (data.startsWith('GW_SET:')) {
    if (!isOwner(userId)) { await answerCb(cbId,'⛔ Owner only!',true); return; }
    const chosen = data.slice('GW_SET:'.length);
    if (!['atlantic','pakasir','manual'].includes(chosen)) { await answerCb(cbId,'❌ Invalid',true); return; }
    if (chosen === 'manual' && !db.getQrisManual().file_id) {
      await answerCb(cbId, '❌ QRIS Manual belum diset!\nReply foto QRIS lalu ketik /setqris', true);
      return;
    }
    db.setPaymentGateway(chosen);
    const label = chosen === 'pakasir' ? 'Pakasir' : chosen === 'manual' ? 'Manual QRIS' : 'AtlanticH2H';
    await answerCb(cbId, `✅ Gateway → ${label}`, true);
    try {
      await bot.deleteMessage(chatId, msgId);
    } catch {}
    return sendOwnerPanel(chatId);
  }
  if (data === 'TOGGLE_MAINTENANCE') {
    if (!isOwner(userId)) { await answerCb(cbId,'⛔ Owner only!',true); return; }
    const cur = db.getMaintenance();
    db.setMaintenance(!cur);
    await answerCb(cbId, `${!cur?'🔴 Maintenance ON':'🟢 Maintenance OFF'}`, true);
    await tryDel(chatId, msgId); return sendOwnerPanel(chatId);
  }
  if (data === 'TOGGLE_RESELLER') {
    if (!isOwner(userId)) { await answerCb(cbId,'⛔ Owner only!',true); return; }
    const cur = db.getSetting('reseller_enabled') !== false;
    db.setSetting('reseller_enabled', !cur);
    await answerCb(cbId, `${!cur?'✅ Aktif':'❌ Nonaktif'}`, true);
    await tryDel(chatId, msgId); return sendOwnerPanel(chatId);
  }
  if (data === 'TOGGLE_ADMIN') {
    if (!isOwner(userId)) { await answerCb(cbId,'⛔ Owner only!',true); return; }
    const cur = db.getSetting('admin_enabled') !== false;
    db.setSetting('admin_enabled', !cur);
    await answerCb(cbId, `${!cur?'✅ Aktif':'❌ Nonaktif'}`, true);
    await tryDel(chatId, msgId); return sendOwnerPanel(chatId);
  }
  if (data === 'TOGGLE_RESSVPS') {
    if (!isOwner(userId)) { await answerCb(cbId,'⛔ Owner only!',true); return; }
    const cur = db.getSetting('resellervps_enabled') !== false;
    db.setSetting('resellervps_enabled', !cur);
    await answerCb(cbId, `${!cur?'✅ Aktif':'❌ Nonaktif'}`, true);
    await tryDel(chatId, msgId); return sendOwnerPanel(chatId);
  }
  if (data === 'TOGGLE_PTVPS') {
    if (!isOwner(userId)) { await answerCb(cbId,'⛔ Owner only!',true); return; }
    const cur = db.getSetting('ptvps_enabled') !== false;
    db.setSetting('ptvps_enabled', !cur);
    await answerCb(cbId, `${!cur?'✅ Aktif':'❌ Nonaktif'}`, true);
    await tryDel(chatId, msgId); return sendOwnerPanel(chatId);
  }
  if (data === 'LIST_REQ') {
    if (!isOwner(userId)) { await answerCb(cbId,'⛔ Owner only!',true); return; }
    await answerCb(cbId);
    const list = db.getRequiredJoins();
    if (!list.length) { await bot.sendMessage(chatId,'📋 Belum ada required join.\n<code>/addreq @username NamaChannel</code>',{parse_mode:'HTML'}); return; }
    const kb = { inline_keyboard: [
      ...list.map(r=>([{ text: `🗑 @${r.username}`, callback_data:`DEL_REQ:${r.username}` }])),
      [{ text: B('⬅️ Kembali'), callback_data:'OWNER_PANEL' }]
    ]};
    return bot.sendMessage(chatId, `📋 <b>Required Join:</b>\n\n`+list.map((r,i)=>`${i+1}. @${r.username} — ${escH(r.name)}`).join('\n'), { parse_mode:'HTML', reply_markup:kb });
  }
  if (data.startsWith('DEL_REQ:')) {
    if (!isOwner(userId)) { await answerCb(cbId,'⛔',true); return; }
    const uname = data.split(':')[1];
    db.removeRequiredJoin(uname);
    await answerCb(cbId, `✅ @${uname} dihapus`, true);
    await tryDel(chatId, msgId);
    return sendOwnerPanel(chatId);
  }
  if (data === 'LIST_SERVER') {
    if (!isOwner(userId)) { await answerCb(cbId,'⛔',true); return; }
    await answerCb(cbId);
    const srvs = db.getAllServers();
    if (!srvs.length) return bot.sendMessage(chatId, '📡 Belum ada server.\n<code>/addserver domain ptla ptlc 1 5 15</code>', { parse_mode:'HTML' });
    const text = srvs.map((s,i)=>`${i+1}. <b>${escH(s.name)}</b>\n   ${escH(s.domain)}\n   EggID: ${s.egg_id} | ID: <code>${s.id}</code>`).join('\n\n');
    const kb   = { inline_keyboard: [
      ...srvs.map(s=>([{ text: `🗑 Del ${s.name}`, callback_data:`DEL_SRV:${s.id}` }])),
      [{ text: B('⬅️ Kembali'), callback_data:'OWNER_PANEL' }]
    ]};
    return bot.sendMessage(chatId, `📡 <b>Server List:</b>\n\n${text}`, { parse_mode:'HTML', reply_markup:kb });
  }
  if (data.startsWith('DEL_SRV:')) {
    if (!isOwner(userId)) { await answerCb(cbId,'⛔',true); return; }
    const id = parseInt(data.split(':')[1]);
    db.removeServer(id);
    await answerCb(cbId, '✅ Server dihapus', true);
    await tryDel(chatId, msgId);
    return sendOwnerPanel(chatId);
  }
  if (data === 'BACKUP_DB') {
    if (!isOwner(userId)) { await answerCb(cbId,'⛔',true); return; }
    await answerCb(cbId, '⏳ Membuat backup...');
    try {
      const now    = new Date().toLocaleString('id-ID',{timeZone:'Asia/Jakarta'})
                       .replace(/[/:]/g,'-').replace(/,/,'').replace(/ /g,'_');
      const zipBuf = await createBackupZip();
      const files  = db.getDbFiles();
      const caption =
        `🗄️ <b>Backup Database</b>\n`+
        `🕐 ${new Date().toLocaleString('id-ID',{timeZone:'Asia/Jakarta'})} WIB\n`+
        `📦 ${files.length} file terkemas\n`+
        `💾 ${(zipBuf.length/1024).toFixed(1)} KB`;
      return bot.sendDocument(chatId, zipBuf,
        { caption, parse_mode:'HTML' },
        { filename:`backup-db-${now}.zip`, contentType:'application/zip' }
      );
    } catch(e) {
      return bot.sendMessage(chatId, `❌ Backup gagal: ${escH(e.message)}`);
    }
  }
  if (data === 'OWNER_STATS') {
    if (!isOwner(userId)) { await answerCb(cbId,'⛔',true); return; }
    await answerCb(cbId);
    const users = db.getAllUsers();
    const totalBal = users.reduce((s,u)=>s+(u.balance||0),0);
    return bot.sendMessage(chatId,
      `📊 <b>${B('Statistik Bot')}</b>\n\n`+
      `👥 ${B('Users')}: <b>${users.length}</b>\n`+
      `💰 ${B('Total Saldo')}: <b>Rp${fmt(totalBal)}</b>\n`+
      `📱 ${B('Nokos Stok')}: <b>${db.countNokos()}</b> | ${B('Terjual')}: <b>${db.countNokosSold()}</b>\n`+
      `💳 ${B('Gateway')}: <b>${db.getPaymentGateway()}</b>`,
      { parse_mode:'HTML', reply_markup:{ inline_keyboard:[[{ text: B('⬅️ Kembali'), callback_data:'OWNER_PANEL' }]] } }
    );
  }

  await answerCb(cbId);
});

async function sendMyPanel(chatId, userId, _page, msgId) {
  const rawPanels = db.getUserPanels(userId);

  
  const servers = db.getAllServers();
  const validPanels = [];
  for (const p of rawPanels) {
    const srv = servers.find(s => s.domain === p.domain);
    if (!srv) {
      
      db.removePanelRecord(p.uuid);
      continue;
    }
    
    const res = await ptero.getServerResources(srv, p.uuid).catch(() => null);
    if (res === null) {
      
      db.removePanelRecord(p.uuid);
      continue;
    }
    validPanels.push(p);
  }

  
  if (!validPanels.length) {
    const text = `📦 <b>${B('PANEL SAYA')}</b>\n\n❌ Kamu belum punya panel aktif.\nBeli panel dulu melalui menu Layanan.`;
    const kb = { inline_keyboard:[
      [{ text: B('🛒 Beli Panel'), callback_data:'MENU_PANEL' }],
      [{ text: B('🏠 Menu Utama'), callback_data:'MAIN_MENU' }]
    ]};
    if (msgId) { try { await bot.editMessageText(text,{chat_id:chatId,message_id:msgId,parse_mode:'HTML',reply_markup:kb}); return; } catch {} }
    return bot.sendMessage(chatId, text, { parse_mode:'HTML', reply_markup:kb });
  }

  
  const now = Date.now();
  const text = `📦 <b>${B('PANEL SAYA')}</b>\n\nKamu punya <b>${validPanels.length}</b> panel aktif.\nPilih panel untuk melihat detail:`;

  const panelRows = validPanels.map(p => {
    const expired = p.expiry_ms - now <= 0;
    const icon = expired ? '⛔' : '🟢';
    return [{ text: `${icon} ${p.name}`, callback_data: `PANEL_INFO:${p.uuid}:0` }];
  });

  const kb = { inline_keyboard: [
    ...panelRows,
    [{ text: B('🏠 Menu Utama'), callback_data: 'MAIN_MENU' }]
  ]};

  if (msgId) { try { await bot.editMessageText(text,{chat_id:chatId,message_id:msgId,parse_mode:'HTML',reply_markup:kb}); return; } catch {} }
  return bot.sendMessage(chatId, text, { parse_mode:'HTML', reply_markup:kb });
}

async function sendPanelInfo(chatId, userId, uuid, backPage, msgId) {
  const rec = db.getPanelByUuid(uuid);
  if (!rec || String(rec.owner_id) !== String(userId)) {
    if (msgId) { try { await bot.editMessageText('❌ Panel tidak ditemukan.',{chat_id:chatId,message_id:msgId}); } catch {} }
    return;
  }
  const now       = Date.now();
  const remaining = rec.expiry_ms - now;
  const expired   = remaining <= 0;
  const expiryStr = new Date(rec.expiry_ms).toLocaleString('id-ID',{timeZone:'Asia/Jakarta'});
  const planLabel = PANEL_PLANS.find(x=>x.key===rec.plan_key)?.label || rec.plan_key;

  
  const servers = db.getAllServers();
  const srv     = servers.find(s => s.domain === rec.domain);
  let statusLine = '⏳ ...';
  let uptimeLine = '—';
  let langLine   = '—';
  if (srv) {
    try {
      const res = await ptero.getServerResources(srv, uuid).catch(()=>null);
      if (res) {
        const st = res.current_state || 'unknown';
        const statusEmoji = st === 'running' ? '🟢 Online' : st === 'offline' ? '🔴 Offline' : `🟡 ${st}`;
        statusLine = statusEmoji;
        const uptimeSec = res.resources?.uptime || 0;
        uptimeLine = uptimeSec > 0 ? fmtDurasi(uptimeSec * 1000) : '—';
      } else {
        
        db.removePanelRecord(uuid);
        const delText =
          `⚠️ <b>${B('SERVER TIDAK DITEMUKAN')}</b>\n\n` +
          `Panel <b>${escH(rec.name)}</b> tidak lagi ditemukan di server.\n` +
          `Kemungkinan sudah dihapus oleh admin.\n\n` +
          `📌 Data panel ini telah dihapus dari akun kamu.\nHubungi owner jika ada pertanyaan.`;
        const delKb = { inline_keyboard:[
          [{ text:B('📦 Panel Saya'), callback_data:'MYPANEL:0' }],
          [{ text:B('🏠 Menu Utama'), callback_data:'MAIN_MENU' }]
        ]};
        if (msgId) { try { await bot.editMessageText(delText,{chat_id:chatId,message_id:msgId,parse_mode:'HTML',reply_markup:delKb}); return; } catch {} }
        return bot.sendMessage(chatId, delText, { parse_mode:'HTML', reply_markup:delKb });
      }
    } catch {}
    
    langLine = srv.egg_id == 16 ? '🐍 Python' : '⚡ Node.js';
  } else {
    
    db.removePanelRecord(uuid);
    const delText =
      `⚠️ <b>${B('SERVER TIDAK DITEMUKAN')}</b>\n\n` +
      `Panel <b>${escH(rec.name)}</b> tidak lagi ditemukan.\n` +
      `Server dengan domain <code>${escH(rec.domain)}</code> sudah tidak terdaftar.\n\n` +
      `📌 Data panel ini telah dihapus dari akun kamu.\nHubungi owner jika ada pertanyaan.`;
    const delKb = { inline_keyboard:[
      [{ text:B('📦 Panel Saya'), callback_data:'MYPANEL:0' }],
      [{ text:B('🏠 Menu Utama'), callback_data:'MAIN_MENU' }]
    ]};
    if (msgId) { try { await bot.editMessageText(delText,{chat_id:chatId,message_id:msgId,parse_mode:'HTML',reply_markup:delKb}); return; } catch {} }
    return bot.sendMessage(chatId, delText, { parse_mode:'HTML', reply_markup:delKb });
  }

  const text =
    `🖥 <b>${B('INFO PANEL')}</b>\n\n` +
    `📛 <b>${escH(rec.name)}</b>\n` +
    `🆔 UUID: <code>${rec.uuid}</code>\n` +
    `⚙️ Runtime: <b>${langLine}</b>\n` +
    `📊 Status: <b>${statusLine}</b>\n` +
    `⏱ Uptime: <b>${uptimeLine}</b>\n` +
    `📦 Plan: <b>${planLabel}</b>\n` +
    `🕐 Masa Aktif: <b>${expired ? '⛔ HABIS' : fmtDurasi(remaining)}</b>\n` +
    `📅 Sampai: <b>${expiryStr} WIB</b>`;

  const kb = { inline_keyboard: [
    [
      { text:'▶️ Start',   callback_data:`PANEL_PWR:${uuid}:start:${backPage}` },
      { text:'⏹ Stop',    callback_data:`PANEL_PWR:${uuid}:stop:${backPage}` },
      { text:'🔄 Restart', callback_data:`PANEL_PWR:${uuid}:restart:${backPage}` }
    ],
    [{ text:'⏰ Perpanjang', callback_data:`PANEL_EXTEND:${uuid}:${backPage}` }],
    [{ text:B('⬅️ Kembali'), callback_data:`MYPANEL:${backPage}` }]
  ]};
  if (msgId) { try { await bot.editMessageText(text,{chat_id:chatId,message_id:msgId,parse_mode:'HTML',reply_markup:kb}); return; } catch {} }
  return bot.sendMessage(chatId, text, { parse_mode:'HTML', reply_markup:kb });
}

async function sendPanelExtend(chatId, userId, uuid, backPage, msgId) {
  const rec = db.getPanelByUuid(uuid);
  if (!rec || String(rec.owner_id) !== String(userId)) return;
  const now       = Date.now();
  const remaining = rec.expiry_ms - now;
  const expired   = remaining <= 0;
  const masaText  = expired ? '\u26d4 HABIS' : fmtDurasi(remaining);

  
  const dursWithPrice = PANEL_DURATIONS.filter(d => {
    const deleted = db.getSetting(`harga_dur_deleted_${rec.plan_key}_${d.key}`);
    if (deleted === true) return false;
    const v = db.getSetting(`harga_${rec.plan_key}_${d.key}`);
    return v !== undefined && v !== null && v !== '';
  });

  
  if (dursWithPrice.length === 0) {
    const text =
      `\u23f0 <b>${B('PERPANJANG PANEL')}</b>\n\n` +
      `\ud83d\udcdb <b>${escH(rec.name)}</b>\n` +
      `\ud83d\udd50 Masa Aktif: <b>${masaText}</b>\n\n` +
      `\u26a0\ufe0f Harga perpanjangan belum dikonfigurasi.\nHubungi owner untuk info harga.`;
    const kb = { inline_keyboard: [[{ text:B('\u2b05\ufe0f Kembali'), callback_data:`PANEL_INFO:${uuid}:${backPage}` }]] };
    if (msgId) { try { await bot.editMessageText(text,{chat_id:chatId,message_id:msgId,parse_mode:'HTML',reply_markup:kb}); return; } catch {} }
    return bot.sendMessage(chatId, text, { parse_mode:'HTML', reply_markup:kb });
  }

  const rows = dursWithPrice.map(d => {
    const h = parseInt(db.getSetting(`harga_${rec.plan_key}_${d.key}`));
    return [{ text:`${d.label} \u2014 Rp${fmt(h)}`, callback_data:`PANEL_EXT_CONF:${uuid}:${d.key}:${backPage}` }];
  });
  rows.push([{ text:B('\u2b05\ufe0f Kembali'), callback_data:`PANEL_INFO:${uuid}:${backPage}` }]);
  const text =
    `\u23f0 <b>${B('PERPANJANG PANEL')}</b>\n\n` +
    `\ud83d\udcdb <b>${escH(rec.name)}</b>\n` +
    `\ud83d\udd50 Masa Aktif: <b>${masaText}</b>\n\n` +
    `Pilih durasi perpanjangan:`;
  if (msgId) { try { await bot.editMessageText(text,{chat_id:chatId,message_id:msgId,parse_mode:'HTML',reply_markup:{inline_keyboard:rows}}); return; } catch {} }
  return bot.sendMessage(chatId, text, { parse_mode:'HTML', reply_markup:{inline_keyboard:rows} });
}

async function handlePanelExtendConfirm(chatId, userId, uuid, durKey, backPage, cbId, msgId) {
  const rec   = db.getPanelByUuid(uuid);
  if (!rec || String(rec.owner_id) !== String(userId)) { await answerCb(cbId,'❌ Panel tidak ditemukan.',true); return; }
  
  const storedHarga = db.getSetting(`harga_${rec.plan_key}_${durKey}`);
  if (!storedHarga) { await answerCb(cbId,'❌ Harga durasi ini belum di-set owner.',true); return; }
  const harga = parseInt(storedHarga);
  const dur   = PANEL_DURATIONS.find(d=>d.key===durKey);
  const bal   = db.getBalance(userId);
  await answerCb(cbId);
  const now       = Date.now();
  const remaining = rec.expiry_ms - now;
  const masaText  = remaining > 0 ? fmtDurasi(remaining) : '⛔ HABIS';
  const text =
    `⏰ <b>${B('KONFIRMASI PERPANJANG')}</b>\n\n` +
    `📛 <b>${escH(rec.name)}</b>\n` +
    `🕐 Masa Aktif Sekarang: <b>${masaText}</b>\n` +
    `➕ Tambah Durasi: <b>${dur?.label||durKey}</b>\n` +
    `💰 Biaya: <b>Rp${fmt(harga)}</b>\n` +
    `💳 Saldo: <b>Rp${fmt(bal)}</b>\n\n` +
    (bal >= harga ? `✅ Konfirmasi perpanjangan?` : `❌ Saldo tidak cukup.\nKurang: Rp${fmt(harga-bal)}`);
  const kb = { inline_keyboard: [
    ...(bal >= harga
      ? [[{ text:B('✅ Ya, Perpanjang'), callback_data:`PANEL_EXT_EXEC:${uuid}:${durKey}:${backPage}` }]]
      : [[{ text:B('💰 Deposit'), callback_data:'DEPOSIT_MENU' }]]),
    [{ text:B('⬅️ Kembali'), callback_data:`PANEL_EXTEND:${uuid}:${backPage}` }]
  ]};
  if (msgId) { try { await bot.editMessageText(text,{chat_id:chatId,message_id:msgId,parse_mode:'HTML',reply_markup:kb}); return; } catch {} }
  return bot.sendMessage(chatId, text, { parse_mode:'HTML', reply_markup:kb });
}

async function execPanelExtend(chatId, userId, uuid, durKey, backPage, cbId, msgId) {
  const rec = db.getPanelByUuid(uuid);
  if (!rec || String(rec.owner_id) !== String(userId)) { await answerCb(cbId,'❌',true); return; }
  
  const storedHarga = db.getSetting(`harga_${rec.plan_key}_${durKey}`);
  if (!storedHarga) { await answerCb(cbId,'❌ Harga durasi ini belum di-set.',true); return; }
  const harga = parseInt(storedHarga);
  const dur   = PANEL_DURATIONS.find(d=>d.key===durKey);
  const ok    = db.deductBalance(userId, harga);
  if (!ok) { await answerCb(cbId,'❌ Saldo tidak cukup!',true); return; }
  await answerCb(cbId);
  const newExpiry = db.adjustPanelExpiry(uuid, dur.ms);
  scheduleExactSuspend(uuid, newExpiry);
  const expiryStr = new Date(newExpiry).toLocaleString('id-ID',{timeZone:'Asia/Jakarta'});
  const orderId   = genId();
  const from      = { id: userId, username: rec.owner_username || null, first_name: 'User' };
  const uname     = rec.owner_username ? `@${rec.owner_username}` : `ID:${userId}`;
  db.saveTx({ order_id: orderId, user_id: userId, amount: harga, variant:'perpanjang', status:'completed' });

  
  let unsuspendStatus = '';
  try {
    const servers = db.getAllServers();
    const found = await findServerByUuid(servers, uuid);
    if (found) {
      await ptero.unsuspendServer(found.srv, found.internalId);
      unsuspendStatus = '\n✅ <b>Panel telah diaktifkan kembali</b>';
    }
  } catch (e) {
    unsuspendStatus = `\n⚠️ Gagal unsuspend otomatis: <code>${escH(e.message)}</code>`;
    console.error('[execPanelExtend] unsuspend error:', e.message);
  }

  const text =
    `✅ <b>${B('PERPANJANG BERHASIL')}</b>\n\n` +
    `📛 <b>${escH(rec.name)}</b>\n` +
    `➕ Ditambah: <b>${dur.label}</b>\n` +
    `💰 Biaya: <b>Rp${fmt(harga)}</b>\n` +
    `💳 Sisa Saldo: <b>Rp${fmt(db.getBalance(userId))}</b>\n` +
    `📅 Masa Aktif Baru: <b>${expiryStr} WIB</b>\n` +
    `🕐 Sisa: <b>${fmtDurasi(newExpiry - Date.now())}</b>` +
    unsuspendStatus;
  const kb = { inline_keyboard: [
    [{ text:B('🖥 Lihat Panel'), callback_data:`PANEL_INFO:${uuid}:${backPage}` }],
    [{ text:B('⬅️ Panel Saya'), callback_data:`MYPANEL:${backPage}` }]
  ]};
  if (msgId) { try { await bot.editMessageText(text,{chat_id:chatId,message_id:msgId,parse_mode:'HTML',reply_markup:kb}); } catch {
    await bot.sendMessage(chatId, text, { parse_mode:'HTML', reply_markup:kb });
  }} else {
    await bot.sendMessage(chatId, text, { parse_mode:'HTML', reply_markup:kb });
  }

  
  try {
    const planLabel = PANEL_PLANS.find(x=>x.key===rec.plan_key)?.label || rec.plan_key;
    const imgP  = receipt.receiptPanel({ orderId, planKey: rec.plan_key, harga, metode:'saldo', pembeli: uname, username: rec.name, domain: rec.domain, isAdmin: false, botUsername: config.BOT_USERNAME });
    const notif = receipt.buildChannelNotif({ type:'panel', orderId, product:`Perpanjang ${planLabel} (${dur.label})`, harga, metode:'saldo', pembeli: uname, botUsername: config.BOT_USERNAME });
    sendChannelReceipt(imgP, notif);
  } catch {}

  
  try {
    const planLabel = PANEL_PLANS.find(x=>x.key===rec.plan_key)?.label || rec.plan_key;
    await bot.sendMessage(config.OWNER_ID,
      `⏰ <b>${B('PANEL DIPERPANJANG')}</b>\n\n` +
      `👤 Pemilik: ${escH(uname)} (<code>${userId}</code>)\n` +
      `📛 Panel: <b>${escH(rec.name)}</b>\n` +
      `📦 Plan: <b>${planLabel}</b>\n` +
      `➕ Durasi: <b>${dur.label}</b>\n` +
      `💰 Bayar: <b>Rp${fmt(harga)}</b>\n` +
      `📅 Aktif s/d: <b>${expiryStr} WIB</b>\n` +
      `🆔 Order: <code>${orderId}</code>`,
      { parse_mode:'HTML' });
  } catch {}
}

bot.onText(/^\/mypanel$/, async (msg) => {
  const chatId = msg.chat.id, userId = msg.from.id;
  db.upsertUser(msg.from);
  
  if (db.getMaintenance() && !isOwner(userId)) {
    const userPanels = db.getUserPanels(userId);
    if (!userPanels.length) { await maintBlocked(msg); return; }
  }
  return sendMyPanel(chatId, userId, 0, null);
});

bot.onText(/^\/info(?:\s+(\S+))?$/, async (msg, match) => {
  if (!isOwner(msg.from.id)) return;
  const chatId = msg.chat.id;
  const target = (match[1]||'').trim();
  if (!target) return bot.sendMessage(chatId, '❌ Format: <code>/info @username</code> atau <code>/info id</code>', {parse_mode:'HTML'});
  let u = null;
  if (target.startsWith('@')) u = db.getUserByUsername(target.slice(1));
  else if (/^\d+$/.test(target)) u = db.getUser(parseInt(target));
  else u = db.getUserByUsername(target);
  if (!u) return bot.sendMessage(chatId, `❌ User <code>${escH(target)}</code> tidak ditemukan.`, {parse_mode:'HTML'});

  const panels  = db.getUserPanels(u.id);
  const uname   = u.username ? `@${u.username}` : `ID:${u.id}`;
  if (!panels.length) return bot.sendMessage(chatId,
    `📋 <b>Info User</b>\n👤 ${escH(uname)} — belum punya panel.`, {parse_mode:'HTML'});

  const now    = Date.now();
  const PER_PAGE = 5;
  const total  = panels.length;
  
  const slice  = panels.slice(0, PER_PAGE);
  const lines  = [`📋 <b>Panel Milik ${escH(uname)}</b> (${total} panel)\n`];
  for (let i = 0; i < slice.length; i++) {
    const p       = slice[i];
    const rem     = p.expiry_ms - now;
    const durStr  = rem > 0 ? fmtDurasi(rem) : '⛔ Habis';
    lines.push(`${i+1}. <b>${escH(p.name)}</b>\n   UUID: <code>${p.uuid}</code>\n   Masa Aktif: <b>${durStr}</b>`);
  }
  const maxPage = Math.ceil(total/PER_PAGE)-1;
  const nav = [];
  if (maxPage > 0) nav.push({ text:'Next ▶️', callback_data:`OWNERINFO_PAGE:${u.id}:1` });
  const kb = nav.length ? { inline_keyboard:[nav] } : undefined;
  
  ownerInfoCache.set(`${msg.chat.id}_${u.id}`, panels);
  await bot.sendMessage(chatId, lines.join('\n'), {parse_mode:'HTML', reply_markup:kb});
});

const ownerInfoCache = new Map();

function parseDurasiStr(str) {
  if (!str) return null;
  str = str.trim().toLowerCase();
  const m = str.match(/^(?:(\d+)d)?(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/);
  if (!m || (!m[1] && !m[2] && !m[3] && !m[4])) return null;
  const ms = (parseInt(m[1]||0)*86400 + parseInt(m[2]||0)*3600
            + parseInt(m[3]||0)*60   + parseInt(m[4]||0)) * 1000;
  return ms > 0 ? ms : null;
}
function fmtDurasiInput(ms) {
  if (!ms || ms <= 0) return '0d';
  const tot_s = Math.floor(ms/1000);
  const d  = Math.floor(tot_s/86400);
  const h  = Math.floor((tot_s%86400)/3600);
  const m  = Math.floor((tot_s%3600)/60);
  const s  = tot_s%60;
  const parts = [];
  if (d) parts.push(d+'d');
  if (h) parts.push(h+'h');
  if (m) parts.push(m+'m');
  if (s) parts.push(s+'s');
  return parts.join(' ') || '0d';
}

bot.onText(/^\/perpanjang(?:\s+(\S+)(?:\s+(\S+))?)?$/, async (msg, match) => {
  if (!isOwner(msg.from.id)) return;
  const chatId = msg.chat.id;
  const uuid   = (match[1]||'').trim();
  const durArg = (match[2]||'').trim();
  if (!uuid) return bot.sendMessage(chatId,
    `❌ Format: <code>/perpanjang [uuid] [durasi]</code>\n\n` +
    `Durasi contoh: <code>30d</code> <code>12h</code> <code>45m</code> <code>120s</code> atau kombinasi <code>1d12h30m</code>\n` +
    `Satuan: d=hari, h=jam, m=menit, s=detik`, {parse_mode:'HTML'});
  const rec = db.getPanelByUuid(uuid);
  if (!rec) return bot.sendMessage(chatId, `❌ UUID <code>${escH(uuid)}</code> tidak ditemukan.`, {parse_mode:'HTML'});
  const now    = Date.now();
  const rem    = rec.expiry_ms - now;
  const masaTxt= rem > 0 ? fmtDurasi(rem) : '⛔ Habis';
  
  if (!durArg) return bot.sendMessage(chatId,
    `⏰ <b>Perpanjang Panel (Owner)</b>\n\n` +
    `📛 <b>${escH(rec.name)}</b>\n` +
    `🕐 Masa Aktif: <b>${masaTxt}</b>\n\n` +
    `Ketik durasi langsung di command:\n` +
    `<code>/perpanjang ${uuid} 30d</code>\n` +
    `<code>/perpanjang ${uuid} 12h</code>\n` +
    `<code>/perpanjang ${uuid} 1d12h</code>\n\n` +
    `Satuan: <b>d</b>=hari, <b>h</b>=jam, <b>m</b>=menit, <b>s</b>=detik`,
    {parse_mode:'HTML'});
  const deltaMs = parseDurasiStr(durArg);
  if (!deltaMs) return bot.sendMessage(chatId,
    `❌ Format durasi salah: <code>${escH(durArg)}</code>\nContoh: <code>30d</code>, <code>12h</code>, <code>45m</code>, <code>1d12h30m</code>`,
    {parse_mode:'HTML'});
  const newExp = db.adjustPanelExpiry(uuid, deltaMs);
  if (!newExp) return bot.sendMessage(chatId, '❌ Gagal update masa aktif.', {parse_mode:'HTML'});
  scheduleExactSuspend(uuid, newExp);
  const expiryStr = new Date(newExp).toLocaleString('id-ID',{timeZone:'Asia/Jakarta'});
  
  let unsuspendTxt = '';
  try {
    const found = await findServerByUuid(db.getAllServers(), uuid);
    if (found) { await ptero.unsuspendServer(found.srv, found.internalId); unsuspendTxt = '\n✅ Panel diaktifkan kembali'; }
  } catch(e) { unsuspendTxt = `\n⚠️ Gagal unsuspend: ${escH(e.message)}`; }
  await bot.sendMessage(chatId,
    `✅ <b>Perpanjang Berhasil (Owner)</b>\n\n` +
    `📛 <b>${escH(rec.name)}</b>\n` +
    `➕ Ditambah: <b>${fmtDurasiInput(deltaMs)}</b>\n` +
    `📅 Aktif s/d: <b>${expiryStr} WIB</b>\n` +
    `🕐 Sisa: <b>${fmtDurasi(newExp-Date.now())}</b>` +
    unsuspendTxt,
    {parse_mode:'HTML'});
});

bot.onText(/^\/kurangi(?:\s+(\S+)(?:\s+(\S+))?)?$/, async (msg, match) => {
  if (!isOwner(msg.from.id)) return;
  const chatId = msg.chat.id;
  const uuid   = (match[1]||'').trim();
  const durArg = (match[2]||'').trim();
  if (!uuid) return bot.sendMessage(chatId,
    `❌ Format: <code>/kurangi [uuid] [durasi]</code>\n\n` +
    `Durasi contoh: <code>30d</code> <code>12h</code> <code>45m</code> <code>120s</code> atau kombinasi <code>1d12h30m</code>\n` +
    `Satuan: d=hari, h=jam, m=menit, s=detik`, {parse_mode:'HTML'});
  const rec = db.getPanelByUuid(uuid);
  if (!rec) return bot.sendMessage(chatId, `❌ UUID <code>${escH(uuid)}</code> tidak ditemukan.`, {parse_mode:'HTML'});
  if (!durArg) {
    const rem = rec.expiry_ms - Date.now();
    return bot.sendMessage(chatId,
      `✂️ <b>Kurangi Masa Aktif (Owner)</b>\n\n` +
      `📛 <b>${escH(rec.name)}</b>\n` +
      `🕐 Masa Aktif: <b>${rem > 0 ? fmtDurasi(rem) : '⛔ Habis'}</b>\n\n` +
      `Ketik durasi langsung di command:\n` +
      `<code>/kurangi ${uuid} 7d</code>\n` +
      `<code>/kurangi ${uuid} 6h</code>\n` +
      `<code>/kurangi ${uuid} 1d12h</code>\n\n` +
      `Satuan: <b>d</b>=hari, <b>h</b>=jam, <b>m</b>=menit, <b>s</b>=detik`,
      {parse_mode:'HTML'});
  }
  const deltaMs = parseDurasiStr(durArg);
  if (!deltaMs) return bot.sendMessage(chatId,
    `❌ Format durasi salah: <code>${escH(durArg)}</code>\nContoh: <code>7d</code>, <code>12h</code>, <code>30m</code>, <code>1d6h30m</code>`,
    {parse_mode:'HTML'});
  const newExp = db.adjustPanelExpiry(uuid, -deltaMs);
  if (!newExp) return bot.sendMessage(chatId, '❌ Gagal update masa aktif.', {parse_mode:'HTML'});
  const expiryStr = new Date(newExp).toLocaleString('id-ID',{timeZone:'Asia/Jakarta'});
  await bot.sendMessage(chatId,
    `✅ <b>Masa Aktif Dikurangi (Owner)</b>\n\n` +
    `📛 <b>${escH(rec.name)}</b>\n` +
    `➖ Dikurangi: <b>${fmtDurasiInput(deltaMs)}</b>\n` +
    `📅 Sekarang: <b>${expiryStr} WIB</b>\n` +
    `🕐 Sisa: <b>${fmtDurasi(Math.max(0,newExp-Date.now()))}</b>`,
    {parse_mode:'HTML'});
});

bot.onText(/^\/addpanel(?:\s+(\S+)(?:\s+(\S+)(?:\s+(\S+))?)?)?$/, async (msg, match) => {
  if (!isOwner(msg.from.id)) return;
  const chatId  = msg.chat.id;
  const uuid    = (match[1]||'').trim();
  const durArg  = (match[2]||'').trim();
  const userArg = (match[3]||'').trim();

  const USAGE =
    `❌ Format: <code>/addpanel [uuid] [durasi] [@user/id]</code>\n\n` +
    `Durasi contoh: <code>30d</code> <code>12h</code> <code>1d12h</code>\n` +
    `User: <code>@username</code> atau <code>123456789</code> (Telegram ID)\n\n` +
    `Contoh:\n` +
    `<code>/addpanel abc-uuid-123 30d @johndoe</code>\n` +
    `<code>/addpanel abc-uuid-123 30d 123456789</code>`;

  if (!uuid || !durArg || !userArg) return bot.sendMessage(chatId, USAGE, {parse_mode:'HTML'});

  
  const deltaMs = parseDurasiStr(durArg);
  if (!deltaMs) return bot.sendMessage(chatId,
    `❌ Format durasi salah: <code>${escH(durArg)}</code>\nContoh: <code>30d</code>, <code>12h</code>, <code>1d12h30m</code>`,
    {parse_mode:'HTML'});

  
  let targetId = null, targetUsername = null;
  if (/^\d+$/.test(userArg)) {
    targetId = userArg;
    const u = db.getUser(userArg);
    targetUsername = u?.username || null;
  } else {
    const uname = userArg.replace(/^@/, '');
    const u = db.getUserByUsername(uname);
    if (!u) return bot.sendMessage(chatId,
      `❌ User <b>@${escH(uname)}</b> tidak ditemukan di database.\nGunakan Telegram ID langsung jika user belum pernah pakai bot.`,
      {parse_mode:'HTML'});
    targetId = String(u.id);
    targetUsername = u.username || null;
  }

  
  const servers = db.getAllServers();
  const found = await findServerByUuid(servers, uuid).catch(() => null);
  if (!found) return bot.sendMessage(chatId,
    `❌ UUID <code>${escH(uuid)}</code> tidak ditemukan di server Pterodactyl manapun.\nPastikan UUID benar dan server sudah ditambahkan.`,
    {parse_mode:'HTML'});

  
  const existing = db.getPanelByUuid(uuid);
  const expiryMs = Date.now() + deltaMs;
  const expiryStr = new Date(expiryMs).toLocaleString('id-ID', {timeZone:'Asia/Jakarta'});

  if (existing) {
    
    const all = db.getAllPanelRecords();
    const pr  = all.find(x => x.uuid === uuid);
    if (pr) {
      pr.owner_id       = String(targetId);
      pr.owner_username = targetUsername;
      pr.expiry_ms      = expiryMs;
      pr.suspended      = false;
      pr.suspended_at   = null;
      db._setPanels(all);
    }
    scheduleExactSuspend(uuid, expiryMs);
    await bot.sendMessage(chatId,
      `✅ <b>Panel diperbarui (Owner)</b>\n\n` +
      `📛 Server: <b>${escH(found.serverName || uuid)}</b>\n` +
      `🌐 Domain: <code>${escH(found.srv.domain)}</code>\n` +
      `👤 Pemilik: ${targetUsername ? `@${escH(targetUsername)}` : ''} (<code>${targetId}</code>)\n` +
      `⏱ Durasi: <b>${fmtDurasiInput(deltaMs)}</b>\n` +
      `📅 Aktif s/d: <b>${expiryStr} WIB</b>`,
      {parse_mode:'HTML'});
  } else {
    
    db.addPanelRecord({
      uuid,
      name:           found.serverName || uuid,
      domain:         found.srv.domain,
      owner_id:       targetId,
      owner_username: targetUsername,
      plan_key:       'manual',
      expiry_ms:      expiryMs,
    });
    scheduleExactSuspend(uuid, expiryMs);
    await bot.sendMessage(chatId,
      `✅ <b>Panel ditambahkan (Owner)</b>\n\n` +
      `📛 Server: <b>${escH(found.serverName || uuid)}</b>\n` +
      `🌐 Domain: <code>${escH(found.srv.domain)}</code>\n` +
      `👤 Pemilik: ${targetUsername ? `@${escH(targetUsername)}` : ''} (<code>${targetId}</code>)\n` +
      `⏱ Durasi: <b>${fmtDurasiInput(deltaMs)}</b>\n` +
      `📅 Aktif s/d: <b>${expiryStr} WIB</b>`,
      {parse_mode:'HTML'});
  }

  
  try {
    await bot.sendMessage(targetId,
      `📦 <b>Panel Kamu Sudah Terdaftar!</b>\n\n` +
      `📛 <b>${escH(found.serverName || uuid)}</b>\n` +
      `🌐 <code>${escH(found.srv.domain)}</code>\n` +
      `📅 Aktif s/d: <b>${expiryStr} WIB</b>\n` +
      `🕐 Sisa: <b>${fmtDurasi(deltaMs)}</b>\n\n` +
      `Gunakan /mypanel untuk kelola panel kamu.`,
      {parse_mode:'HTML'});
  } catch {}
});

async function sendOwnerSetHargaMenu(chatId, msgId) {
  const plans = PANEL_PLANS;
  const rows = [];
  for (let i = 0; i < plans.length; i += 3) {
    rows.push(plans.slice(i, i + 3).map(p => ({ text: `📦 ${p.label}`, callback_data: `SETHARGA_PLAN:${p.key}` })));
  }
  const hargaReseller = db.getSetting('harga_reseller') || config.HARGA.reseller;
  const hargaAdmin    = db.getSetting('harga_admin')    || config.HARGA.admin;
  rows.push([
    { text: `👑 Reseller — Rp${fmt(hargaReseller)}`, callback_data: 'SETHARGA_RESELLER' },
    { text: `🛠️ Admin — Rp${fmt(hargaAdmin)}`,       callback_data: 'SETHARGA_ADMIN' }
  ]);
  rows.push([{ text: B('⬅️ Kembali'), callback_data: 'OWNER_PANEL' }]);
  const text = `🔧 <b>${B('SETHARGA')}</b>\n\nPilih plan panel untuk atur harga per durasi,\natau set harga Reseller / Admin Panel:`;
  if (msgId) { try { await bot.editMessageText(text,{chat_id:chatId,message_id:msgId,parse_mode:'HTML',reply_markup:{inline_keyboard:rows}}); return; } catch {} }
  return bot.sendMessage(chatId, text, { parse_mode:'HTML', reply_markup:{inline_keyboard:rows} });
}

async function sendOwnerSetHargaPlanDur(chatId, planKey, msgId) {
  const plan = PANEL_PLANS.find(p=>p.key===planKey);
  const rows = [];
  const durs = PANEL_DURATIONS;
  for (let i = 0; i < durs.length; i += 2) {
    const pair = durs.slice(i, i + 2);
    const rowBtns = [];
    for (const d of pair) {
      const cur     = db.getSetting(`harga_${planKey}_${d.key}`);
      const deleted = db.getSetting(`harga_dur_deleted_${planKey}_${d.key}`);
      if (deleted) {
        rowBtns.push({ text: `❌ ${d.label}`, callback_data:`SETHARGA_RESTORE:${planKey}:${d.key}` });
      } else {
        rowBtns.push({ text: `${d.label}${cur?` Rp${fmt(cur)}`:''}`, callback_data:`SETHARGA_INPUT:${planKey}:${d.key}` });
        rowBtns.push({ text: '🗑', callback_data:`SETHARGA_DEL:${planKey}:${d.key}` });
      }
    }
    rows.push(rowBtns);
  }
  rows.push([{ text: B('⬅️ Kembali'), callback_data:'OWNER_SETHARGA_MENU' }]);
  const text = `🔧 <b>Harga ${plan?.label||planKey}</b>\n\nTombol 🗑 = hapus durasi dari pilihan beli\nKlik durasi = atur harga baru`;
  if (msgId) { try { await bot.editMessageText(text,{chat_id:chatId,message_id:msgId,parse_mode:'HTML',reply_markup:{inline_keyboard:rows}}); return; } catch {} }
  return bot.sendMessage(chatId, text, { parse_mode:'HTML', reply_markup:{inline_keyboard:rows} });
}

function getAvailableDurations(planKey) {
  
  
  
  
  const notDeleted = PANEL_DURATIONS.filter(d => {
    const del = db.getSetting(`harga_dur_deleted_${planKey}_${d.key}`);
    return del !== true; 
  });
  const explicitSet = notDeleted.filter(d => {
    const v = db.getSetting(`harga_${planKey}_${d.key}`);
    
    return v !== undefined && v !== null && v !== '';
  });
  
  return explicitSet.length > 0 ? explicitSet : notDeleted;
}

async function suspendPanelByUuid(uuid) {
  const servers = db.getAllServers();
  const found   = await findServerByUuid(servers, uuid);
  if (!found) return false;
  try { await ptero.suspendServer(found.srv, found.internalId); return true; } catch { return false; }
}

async function deletePanelByUuid(uuid) {
  const servers = db.getAllServers();
  const found   = await findServerByUuid(servers, uuid);
  if (!found) return false;
  try {
    const ax      = require('axios');
    const headers = { Accept:'application/json', Authorization:'Bearer '+found.srv.api_key };

    
    let pteroUserId = null;
    try {
      const { data: sd } = await ax.get(
        `${found.srv.domain}/api/application/servers/${found.internalId}`,
        { headers, timeout:15000 }
      );
      pteroUserId = sd?.attributes?.user || null;
    } catch {}

    
    await ax.delete(
      `${found.srv.domain}/api/application/servers/${found.internalId}`,
      { headers, timeout:15000 }
    );
    log.info(`deletePanelByUuid: server ${found.internalId} dihapus`);

    
    if (pteroUserId) {
      await new Promise(r => setTimeout(r, 2000));
      try {
        await ax.delete(
          `${found.srv.domain}/api/application/users/${pteroUserId}`,
          { headers, timeout:15000 }
        );
        log.info(`deletePanelByUuid: user ptero ${pteroUserId} dihapus`);
      } catch(ue) {
        log.warn(`deletePanelByUuid: gagal hapus user ptero ${pteroUserId}: ${ue.message}`);
      }
    }
    return true;
  } catch(e) {
    log.err(`deletePanelByUuid error ${uuid}: ${e.message}`);
    return false;
  }
}

function startPendingDeletionChecker() {
  setInterval(async () => {
    try {
      const now     = Date.now();
      const pending = db.getAllPendingDeletions();
      for (const pd of pending) {
        if (now < pd.delete_at) continue;
        log.warn(`Pending deletion triggered: ${pd.uuid}`);
        const deleted = await deletePanelByUuid(pd.uuid).catch(() => false);
        db.removePanelRecord(pd.uuid);
        db.removePendingDeletion(pd.uuid);
        try {
          await bot.sendMessage(pd.owner_id,
            `🗑️ <b>${B('PANEL DIHAPUS')}</b>\n\n`+
            `Panel <b>${escH(pd.server_name)}</b> telah dihapus secara permanen.\n`+
            `Panel disuspend lebih dari 3 hari tanpa perpanjangan.\n\n`+
            `Beli panel baru jika diperlukan.`,
            { parse_mode:'HTML', reply_markup:{ inline_keyboard:[[{ text:B('🛒 Beli Panel Baru'), callback_data:'MENU_PANEL' }]] } }
          );
        } catch {}
        try {
          await bot.sendMessage(config.OWNER_ID,
            `🗑️ <b>Panel Terhapus (Manual Suspend → 3 Hari)</b>\n\n`+
            `🆔 UUID: <code>${pd.uuid}</code>\n`+
            `🖥️ Server: ${escH(pd.server_name)}\n`+
            `👤 Owner ID: <code>${pd.owner_id}</code>\n`+
            `✅ Ptero: ${deleted ? 'Berhasil dihapus' : '⚠️ Gagal — cek manual'}`,
            { parse_mode:'HTML' }
          );
        } catch {}
        log.warn(`Panel manual-deleted: ${pd.uuid} ptero=${deleted}`);
      }
    } catch(e) { log.err('Pending deletion check error:', e.message); }
  }, 30 * 60 * 1000);
}

const _suspendTimers = new Map();
function scheduleExactSuspend(uuid, expiryMs) {
  
  if (_suspendTimers.has(uuid)) {
    clearTimeout(_suspendTimers.get(uuid));
    _suspendTimers.delete(uuid);
  }
  const delay = expiryMs - Date.now();
  if (delay <= 0) return;

  
  
  
  const MAX_SAFE = 20 * 24 * 60 * 60 * 1000; 
  if (delay > MAX_SAFE) {
    const t = setTimeout(() => {
      _suspendTimers.delete(uuid);
      
      const rec = db.getPanelByUuid(uuid);
      if (!rec || rec.suspended) return;
      
      scheduleExactSuspend(uuid, rec.expiry_ms);
    }, MAX_SAFE);
    _suspendTimers.set(uuid, t);
    return;
  }

  
  const t = setTimeout(async () => {
    _suspendTimers.delete(uuid);
    const rec = db.getPanelByUuid(uuid);
    if (!rec || rec.expiry_ms > Date.now()) return; 
    if (rec.suspended) return;
    const all = db.getAllPanelRecords();
    const pr  = all.find(x => x.uuid === uuid);
    if (pr && !pr.suspended) { pr.suspended = true; pr.suspended_at = Date.now(); db._setPanels(all); }
    await suspendPanelByUuid(uuid).catch(() => {});
    const planLabel = PANEL_PLANS.find(x => x.key === rec.plan_key)?.label || rec.plan_key;
    const ownerName = rec.owner_username ? `@${rec.owner_username}` : `ID:${rec.owner_id}`;
    try {
      await bot.sendMessage(rec.owner_id,
        `🔴 <b>${B('PANEL DISUSPEND')}</b>\n\n` +
        `Panel <b>${escH(rec.name)}</b> telah disuspend karena masa aktif habis!\n\n` +
        `⚠️ Perpanjang dalam <b>3 hari</b> atau panel akan <b>dihapus permanen</b>.`,
        { parse_mode:'HTML',
          reply_markup:{ inline_keyboard:[[{ text:B('⏰ Perpanjang Sekarang'), callback_data:`PANEL_EXTEND:${rec.uuid}:0` }]] }
        });
    } catch {}
    try {
      await bot.sendMessage(config.OWNER_ID,
        `🔴 <b>${B('AUTO SUSPEND (PRESISI)')}</b>\n\n` +
        `📛 Server: <b>${escH(rec.name)}</b>\n` +
        `👤 Pemilik: ${escH(ownerName)} (<code>${rec.owner_id}</code>)\n` +
        `📦 Plan: <b>${planLabel}</b>\n` +
        `🆔 UUID: <code>${uuid}</code>\n` +
        `📅 Masa aktif telah berakhir`,
        { parse_mode:'HTML' });
    } catch {}
    log.warn(`Panel exact-suspended: ${uuid} (owner:${rec.owner_id})`);
  }, delay);
  _suspendTimers.set(uuid, t);
}

function scheduleAllExistingSuspends() {
  const panels = db.getAllPanelRecords();
  const aktif  = panels.filter(p => !p.suspended && p.expiry_ms > Date.now());
  for (const p of aktif) scheduleExactSuspend(p.uuid, p.expiry_ms);
  log.info(`Scheduled exact suspend: ${aktif.length} panel aktif`);
}

function scheduleAutoBackup() {
  setInterval(async () => {
    try {
      const now    = new Date().toLocaleString('id-ID',{timeZone:'Asia/Jakarta'});
      const nowFmt = now.replace(/[/:]/g,'-').replace(/,/,'').replace(/ /g,'_');
      const zipBuf = await createBackupZip();
      const files  = db.getDbFiles();
      const caption =
        `🗄️ <b>Auto Backup</b>\n`+
        `🕐 ${now} WIB\n`+
        `📦 ${files.length} file | 💾 ${(zipBuf.length/1024).toFixed(1)} KB`;
      await bot.sendDocument(config.OWNER_ID, zipBuf,
        { caption, parse_mode:'HTML' },
        { filename:`auto-backup-${nowFmt}.zip`, contentType:'application/zip' }
      );
      log.info('Auto backup (ZIP) terkirim ke owner');
    } catch(e) { log.err('Auto backup gagal:', e.message); }
  }, 60 * 60 * 1000);

  
  const notifiedH1 = new Set();
  setInterval(async () => {
    try {
      const now    = Date.now();
      const panels = db.getAllPanelRecords();
      for (const p of panels) {
        const rem = p.expiry_ms - now;

        
        if (rem > 0 && rem <= 24*60*60*1000 && !notifiedH1.has(p.uuid)) {
          notifiedH1.add(p.uuid);
          const expStr    = new Date(p.expiry_ms).toLocaleString('id-ID',{timeZone:'Asia/Jakarta'});
          const planLabel = PANEL_PLANS.find(x=>x.key===p.plan_key)?.label || p.plan_key;
          const ownerName = p.owner_username ? `@${p.owner_username}` : `ID:${p.owner_id}`;
          
          try {
            await bot.sendMessage(p.owner_id,
              `⚠️ <b>${B('PERINGATAN MASA AKTIF')}</b>\n\n` +
              `Panel <b>${escH(p.name)}</b> akan berakhir dalam:\n` +
              `🕐 <b>${fmtDurasi(rem)}</b>\n` +
              `📅 Sampai: <b>${expStr} WIB</b>\n\n` +
              `Segera perpanjang agar panel tidak dimatikan!`,
              { parse_mode:'HTML',
                reply_markup:{ inline_keyboard:[[{ text:B('⏰ Perpanjang Sekarang'), callback_data:`PANEL_EXTEND:${p.uuid}:0` }]] }
              });
          } catch {}
          
          try {
            await bot.sendMessage(config.OWNER_ID,
              `⚠️ <b>${B('PANEL HAMPIR HABIS')}</b>\n\n` +
              `📛 Server: <b>${escH(p.name)}</b>\n` +
              `👤 Pemilik: ${escH(ownerName)} (<code>${p.owner_id}</code>)\n` +
              `📦 Plan: <b>${planLabel}</b>\n` +
              `🌐 Domain: <code>${escH(p.domain)}</code>\n` +
              `🕐 Sisa: <b>${fmtDurasi(rem)}</b>\n` +
              `📅 Habis: <b>${expStr} WIB</b>`,
              { parse_mode:'HTML' });
          } catch {}
        }
        if (rem > 24*60*60*1000) notifiedH1.delete(p.uuid);

        
        if (rem > 0 && p.suspended) {
          const allPanels = db.getAllPanelRecords();
          const pr = allPanels.find(x=>x.uuid===p.uuid);
          if (pr) { pr.suspended = false; pr.suspended_at = null; db._setPanels(allPanels); }
          const srv2 = db.getAllServers();
          const found2 = await findServerByUuid(srv2, p.uuid).catch(()=>null);
          if (found2) { try { await ptero.unsuspendServer(found2.srv, found2.internalId); } catch {} }
          continue;
        }

        
        if (rem <= 0 && !p.suspended) {
          const allPanels = db.getAllPanelRecords();
          const pr = allPanels.find(x=>x.uuid===p.uuid);
          if (pr && !pr.suspended) {
            pr.suspended = true;
            pr.suspended_at = now;
            db._setPanels(allPanels);
          }
          await suspendPanelByUuid(p.uuid).catch(()=>{});
          const planLabel = PANEL_PLANS.find(x=>x.key===p.plan_key)?.label || p.plan_key;
          const ownerName = p.owner_username ? `@${p.owner_username}` : `ID:${p.owner_id}`;
          
          try {
            await bot.sendMessage(p.owner_id,
              `🔴 <b>${B('PANEL DISUSPEND')}</b>\n\n` +
              `Panel <b>${escH(p.name)}</b> telah disuspend karena masa aktif habis!\n\n` +
              `⚠️ Perpanjang dalam <b>3 hari</b> atau panel akan <b>dihapus permanen</b>.`,
              { parse_mode:'HTML',
                reply_markup:{ inline_keyboard:[[{ text:B('⏰ Perpanjang Sekarang'), callback_data:`PANEL_EXTEND:${p.uuid}:0` }]] }
              });
          } catch {}
          
          try {
            await bot.sendMessage(config.OWNER_ID,
              `🔴 <b>${B('AUTO SUSPEND')}</b>\n\n` +
              `📛 Server: <b>${escH(p.name)}</b>\n` +
              `👤 Pemilik: ${escH(ownerName)} (<code>${p.owner_id}</code>)\n` +
              `📦 Plan: <b>${planLabel}</b>\n` +
              `🌐 Domain: <code>${escH(p.domain)}</code>\n` +
              `🆔 UUID: <code>${p.uuid}</code>\n` +
              `📅 Masa Aktif Habis: Masa aktif telah berakhir\n` +
              `⚠️ Akan dihapus dalam 3 hari jika tidak diperpanjang`,
              { parse_mode:'HTML' });
          } catch {}
          log.warn(`Panel auto-suspended: ${p.uuid} (owner:${p.owner_id})`);
        }

        
        if (p.suspended && p.suspended_at) {
          const daysSuspended = (now - p.suspended_at) / (24*60*60*1000);
          if (daysSuspended >= 3) {
            const deleted = await deletePanelByUuid(p.uuid).catch(()=>false);
            db.removePanelRecord(p.uuid);
            try {
              await bot.sendMessage(p.owner_id,
                `🗑️ <b>${B('PANEL DIHAPUS')}</b>\n\n` +
                `Panel <b>${escH(p.name)}</b> telah dihapus karena tidak diperpanjang dalam 3 hari setelah disuspend.\n\n` +
                `Beli panel baru jika diperlukan.`,
                { parse_mode:'HTML',
                  reply_markup:{ inline_keyboard:[[{ text:B('🛒 Beli Panel Baru'), callback_data:'MENU_PANEL' }]] }
                });
            } catch {}
            log.warn(`Panel auto-deleted: ${p.uuid} (owner:${p.owner_id}) ptero=${deleted}`);
          }
        }
      }
    } catch(e) { log.err('Expiry check gagal:', e.message); }
  }, 60 * 1000);
}

const BROADCAST_CONCURRENCY = 15;

async function doBroadcast(chatId, replyMsg, doPin = false) {
  const fromChatId = replyMsg.chat.id;
  const fromMsgId  = replyMsg.message_id;
  const users      = db.getAllUsers();
  let ok=0, fail=0, pinOk=0;

  const loadMsg = await bot.sendMessage(chatId,
    `⏳ Broadcast ke <b>${users.length}</b> user${doPin?' + pin':''}...`,
    { parse_mode:'HTML' });

  for (let i = 0; i < users.length; i += BROADCAST_CONCURRENCY) {
    const batch = users.slice(i, i + BROADCAST_CONCURRENCY);
    const results = await Promise.allSettled(
      batch.map(async u => {
        const sent = await bot.forwardMessage(u.id, fromChatId, fromMsgId);
        if (doPin) {
          try { await bot.pinChatMessage(u.id, sent.message_id); pinOk++; } catch {}
        }
        return sent;
      })
    );
    for (const r of results) {
      if (r.status === 'fulfilled') ok++;
      else fail++;
    }
    if (i + BROADCAST_CONCURRENCY < users.length)
      await new Promise(r => setTimeout(r, 200));
  }

  log.bcast(`Broadcast selesai: ${ok} berhasil, ${fail} gagal`);
  await bot.editMessageText(
    `✅ <b>Broadcast Selesai!</b>\n\n`+
    `✅ Terkirim : <b>${ok}</b>\n`+
    (doPin ? `📌 Dipin    : <b>${pinOk}</b>\n` : '')+
    `❌ Gagal    : <b>${fail}</b>\n`+
    `👥 Total    : <b>${users.length}</b>`,
    { chat_id: chatId, message_id: loadMsg.message_id, parse_mode:'HTML' }
  ).catch(()=>{});
}

bot.onText(/^\/bcs$/, async (msg) => {
  if (!isOwner(msg.from.id)) return;
  if (!msg.reply_to_message) {
    return bot.sendMessage(msg.chat.id,
      `❌ <b>Cara pakai:</b> Reply ke pesan yang ingin di-forward lalu kirim <code>/bcs</code>`,
      { parse_mode:'HTML' });
  }
  await doBroadcast(msg.chat.id, msg.reply_to_message, false);
});

bot.onText(/^\/bcsp$/, async (msg) => {
  if (!isOwner(msg.from.id)) return;
  if (!msg.reply_to_message) {
    return bot.sendMessage(msg.chat.id,
      `❌ <b>Cara pakai:</b> Reply ke pesan yang ingin di-forward + pin lalu kirim <code>/bcsp</code>`,
      { parse_mode:'HTML' });
  }
  await doBroadcast(msg.chat.id, msg.reply_to_message, true);
});

bot.on('polling_error', e => {
  log.err('Polling:', e.message);
  notifyOwnerError('polling_error', e).catch(()=>{});
});
bot.on('message', async (msg) => {
  if (!msg.photo) return;
  if (msg.date < Math.floor(Date.now()/1000)-30) return;
  const userId = msg.from.id, chatId = msg.chat.id;
  db.upsertUser(msg.from);
  const st = userStates.get(userId);
  if (st && st.state === 'WAITING_MANUAL_PROOF') {
    userStates.delete(userId);
    const { orderId, qrisMsgId } = st;
    const tx = db.getTx(orderId);
    if (!tx) {
      return bot.sendMessage(chatId, `❌ Transaksi tidak ditemukan.`, { parse_mode:'HTML' });
    }
    db.updateTx(orderId, { status:'pending_manual' });

    const photos = msg.photo;
    const fileId = photos[photos.length - 1].file_id;
    const fee    = parseInt(config.DEPOSIT_FEE) || 0;
    const sess   = activeSessions.get(userId);
    const amount = sess?.amount || tx.amount || 0;
    const total  = amount + fee;

    tryDel(chatId, msg.message_id).catch(()=>{});

    const waitText =
      `⏳ <b>${B('MENUNGGU KONFIRMASI')}</b>\n\n` +
      `🆔 Order: <code>${orderId}</code>\n` +
      `💰 Nominal: <b>Rp${fmt(amount)}</b>\n\n` +
      `✅ Bukti pembayaran sudah dikirim ke owner.\nMohon tunggu konfirmasi, biasanya beberapa menit.`;
    const waitKb = { inline_keyboard:[[{ text:B('🏠 Menu Utama'), callback_data:'MAIN_MENU' }]] };
    if (qrisMsgId) {
      try {
        await bot.editMessageCaption(waitText, { chat_id:chatId, message_id:qrisMsgId, parse_mode:'HTML', reply_markup:waitKb });
      } catch {
        try {
          await bot.editMessageText(waitText, { chat_id:chatId, message_id:qrisMsgId, parse_mode:'HTML', reply_markup:waitKb });
        } catch {
          await bot.sendMessage(chatId, waitText, { parse_mode:'HTML', reply_markup:waitKb });
        }
      }
    } else {
      await bot.sendMessage(chatId, waitText, { parse_mode:'HTML', reply_markup:waitKb });
    }
    const buyerUser = db.getUser(userId);
    const uname     = buyerUser?.username ? `@${buyerUser.username}` : (buyerUser?.first_name || `ID:${userId}`);
    const cap =
      `💳 <b>${B('BUKTI PEMBAYARAN MASUK')}</b>\n\n`+
      `👤 ${B('User')}: ${escH(uname)} (<code>${userId}</code>)\n`+
      `🆔 ${B('Order')}: <code>${orderId}</code>\n`+
      `💰 ${B('Nominal')}: <b>Rp${fmt(amount)}</b>\n`+
      (fee > 0 ? `💸 ${B('Admin Fee')}: <b>Rp${fmt(fee)}</b>\n`+
                 `💳 ${B('Total Bayar')}: <b>Rp${fmt(total)}</b>\n` : '')+
      `\nVerifikasi bukti pembayaran di bawah:`;
    const ownerKb = { inline_keyboard:[
      [{ text: B('✅ Valid — Kredit Saldo'),   callback_data:`MANUAL_VALID:${orderId}:${userId}` }],
      [{ text: B('❌ Tidak Valid — Tolak'),     callback_data:`MANUAL_INVALID:${orderId}:${userId}` }]
    ]};
    try {
      await bot.sendPhoto(config.OWNER_ID, fileId, { caption: cap, parse_mode:'HTML', reply_markup: ownerKb });
    } catch(e) {
      log.err('Kirim bukti ke owner gagal:', e.message);
    }
    return;
  }

  if (!csai.isInCsAi(userId)) return;
  await csai.handleCsAiPhoto(bot, msg);
});

process.on('uncaughtException', e => {
  log.err('Uncaught:', e.message);
  notifyOwnerError('uncaughtException', e).catch(()=>{});
});
process.on('unhandledRejection', e => {
  log.err('Unhandled:', e?.message||e);
  notifyOwnerError('unhandledRejection', e instanceof Error ? e : new Error(String(e))).catch(()=>{});
});

(async () => {

  process.stdout.write('\x1Bc');

  const me = await bot.getMe().catch(()=>({ username:'unknown', first_name:'Bot' }));
  const line  = `═`.repeat(52);
  const dt    = new Date().toLocaleString('id-ID',{timeZone:'Asia/Jakarta'});
  console.log(`\n${BOLD}${CYAN}${line}${RESET}`);
  console.log(`${BOLD}${CYAN}  ██████╗  ██████╗ ████████╗${RESET}`);
  console.log(`${BOLD}${CYAN}  ██╔══██╗██╔═══██╗╚══██╔══╝${RESET}`);
  console.log(`${BOLD}${CYAN}  ██████╔╝██║   ██║   ██║   ${RESET}`);
  console.log(`${BOLD}${CYAN}  ██╔══██╗██║   ██║   ██║   ${RESET}`);
  console.log(`${BOLD}${CYAN}  ██████╔╝╚██████╔╝   ██║   ${RESET}`);
  console.log(`${BOLD}${CYAN}  ╚═════╝  ╚═════╝    ╚═╝   ${RESET}`);
  console.log(`${BOLD}${WHITE}  Alex Store Bot — v2.1${RESET}`);
  console.log(`${BOLD}${CYAN}${line}${RESET}`);
  console.log(`${BOLD}${GREEN}  ✔ Bot     ${RESET}: @${me.username} (${me.first_name})`);
  console.log(`${BOLD}${GREEN}  ✔ Owner   ${RESET}: ${config.OWNER_ID}`);
  console.log(`${BOLD}${GREEN}  ✔ Channel ${RESET}: ${config.NOTIF_CHANNEL||'-'}`);
  console.log(`${BOLD}${GREEN}  ✔ Users   ${RESET}: ${db.getAllUsers().length}`);
  console.log(`${BOLD}${GREEN}  ✔ Stok    ${RESET}: ${db.countNokos()} nokos`);
  console.log(`${BOLD}${GREEN}  ✔ Gateway ${RESET}: ${db.getPaymentGateway()}`);
  console.log(`${BOLD}${GREEN}  ✔ Waktu   ${RESET}: ${dt} WIB`);
  console.log(`${BOLD}${CYAN}${line}${RESET}\n`);

  try {
    await bot.sendMessage(config.OWNER_ID,
      `🟢 <b>Bot Online!</b>\n\n`+
      `🤖 <b>@${me.username}</b>\n`+
      `🕐 ${dt} WIB\n`+
      `👥 Users: <b>${db.getAllUsers().length}</b>\n`+
      `📱 Stok: <b>${db.countNokos()}</b> nokos\n`+
      `💳 Gateway: <b>${db.getPaymentGateway()}</b>`,
      { parse_mode:'HTML' }
    );
  } catch {}

  try {
    await bot.setMyCommands(USER_COMMANDS);
  } catch(e) { log.warn('setMyCommands user gagal:', e.message); }

  try {
    await bot.setMyCommands(OWNER_COMMANDS, { scope: { type:'chat', chat_id: config.OWNER_ID } });
  } catch(e) { log.warn('setMyCommands owner gagal:', e.message); }

  (async () => {
    const users = db.getAllUsers().filter(u => Number(u.id) !== Number(config.OWNER_ID));
    let okCnt = 0, failCnt = 0;
    for (let i = 0; i < users.length; i += 20) {
      const batch = users.slice(i, i + 20);
      await Promise.allSettled(
        batch.map(u =>
          bot.setMyCommands(USER_COMMANDS, { scope: { type: 'chat', chat_id: u.id } })
            .then(() => okCnt++)
            .catch(() => failCnt++)
        )
      );
      if (i + 20 < users.length) await new Promise(r => setTimeout(r, 500));
    }
    log.ok(`Update commands selesai: ${okCnt} berhasil, ${failCnt} gagal`);
  })().catch(e => log.warn('Update commands user lama error:', e.message));

  scheduleAutoBackup();
scheduleAllExistingSuspends();
startPendingDeletionChecker();
  log.info('Auto backup dijadwalkan setiap 1 jam');

  (async () => {
    try {
      const now    = new Date().toLocaleString('id-ID',{timeZone:'Asia/Jakarta'});
      const nowFmt = now.replace(/[\/\:]/g,'-').replace(/,/,'').replace(/ /g,'_');
      const zipBuf = await createBackupZip();
      const files  = db.getDbFiles();
      await bot.sendDocument(config.OWNER_ID, zipBuf,
        { caption: `🗄️ <b>Startup Backup</b>\n🕐 ${now} WIB\n📦 ${files.length} file | 💾 ${(zipBuf.length/1024).toFixed(1)} KB`, parse_mode:'HTML' },
        { filename: `startup-backup-${nowFmt}.zip`, contentType:'application/zip' }
      );
      log.ok('Startup backup terkirim ke owner');
    } catch(e) { log.warn('Startup backup gagal:', e.message); }
  })();
})();
;(function() {
  const _file = require.resolve(__filename);
  fs.watchFile(_file, { interval: 1000 }, () => {
    console.log('\x1b[33m⚠️  auto.js berubah - restart diperlukan untuk menerapkan perubahan.\x1b[0m');
    console.log('\x1b[33m   Jalankan: pm2 restart all  atau  node auto.js\x1b[0m');
    console.log('\x1b[36mℹ️  File pendukung (config/db/ptero/payment/receipt) hot reload otomatis.\x1b[0m');
  });
})();
