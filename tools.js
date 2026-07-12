'use strict';
const fs     = require('fs');
const path   = require('path');
const https  = require('https');
const axios  = require('axios');
const crypto = require('crypto');
const config = require('./config');

const TOOLS_LIST = [
  { id: 'igdl',    emoji: '📸', label: 'Instagram DL' },
  { id: 'ytdl',    emoji: '▶️',  label: 'YouTube DL'   },
  { id: 'tiktok',  emoji: '🎵', label: 'TikTok DL'    },
  { id: 'tourl',   emoji: '🌐', label: 'To URL'        },
  { id: 'hd',      emoji: '🖼️', label: 'HD Foto'       },
  { id: 'spotify', emoji: '🎧', label: 'Spotify Play'  },
];

const TOOLS_PER_PAGE = 4; 

function buildToolsKeyboard(page = 0) {
  const totalPages = Math.ceil(TOOLS_LIST.length / TOOLS_PER_PAGE);
  const start      = page * TOOLS_PER_PAGE;
  const items      = TOOLS_LIST.slice(start, start + TOOLS_PER_PAGE);

  const rows = [];
  for (let i = 0; i < items.length; i += 2) {
    const row = [];
    if (items[i])   row.push({ text: `${items[i].emoji} ${items[i].label}`,   callback_data: `TOOL_USE:${items[i].id}` });
    if (items[i+1]) row.push({ text: `${items[i+1].emoji} ${items[i+1].label}`, callback_data: `TOOL_USE:${items[i+1].id}` });
    rows.push(row);
  }

  const nav = [];
  if (page > 0)             nav.push({ text: '◀️ Prev', callback_data: `TOOLS_PAGE:${page - 1}` });
  if (page < totalPages - 1) nav.push({ text: 'Next ▶️', callback_data: `TOOLS_PAGE:${page + 1}` });
  if (nav.length) rows.push(nav);

  rows.push([{ text: '⬅️ Kembali', callback_data: 'MAIN_MENU' }]);

  return { inline_keyboard: rows };
}

async function sendToolsMenu(bot, chatId, from, page = 0, delMsgId = null) {
  const totalPages = Math.ceil(TOOLS_LIST.length / TOOLS_PER_PAGE);
  const text =
    `🛠️ <b>TOOLS</b>\n\n` +
    `Pilih fitur yang ingin kamu gunakan:\n\n` +
    `📸 <b>Instagram DL</b> — Unduh foto/video/reels IG\n` +
    `▶️ <b>YouTube DL</b> — Unduh video atau audio YT\n` +
    `🎵 <b>TikTok DL</b> — Unduh video/slide tanpa watermark\n` +
    `🌐 <b>To URL</b> — Upload file → dapatkan URL\n` +
    `🖼️ <b>HD Foto</b> — Upscale/perbesar kualitas foto\n` +
    `🎧 <b>Spotify Play</b> — Cari &amp; download lagu Spotify\n\n` +
    `📄 Halaman ${page + 1}/${totalPages}`;

  const kb   = buildToolsKeyboard(page);
  const opts = { parse_mode: 'HTML', reply_markup: kb };

  if (delMsgId) {
    try {
      return await bot.editMessageText(text, { chat_id: chatId, message_id: delMsgId, ...opts });
    } catch {  }
  }
  return bot.sendMessage(chatId, text, opts);
}

const TOOL_PROMPTS = {
  igdl:    `📸 <b>Instagram Downloader</b>\n\nKirim link Instagram (foto/video/reels/carousel):\nContoh: <code>https://www.instagram.com/reel/xxx</code>\n\nKetik /cancel untuk batal.`,
  ytdl:    `▶️ <b>YouTube Downloader</b>\n\nKirim link YouTube lalu pilih format:\nContoh: <code>https://www.youtube.com/watch?v=xxx</code>\n\nKetik /cancel untuk batal.`,
  tiktok:  `🎵 <b>TikTok Downloader</b>\n\nKirim link TikTok (video atau photo slide):\nContoh: <code>https://vt.tiktok.com/xxx</code>\n\nKetik /cancel untuk batal.`,
  tourl:   `🌐 <b>To URL</b>\n\nReply foto/video/file dengan perintah ini, atau kirim file sekarang:\n\nKetik /cancel untuk batal.`,
  hd:      `🖼️ <b>HD Foto (Upscale)</b>\n\nReply foto yang mau di-HD-kan, atau kirim foto sekarang:\n\nKetik /cancel untuk batal.`,
  spotify: `🎧 <b>Spotify Play</b>\n\nKirim judul lagu atau link Spotify:\nContoh: <code>ngapain repot ajeng febria</code>\nAtau: <code>https://open.spotify.com/track/xxx</code>\n\nKetik /cancel untuk batal.`,
};

const toolStates   = new Map(); 
const uploadCache  = new Map(); 

function getToolState(userId)          { return toolStates.get(userId); }
function setToolState(userId, state)   { toolStates.set(userId, state); }
function clearToolState(userId)        { toolStates.delete(userId); uploadCache.delete(userId); }
function isInToolState(userId)         { return toolStates.has(userId); }

async function sendToolPrompt(bot, chatId, userId, toolId, delMsgId = null) {
  const text = TOOL_PROMPTS[toolId];
  if (!text) return;

  const kb   = { inline_keyboard: [[{ text: '❌ Batal', callback_data: 'TOOLS_MENU' }]] };
  const opts = { parse_mode: 'HTML', reply_markup: kb };

  let sentMsg;
  if (delMsgId) {
    try {
      sentMsg = await bot.editMessageText(text, { chat_id: chatId, message_id: delMsgId, ...opts });
    } catch { sentMsg = await bot.sendMessage(chatId, text, opts); }
  } else {
    sentMsg = await bot.sendMessage(chatId, text, opts);
  }

  setToolState(userId, { tool: toolId, promptMsgId: sentMsg?.message_id });
}

async function handleIgDl(bot, chatId, url) {
  const wait = await bot.sendMessage(chatId, '⏳ <i>Mengunduh dari Instagram...</i>', { parse_mode: 'HTML' });
  try {
    const { data } = await axios.post(
      'https://thesocialcat.com/api/instagram-download',
      { url },
      {
        headers: {
          'accept': '*/*', 'accept-language': 'id-ID',
          'content-type': 'application/json',
          'Referer': 'https://thesocialcat.com/tools/instagram-video-downloader',
          'Referrer-Policy': 'strict-origin-when-cross-origin',
        },
        timeout: 30000,
      }
    );

    await bot.deleteMessage(chatId, wait.message_id).catch(() => {});

    if (!data) throw new Error('Respons kosong dari API');

    const caption =
      `📸 <b>Instagram Downloader</b>\n\n` +
      `👤 <b>Username:</b> ${data.username || '-'}\n` +
      `📝 <b>Caption:</b> ${(data.caption || '-').slice(0, 200)}`;

    if (data.type === 'video' && data.url) {
      await bot.sendVideo(chatId, data.url, { caption, parse_mode: 'HTML' });
    } else if (data.type === 'image' && data.url) {
      await bot.sendPhoto(chatId, data.url, { caption, parse_mode: 'HTML' });
    } else if (data.carouselItems && data.carouselItems.length > 0) {
      await bot.sendMessage(chatId, caption, { parse_mode: 'HTML' });
      const mediaGroup = data.carouselItems.slice(0, 10).map(item => ({
        type: item.type === 'video' ? 'video' : 'photo',
        media: item.url,
      }));
      await bot.sendMediaGroup(chatId, mediaGroup);
    } else {
      throw new Error('Format konten tidak dikenali');
    }
  } catch (e) {
    await bot.deleteMessage(chatId, wait.message_id).catch(() => {});
    await bot.sendMessage(chatId, `❌ <b>Gagal unduh Instagram:</b>\n<code>${escH(e.message)}</code>`, { parse_mode: 'HTML' });
  }
}

const BASE_YT_URL = 'https://youtubedl.siputzx.my.id';

function solvePow(challenge, difficulty) {
  let nonce  = 0;
  const pref = '0'.repeat(difficulty);
  while (true) {
    const hash = crypto.createHash('sha256').update(challenge + nonce.toString()).digest('hex');
    if (hash.startsWith(pref)) return nonce.toString();
    nonce++;
  }
}

async function ytDownloadUrl(url, type) {
  const { wrapper }   = require('axios-cookiejar-support');
  const { CookieJar } = require('tough-cookie');
  const jar    = new CookieJar();
  const client = wrapper(axios.create({ jar, withCredentials: true }));

  const { data: { challenge, difficulty } } = await client.post(`${BASE_YT_URL}/akumaudownload`, { url, type });
  const nonce = solvePow(challenge, difficulty);
  await client.post(`${BASE_YT_URL}/cekpunyaku`, { url, type, nonce });

  for (let i = 0; i < 30; i++) {
    const { data } = await client.get(`${BASE_YT_URL}/download`, { params: { url, type } });
    if (data.status === 'completed') {
      const p = typeof data.fileUrl === 'string' ? data.fileUrl : data.file_url;
      return BASE_YT_URL + p;
    }
    if (data.status === 'failed') throw new Error(data.error || 'Download failed');
    await new Promise(r => setTimeout(r, 3000));
  }
  throw new Error('Timeout menunggu download');
}

async function handleYtDl(bot, chatId, url, msgId) {
  const kb = {
    inline_keyboard: [
      [
        { text: '🎬 Video (MP4)', callback_data: `YT_FORMAT:video:${url}` },
        { text: '🎵 Audio (MP3)', callback_data: `YT_FORMAT:audio:${url}` },
      ],
      [{ text: '❌ Batal', callback_data: 'TOOLS_MENU' }],
    ],
  };
  if (msgId) {
    try {
      await bot.editMessageText(
        `▶️ <b>YouTube Downloader</b>\n\nLink: <code>${escH(url)}</code>\n\nPilih format:`,
        { chat_id: chatId, message_id: msgId, parse_mode: 'HTML', reply_markup: kb }
      );
      return;
    } catch {}
  }
  await bot.sendMessage(
    chatId,
    `▶️ <b>YouTube Downloader</b>\n\nLink: <code>${escH(url)}</code>\n\nPilih format:`,
    { parse_mode: 'HTML', reply_markup: kb }
  );
}

async function processYtDownload(bot, chatId, type, url) {
  const wait = await bot.sendMessage(chatId, `⏳ <i>Mengunduh ${type === 'video' ? 'video' : 'audio'} dari YouTube...</i>`, { parse_mode: 'HTML' });
  try {
    const dlUrl = await ytDownloadUrl(url, type);
    await bot.deleteMessage(chatId, wait.message_id).catch(() => {});
    if (type === 'video') {
      await bot.sendVideo(chatId, dlUrl, { caption: `▶️ <b>YouTube Video</b>\n🔗 ${escH(url)}`, parse_mode: 'HTML' });
    } else {
      await bot.sendAudio(chatId, dlUrl, { caption: `🎵 <b>YouTube Audio</b>\n🔗 ${escH(url)}`, parse_mode: 'HTML' });
    }
  } catch (e) {
    await bot.deleteMessage(chatId, wait.message_id).catch(() => {});
    await bot.sendMessage(chatId, `❌ <b>Gagal unduh YouTube:</b>\n<code>${escH(e.message)}</code>`, { parse_mode: 'HTML' });
  }
}

async function tiktokFetch(url) {
  const res = await fetch('https://lovetik.com/api/ajax/search', {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded; charset=UTF-8',
      'origin': 'https://lovetik.com', 'referer': 'https://lovetik.com/id',
      'user-agent': 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Mobile Safari/537.36',
      'x-requested-with': 'XMLHttpRequest',
    },
    body: `query=${encodeURIComponent(url)}`,
  });
  const data = await res.json();
  const isSlide   = Array.isArray(data.images) && data.images.length > 0;
  const cleanText = str => str.replace(/<[^>]+>/g, '').replace(/[^\w\s]/g, '').trim();
  const audio     = data.links.find(l => l.ft == 3 && l.a);
  const downloads = data.links
    .filter(l => l.ft != 3 && l.a)
    .map(l => ({ quality: l.s.replace(/\[.*?\]/g, '').trim() || cleanText(l.t), url: l.a }));
  return {
    type: isSlide ? 'slide' : 'video',
    desc: data.desc, author: { username: data.author, name: data.author_name },
    cover: data.cover,
    ...(isSlide ? { images: data.images } : { downloads }),
    audio: audio ? audio.a : null,
  };
}

async function handleTiktok(bot, chatId, url) {
  const wait = await bot.sendMessage(chatId, '⏳ <i>Mengunduh dari TikTok...</i>', { parse_mode: 'HTML' });
  try {
    const result = await tiktokFetch(url);
    await bot.deleteMessage(chatId, wait.message_id).catch(() => {});

    const caption =
      `🎵 <b>TikTok Downloader</b>\n\n` +
      `👤 <b>Author:</b> ${escH(result.author.name || result.author.username)}\n` +
      `📝 <b>Desc:</b> ${(result.desc || '-').slice(0, 150)}`;

    if (result.type === 'slide' && result.images?.length > 0) {
      await bot.sendMessage(chatId, caption, { parse_mode: 'HTML' });
      const mediaGroup = result.images.slice(0, 10).map(imgUrl => ({ type: 'photo', media: imgUrl }));
      await bot.sendMediaGroup(chatId, mediaGroup);
      if (result.audio) {
        await bot.sendAudio(chatId, result.audio, { caption: '🎵 Audio Slide', parse_mode: 'HTML' });
      }
    } else if (result.type === 'video' && result.downloads?.length > 0) {
      const best = result.downloads[0];
      await bot.sendVideo(chatId, best.url, { caption: `${caption}\n📦 Kualitas: ${escH(best.quality)}`, parse_mode: 'HTML' });
    } else {
      throw new Error('Tidak ada media yang ditemukan');
    }
  } catch (e) {
    await bot.deleteMessage(chatId, wait.message_id).catch(() => {});
    await bot.sendMessage(chatId, `❌ <b>Gagal unduh TikTok:</b>\n<code>${escH(e.message)}</code>`, { parse_mode: 'HTML' });
  }
}

async function handleToUrl(bot, chatId, userId, msg) {
  const target = msg.reply_to_message || msg;
  const fileId  = target.photo
    ? target.photo[target.photo.length - 1].file_id
    : (target.video?.file_id || target.document?.file_id || target.audio?.file_id);

  if (!fileId) {
    await bot.sendMessage(chatId, '❌ Kirim atau reply foto/video/file untuk diupload ke URL.', { parse_mode: 'HTML' });
    return;
  }

  uploadCache.set(userId, fileId);

  const kb = {
    inline_keyboard: [
      [
        { text: '📦 Catbox', callback_data: 'TOURL_HOST:catbox' },
        { text: '💧 Uguu',   callback_data: 'TOURL_HOST:uguu'   },
      ],
      [{ text: '🚀 Ikyy CDN', callback_data: 'TOURL_HOST:cdn' }],
      [{ text: '❌ Batal',    callback_data: 'TOOLS_MENU' }],
    ],
  };
  await bot.sendMessage(chatId, '🌐 <b>Pilih Host Upload:</b>', { parse_mode: 'HTML', reply_markup: kb });
}

async function processToUrl(bot, chatId, userId, host, cbId, answerCb) {
  const fileId = uploadCache.get(userId);
  if (!fileId) {
    await answerCb(cbId, '❌ Sesi kadaluarsa!', true);
    return;
  }
  await answerCb(cbId, `Mengunggah ke ${host}...`);

  const wait = await bot.sendMessage(chatId, `⏳ <b>Memproses file untuk ${host.toUpperCase()}...</b>`, { parse_mode: 'HTML' });
  try {
    const fileLink   = await bot.getFileLink(fileId);
    const FormData   = require('form-data');
    const resFile    = await axios.get(fileLink, { responseType: 'stream' });
    const fileName   = fileLink.split('/').pop();
    const form       = new FormData();
    form.append('file', resFile.data, fileName);

    const { data } = await axios.post(
      `https://ikyyzyyrestapi.my.id/uploads?host=${host}`,
      form,
      { headers: { ...form.getHeaders() }, timeout: 60000 }
    );

    await bot.deleteMessage(chatId, wait.message_id).catch(() => {});
    uploadCache.delete(userId);

    if (data.status) {
      let finalUrl = '';
      if (host === 'catbox') finalUrl = data.result;
      else if (host === 'uguu') finalUrl = data.result?.files?.[0]?.url;
      else if (host === 'cdn') finalUrl = data.result?.url;

      const kb = { inline_keyboard: [[{ text: '🔗 Buka Link', url: finalUrl }], [{ text: '🛠️ Tools Lain', callback_data: 'TOOLS_MENU' }]] };
      await bot.sendMessage(chatId,
        `✅ <b>Berhasil Diupload!</b>\n\n🌐 <b>Host:</b> ${host.toUpperCase()}\n🔗 <b>URL:</b>\n<code>${finalUrl}</code>`,
        { parse_mode: 'HTML', reply_markup: kb }
      );
    } else {
      throw new Error(data.error || 'API gagal');
    }
  } catch (e) {
    await bot.deleteMessage(chatId, wait.message_id).catch(() => {});
    await bot.sendMessage(chatId, `❌ <b>Gagal upload:</b>\n<code>${escH(e.message)}</code>`, { parse_mode: 'HTML' });
  }
}

async function handleHdFoto(bot, chatId, msg) {
  const target = msg.reply_to_message || msg;
  if (!target.photo) {
    await bot.sendMessage(chatId, '❌ Kirim atau reply foto yang mau di-HD-kan.', { parse_mode: 'HTML' });
    return;
  }

  const wait = await bot.sendMessage(chatId, '⏳ <i>Memproses upscale foto...</i>', { parse_mode: 'HTML' });
  try {
    const photo    = target.photo[target.photo.length - 1];
    const fileLink = await bot.getFileLink(photo.file_id);
    const apiUrl   = `https://ikyyzyyrestapi.my.id/tools/upscale?url=${encodeURIComponent(fileLink)}`;
    const res      = await axios.get(apiUrl, { timeout: 60000 });

    await bot.deleteMessage(chatId, wait.message_id).catch(() => {});

    if (res.data.status && res.data.result) {
      const hdImage = res.data.result.image;
      const size    = res.data.result.size;
      await bot.sendPhoto(chatId, hdImage, {
        caption: `✅ <b>Berhasil di-Upscale!</b>\n📦 <b>Size:</b> ${size}`,
        parse_mode: 'HTML',
      });
    } else {
      throw new Error('Gagal memproses gambar');
    }
  } catch (e) {
    await bot.deleteMessage(chatId, wait.message_id).catch(() => {});
    await bot.sendMessage(chatId, `❌ <b>Gagal upscale foto:</b>\n<code>${escH(e.message)}</code>`, { parse_mode: 'HTML' });
  }
}

async function handleSpotify(bot, chatId, input) {
  const wait = await bot.sendMessage(chatId, '🔍 <i>Sedang memproses Spotify...</i>', { parse_mode: 'HTML' });
  try {
    const res = await axios.get('https://ikyyzyyrestapi.my.id/search/spotifyplay', {
      params: { query: input }, timeout: 30000,
    });

    if (!res.data.status) throw new Error('Lagu tidak ditemukan');

    const r = res.data.result;
    const caption =
      `🎧 <b>Spotify Player</b>\n\n` +
      `📌 <b>Title:</b> ${escH(r.title)}\n` +
      `👤 <b>Artist:</b> ${escH(r.artist)}\n` +
      `💿 <b>Album:</b> ${escH(r.album)}\n` +
      `⏱ <b>Duration:</b> ${escH(r.duration)}\n\n` +
      `🔗 <a href="${r.url}">Buka di Spotify</a>`;

    await bot.deleteMessage(chatId, wait.message_id).catch(() => {});
    await bot.sendPhoto(chatId, r.thumbnail, { caption, parse_mode: 'HTML' });

    const audioBuf = await axios.get(r.download, {
      responseType: 'arraybuffer',
      headers: { 'User-Agent': 'Mozilla/5.0' },
      timeout: 60000,
    });

    if (audioBuf.data.byteLength > 50 * 1024 * 1024) {
      await bot.sendMessage(chatId, '⚠️ File terlalu besar, coba lagu lain!', { parse_mode: 'HTML' });
      return;
    }

    await bot.sendAudio(
      chatId,
      { source: Buffer.from(audioBuf.data), filename: `${r.title}.mp3` },
      { title: r.title, performer: r.artist }
    );
  } catch (e) {
    await bot.deleteMessage(chatId, wait.message_id).catch(() => {});
    await bot.sendMessage(chatId, `❌ <b>Gagal Spotify:</b>\n<code>${escH(e.message)}</code>`, { parse_mode: 'HTML' });
  }
}

async function handleToolText(bot, chatId, userId, text, msg) {
  const st = getToolState(userId);
  if (!st) return false;

  const { tool, promptMsgId } = st;
  clearToolState(userId);
  if (promptMsgId) await bot.deleteMessage(chatId, promptMsgId).catch(() => {});

  switch (tool) {
    case 'igdl':    await handleIgDl(bot, chatId, text.trim());   break;
    case 'ytdl':    await handleYtDl(bot, chatId, text.trim());   break;
    case 'tiktok':  await handleTiktok(bot, chatId, text.trim()); break;
    case 'spotify': await handleSpotify(bot, chatId, text.trim()); break;
    case 'tourl':   await handleToUrl(bot, chatId, userId, msg);  break;
    case 'hd':      await handleHdFoto(bot, chatId, msg);         break;
    default: break;
  }
  return true;
}

async function handleToolPhoto(bot, chatId, userId, msg) {
  const st = getToolState(userId);
  if (!st) return false;

  const { tool, promptMsgId } = st;
  clearToolState(userId);
  if (promptMsgId) await bot.deleteMessage(chatId, promptMsgId).catch(() => {});

  if (tool === 'hd') {
    await handleHdFoto(bot, chatId, msg);
    return true;
  }
  if (tool === 'tourl') {
    await handleToUrl(bot, chatId, userId, msg);
    return true;
  }
  return false;
}

function escH(s) { return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

class GeminiClient {
  constructor() { this._s = null; this._req = 1; this._cookies = ''; }

  async _init() {
    const res = await fetch('https://gemini.google.com/', {
      headers: {
        'user-agent'     : 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Mobile Safari/537.36',
        'accept-language': 'id-ID,id;q=0.9,en-US;q=0.8',
        'accept'         : 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      },
    });
    const setCookie = res.headers.get('set-cookie') || '';
    this._cookies   = setCookie.split(',').map(c => c.split(';')[0]).join('; ');
    const h         = await res.text();
    this._s = {
      a: h.match(/"SNlM0e":"(.*?)"/)?.[1] || '',
      b: h.match(/"cfb2h":"(.*?)"/)?.[1]  || '',
      c: h.match(/"FdrFJe":"(.*?)"/)?.[1] || '',
    };
  }

  async ask(message, systemPrompt) {
    if (!this._s) await this._init();
    const p = [
      null,
      JSON.stringify([
        [message, 0, null, null, null, null, 0], ['id'],
        ['', '', '', null, null, null, null, null, null, ''],
        null, null, null, [1], 1, null, null, 1, 0, null, null, null, null, null, [[0]], 1,
        null, null, null, null, null,
        ['', '', systemPrompt, null, null, null, null, null, 0, null, 1, null, null, null, []],
        null, null, 1, null, null, null, null, null, null, null,
        [1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20],
        1, null, null, null, null, [1],
      ]),
    ];
    const q   = `bl=${this._s.b}&f.sid=${this._s.c}&hl=id&_reqid=${this._req++}&rt=c`;
    const res = await fetch(
      `https://gemini.google.com/_/BardChatUi/data/assistant.lamda.BardFrontendService/StreamGenerate?${q}`,
      {
        method : 'POST',
        headers: {
          'content-type'   : 'application/x-www-form-urlencoded;charset=UTF-8',
          'user-agent'     : 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Mobile Safari/537.36',
          'x-same-domain'  : '1', 'accept-language': 'id-ID,id;q=0.9', 'cookie': this._cookies,
        },
        body: `f.req=${encodeURIComponent(JSON.stringify(p))}&at=${this._s.a}`,
      }
    );
    const t     = await res.text();
    const texts = [];
    for (const ln of t.split('\n')) {
      if (ln.startsWith('[["wrb.fr"')) {
        try {
          const d = JSON.parse(JSON.parse(ln)[0][2]);
          if (d[4] && Array.isArray(d[4])) {
            for (const item of d[4]) {
              if (item && Array.isArray(item) && item[1] && Array.isArray(item[1])) {
                const chunk = item[1][0];
                if (chunk && typeof chunk === 'string') texts.push(chunk);
              }
            }
          }
        } catch {}
      }
    }
    if (!texts.length) return null;
    return texts[texts.length - 1].replace(/\\n/g, '\n');
  }

  reset() { this._s = null; this._cookies = ''; this._req = 1; }
}

let _tesseractWorker = null;
async function getTesseractWorker() {
  if (_tesseractWorker) return _tesseractWorker;
  const { createWorker } = require('tesseract.js');
  _tesseractWorker = await createWorker(['eng', 'ind'], 1, { logger: () => {}, errorHandler: () => {} });
  return _tesseractWorker;
}
async function ocrImage(filePath) {
  try {
    const worker             = await getTesseractWorker();
    const { data: { text } } = await worker.recognize(filePath);
    const clean              = text.trim();
    return clean.length > 5 ? clean : null;
  } catch { return null; }
}

async function downloadTelegramFile(bot, fileId) {
  try {
    const fileInfo = await bot.getFile(fileId);
    const fileUrl  = `https://api.telegram.org/file/bot${config.BOT_TOKEN}/${fileInfo.file_path}`;
    const tmpPath  = path.join('/tmp', `csai_${Date.now()}_${fileId.slice(-8)}.jpg`);
    await new Promise((resolve, reject) => {
      const file = fs.createWriteStream(tmpPath);
      https.get(fileUrl, res => {
        res.pipe(file);
        file.on('finish', () => { file.close(); resolve(); });
        file.on('error', reject);
      }).on('error', reject);
    });
    return tmpPath;
  } catch { return null; }
}

const SENSITIVE_PATTERNS = [
  /server\.json/i, /db\.json/i, /\bdatabase\b/i, /source\s?code/i,
  /\bconfig\.js\b/i, /bot_token/i, /\bapi.?key\b/i, /\bpassword\b/i,
  /token\s*(bot|secret)/i, /tampilkan.*\.(js|json)/i,
  /perlihatkan.*(database|db|server|kode|script)/i,
  /lihat.*(database|db|server|kode|script|file)/i,
  /isi.*(database|server\.json|db\.json)/i, /struktur.*bot/i,
  /cara.*kerja.*bot.*dalam/i, /\bhack\b/i, /\bexploit\b/i,
  /\bbypass\b/i, /\binject\b/i, /\bsqlmap\b/i, /credentials?/i, /private.?key/i,
];
function isSensitiveQuery(text)  { return SENSITIVE_PATTERNS.some(p => p.test(text)); }
function getSensitiveReply() {
  return (
    `🚫 <b>Akses Ditolak</b>\n\nMaaf kak, aku tidak bisa menjawab pertanyaan yang berkaitan dengan:\n` +
    `• 🗄️ Isi database atau file server\n• 📁 Source code / script bot\n` +
    `• 🔑 Token, API key, atau kredensial\n• ⚙️ Struktur sistem internal bot\n\n` +
    `Ini demi keamanan sistem dan privasi semua pengguna. 🔒\n\n` +
    `Kalau ada pertanyaan lain tentang layanan, produk, atau kendala teknis, aku tetap siap bantu! 😊`
  );
}

function formatForTelegram(text) {
  if (!text) return '';
  let r = text;
  r = r.replace(/&(?!amp;|lt;|gt;|quot;|#\d+;)/g, '&amp;');
  r = r.replace(/```[\w]*\n?([\s\S]*?)```/g, (_, c) => `<pre>${c.replace(/<\/pre>/g, '')}<\/pre>`);
  r = r.replace(/`([^`\n]+)`/g, '<code>$1<\/code>');
  r = r.replace(/\*\*(.+?)\*\*/gs, '<b>$1<\/b>');
  r = r.replace(/__(.+?)__/gs, '<b>$1<\/b>');
  r = r.replace(/(?<!\*)\*(?!\*)((?:[^*\n])+?)\*(?!\*)/g, '<i>$1<\/i>');
  r = r.replace(/(?<!_)_(?!_)((?:[^_\n])+?)_(?!_)/g, '<i>$1<\/i>');
  r = r.replace(/^#{1,3}\s+(.+)$/gm, '<b>$1<\/b>');
  r = r.replace(/^[\-\*]\s+/gm, '• ');
  r = r.replace(/^>\s+/gm, '📌 ');
  r = r.replace(/\n{3,}/g, '\n\n');
  return r.trim();
}

function buildSystemPrompt() {
  const h   = config.HARGA || {};
  const fmt = n => Number(n || 0).toLocaleString('id-ID');
  const now = new Date().toLocaleString('id-ID', { timeZone: 'Asia/Jakarta', dateStyle: 'full', timeStyle: 'short' });
  return `Kamu adalah CS AI dari Alex Store Bot — asisten customer service cerdas, ramah, dan terpercaya. Namamu adalah "CS AI Alex".

Waktu sekarang: ${now} WIB

━━━━━━━━━━━━━━━━━━━━━━
IDENTITAS BOT
━━━━━━━━━━━━━━━━━━━━━━
Nama Bot    : Alex Store Bot
Username    : @AutoOrderByAlex_Bot
Owner       : ${config.OWNER_USERNAME || '@AlexSTR10'}
Platform    : Telegram Bot (Node.js)
Fungsi      : Toko otomatis — jual panel hosting Pterodactyl, akun Telegram (Nokos), script, reseller

━━━━━━━━━━━━━━━━━━━━━━
HARGA PRODUK RESMI
━━━━━━━━━━━━━━━━━━━━━━
Script          : ${h.script === 0 ? 'GRATIS' : `Rp${fmt(h.script)}`}
Reseller        : Rp${fmt(h.reseller)}
Admin Panel     : Rp${fmt(h.admin)}
Panel 1GB–10GB  : Rp${fmt(h.panel_1gb)} – Rp${fmt(h.panel_10gb)}
Panel Unlimited : Rp${fmt(h.panel_unli)}
Deposit min/max : Rp${fmt(config.MIN_DEPOSIT)} / Rp${fmt(config.MAX_DEPOSIT)}
Biaya admin dep : Rp${fmt(config.DEPOSIT_FEE)} (per transaksi)

━━━━━━━━━━━━━━━━━━━━━━
ATURAN FORMAT OUTPUT
━━━━━━━━━━━━━━━━━━━━━━
PENTING SEKALI — output dalam format Telegram HTML:
- Gunakan <b>teks</b> untuk BOLD — JANGAN pakai **teks**
- Gunakan <i>teks</i> untuk italic
- Gunakan <code>teks</code> untuk kode atau perintah
- Gunakan <pre>kode panjang</pre> untuk blok kode
- Jawab singkat, jelas, maksimal 3-5 paragraf
- Bahasa Indonesia yang santai tapi profesional
- Jika tidak tahu → arahkan ke owner: ${config.OWNER_USERNAME || '@AlexSTR10'}`;
}

const csAiSessions = new Map();
const gemini       = new GeminiClient();

function isInCsAi(userId)  { return csAiSessions.get(userId)?.active === true; }
function enterCsAi(userId) { csAiSessions.set(userId, { active: true }); }
function exitCsAi(userId)  { csAiSessions.delete(userId); }

const EXIT_KEYBOARD = {
  inline_keyboard: [[{ text: '❌ Keluar CS AI', callback_data: 'CSAI_STOP' }]],
};

function splitText(text, maxLen) {
  const chunks = [];
  let start = 0;
  while (start < text.length) {
    let end = start + maxLen;
    if (end < text.length) {
      const lastNl = text.lastIndexOf('\n', end);
      if (lastNl > start + maxLen * 0.75) end = lastNl + 1;
    }
    chunks.push(text.slice(start, end));
    start = end;
  }
  return chunks;
}

async function handleCsAiText(bot, chatId, userId, text) {
  if (isSensitiveQuery(text)) {
    await bot.sendMessage(chatId, getSensitiveReply(), { parse_mode: 'HTML', reply_markup: EXIT_KEYBOARD });
    return;
  }
  await bot.sendChatAction(chatId, 'typing').catch(() => {});
  try {
    const sysPrompt = buildSystemPrompt();
    let reply = await gemini.ask(text, sysPrompt);
    if (!reply) { gemini.reset(); reply = await gemini.ask(text, sysPrompt); }
    if (!reply) {
      await bot.sendMessage(chatId,
        '⚠️ <b>CS AI sedang tidak bisa dijangkau.</b>\n\nCoba lagi beberapa saat ya kak, atau hubungi owner langsung! 🙏',
        { parse_mode: 'HTML', reply_markup: EXIT_KEYBOARD }
      );
      return;
    }
    const formatted = formatForTelegram(reply);
    const chunks    = splitText(formatted, 4000);
    for (let i = 0; i < chunks.length; i++) {
      await bot.sendMessage(chatId, chunks[i], {
        parse_mode: 'HTML',
        reply_markup: i === chunks.length - 1 ? EXIT_KEYBOARD : undefined,
      });
    }
  } catch (e) {
    await bot.sendMessage(chatId,
      `⚠️ <b>Error CS AI:</b>\n<code>${String(e.message || e).slice(0, 200)}</code>\n\nCoba lagi atau hubungi owner ya kak!`,
      { parse_mode: 'HTML', reply_markup: EXIT_KEYBOARD }
    );
  }
}

async function handleCsAiPhoto(bot, msg) {
  const chatId  = msg.chat.id;
  const caption = msg.caption || '';
  await bot.sendChatAction(chatId, 'typing').catch(() => {});

  const statusMsg = await bot.sendMessage(chatId, '🔍 <i>Membaca isi foto...</i>', { parse_mode: 'HTML' }).catch(() => null);

  let ocrText = null, tmpPath = null;
  try {
    const bestPic = msg.photo[msg.photo.length - 1];
    tmpPath       = await downloadTelegramFile(bot, bestPic.file_id);
    if (tmpPath) ocrText = await ocrImage(tmpPath);
  } catch {}

  if (statusMsg) {
    const statusText = (ocrText && ocrText.length > 10)
      ? '✅ <i>Teks terdeteksi! Sedang menganalisis...</i>'
      : '📸 <i>Menganalisis berdasarkan keterangan...</i>';
    await bot.editMessageText(statusText, { chat_id: chatId, message_id: statusMsg.message_id, parse_mode: 'HTML' }).catch(() => {});
  }

  let prompt;
  if (ocrText && ocrText.length > 10) {
    prompt = `User mengirimkan screenshot/foto error. Teks terdeteksi:\n\n"${ocrText}"\n\n` +
      (caption ? `Keterangan tambahan: "${caption}"\n\n` : '') +
      `Analisis error di atas dan berikan solusi langkah demi langkah.`;
  } else {
    prompt = `User mengirimkan foto/screenshot error` +
      (caption ? ` dengan keterangan: "${caption}"` : ' tanpa keterangan') +
      `. Teks dari gambar tidak berhasil dibaca. Berikan solusi berdasarkan keterangan yang ada.`;
  }

  try {
    const sysPrompt = buildSystemPrompt();
    let reply = await gemini.ask(prompt, sysPrompt);
    if (!reply) { gemini.reset(); reply = await gemini.ask(prompt, sysPrompt); }
    if (statusMsg) await bot.deleteMessage(chatId, statusMsg.message_id).catch(() => {});

    if (!reply) {
      await bot.sendMessage(chatId,
        '⚠️ <b>CS AI tidak bisa menganalisis foto saat ini.</b>\n\nCoba ceritakan errornya lewat teks ya kak! 😊',
        { parse_mode: 'HTML', reply_markup: EXIT_KEYBOARD }
      );
      return;
    }

    if (ocrText && ocrText.length > 10) {
      await bot.sendMessage(chatId,
        `📝 <b>Teks terdeteksi dari foto:</b>\n<code>${ocrText.slice(0, 350)}${ocrText.length > 350 ? '…' : ''}</code>`,
        { parse_mode: 'HTML' }
      );
    }

    const formatted = formatForTelegram(reply);
    const chunks    = splitText(formatted, 4000);
    for (let i = 0; i < chunks.length; i++) {
      await bot.sendMessage(chatId, chunks[i], {
        parse_mode: 'HTML',
        reply_markup: i === chunks.length - 1 ? EXIT_KEYBOARD : undefined,
      });
    }
  } catch (e) {
    if (statusMsg) await bot.deleteMessage(chatId, statusMsg.message_id).catch(() => {});
    await bot.sendMessage(chatId,
      `⚠️ <b>Gagal menganalisis foto:</b>\n<code>${String(e.message || e).slice(0, 200)}</code>`,
      { parse_mode: 'HTML', reply_markup: EXIT_KEYBOARD }
    );
  } finally {
    if (tmpPath) fs.unlink(tmpPath, () => {});
  }
}

async function sendCsAiWelcome(bot, chatId, from) {
  enterCsAi(from.id);
  const name = from.first_name || 'Kak';
  const text =
    `🤖 <b>CS AI Alex Store — BETA</b>\n\n` +
    `Halo <b>${name}</b>! 👋 Selamat datang!\n\n` +
    `Aku adalah CS AI Alex, siap membantu kamu 24/7 untuk:\n` +
    `• 💰 Info harga &amp; produk\n` +
    `• 🛒 Cara order &amp; deposit\n` +
    `• 🔧 Troubleshoot &amp; solusi error\n` +
    `• 📸 Analisis foto/screenshot error\n\n` +
    `Langsung ketik pertanyaanmu, atau kirim foto error-nya! 😊\n` +
    `Ketik <code>/stopai</code> untuk keluar dari CS AI.`;

  await bot.sendMessage(chatId, text, { parse_mode: 'HTML', reply_markup: EXIT_KEYBOARD });
}

module.exports = {
  sendToolsMenu,
  buildToolsKeyboard,
  sendToolPrompt,
  isInToolState,
  getToolState,
  setToolState,
  clearToolState,
  handleToolText,
  handleToolPhoto,

  processYtDownload,
  processToUrl,

  isInCsAi,
  enterCsAi,
  exitCsAi,
  sendCsAiWelcome,
  handleCsAiText,
  handleCsAiPhoto,

};
