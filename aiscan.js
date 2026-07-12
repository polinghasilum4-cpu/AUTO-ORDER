'use strict';

const axios  = require('axios');
const config = require('./config');

class GeminiScanClient {
  constructor() { this._s = null; this._req = 1; }

  async _init() {
    const res = await fetch('https://gemini.google.com/', {
      headers: { 'user-agent': 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Mobile Safari/537.36' },
    });
    const h   = await res.text();
    this._s   = {
      a: (h.match(/"SNlM0e":"(.*?)"/) || [])[1] || '',
      b: (h.match(/"cfb2h":"(.*?)"/)  || [])[1] || '',
      c: (h.match(/"FdrFJe":"(.*?)"/) || [])[1] || '',
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
          'content-type' : 'application/x-www-form-urlencoded;charset=UTF-8',
          'user-agent'   : 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Mobile Safari/537.36',
          'x-same-domain': '1',
        },
        body: `f.req=${encodeURIComponent(JSON.stringify(p))}&at=${this._s.a}`,
      }
    );
    const t     = await res.text();
    const texts = [];
    for (const ln of t.split('\n')) {
      if (ln.startsWith('[[\"wrb.fr\"')) {
        try {
          const d = JSON.parse(JSON.parse(ln)[0][2]);
          if (d[4] && Array.isArray(d[4])) {
            for (const item of d[4]) {
              if (item && Array.isArray(item) && item[1]?.[0] && typeof item[1][0] === 'string')
                texts.push(item[1][0]);
            }
          }
        } catch {}
      }
    }
    if (!texts.length) return null;
    return texts[texts.length - 1].replace(/\\n/g, '\n');
  }

  reset() { this._s = null; this._req = 1; }
}

const AI_SCAN_SYSTEM = `Kamu adalah security analyst AI khusus mendeteksi script berbahaya di server hosting Pterodactyl.

Tugasmu: ANALISIS ISI KODE secara mendalam (bukan nama file) dan deteksi DDoS, mining, backdoor, spyware.

=== POLA DDOS — ANALISIS ISI KODE ===

[A] UDP/ICMP Flood:
- dgram.createSocket('udp4') + socket.send() dalam loop atau setInterval
- Buffer.alloc(65500) atau buffer sangat besar untuk payload
- setInterval(() => { socket.send(payload, 0, payload.length, port, target) }, 1)
- generatePayload() lalu socket.send() berulang puluhan kali dalam satu blok

[B] HTTP/HTTPS L7 Flood:
- process.argv[2]=target, process.argv[3]=time, process.argv[4]=rate, process.argv[5]=thread, process.argv[6]=proxyfile → TANDA PASTI ATTACK TOOL
- "Usage: node x.js target time rate thread proxyfile" string dalam kode = ATTACK TOOL
- http2.connect(target) + session.request({':path':...}) dalam cluster.fork() loop
- SocksProxyAgent / HttpsProxyAgent + readLines('proxy.txt') + rotasi random
- GREASE cipher: "GREASE:" + defaultCiphers dalam tls.connect()
- cluster.isMaster + cluster.fork() dipanggil N kali untuk multi-thread flood
- process.setMaxListeners(0) + EventEmitter.defaultMaxListeners = 0 → tanda flood tool

[C] TLS/SSL Flood:
- tls.connect() dengan cipher list panjang mengandung "GREASE"
- net.createConnection() + write() raw HTTP string dalam loop tanpa delay

[D] SSH Flood:
- ssh2.Client() + conn.connect({host, port}) dalam setInterval(fn, 1)
- floodSSHServer() function + process.argv target host

[E] WhatsApp/Telepon Spam:
- baileys/makeWaSocket + process.argv nomor hp target = WA spam
- requestPairingCode() atau kirim pesan massal ke nomor target

[F] Panel/HTTP Attack:
- axios.get(targetUrl) + SocksProxyAgent dari proxy list dalam loop
- totalRequests = 5000+ dan dipanggil berulang

=== POLA OBFUSCATED ===
- Variabel hex: _0x2a1f, _0x44ef → obfuscated malware
- eval(Buffer.from('...','base64').toString()) = base64 payload tersembunyi
- exec('echo "root:pass" | chpasswd') = backdoor ubah password root
- String split+join untuk sembunyikan URL/command berbahaya

=== POLA MINING ===
- stratum+tcp:// atau stratum2+tcp:// connection string
- xmrig, cpuminer, minerd dijalankan via exec/spawn
- Worker.mine(), Miner.start(), CryptoNight algorithm

=== POLA SPYWARE ===
- os.networkInterfaces()/os.hostname() dikirim ke axios.post Telegram bot lain
- fs.readFile('/etc/shadow') atau baca file sensitif OS

=== INDIKATOR PASTI HIGH THREAT ===
1. process.argv[2..6] = target+time+rate+thread+proxyfile = DDOS TOOL
2. "Usage: node x.js target time rate thread proxyfile" = ATTACK TOOL
3. SocksProxyAgent + proxy.txt + http2.connect(target) = L7 DDOS
4. dgram + Buffer.alloc(65500) + socket.send() loop = UDP FLOOD
5. floodSSHServer() + ssh2.Client() setInterval 1ms = SSH FLOOD
6. process.setMaxListeners(0) + cluster.fork() + target argv = FLOOD TOOL

=== AMAN — JANGAN SALAH DETEKSI ===
- Bot Telegram (telegraf, node-telegram-bot-api, telethon, pyrogram) → AMAN
- Express/fastify/koa web server → AMAN
- axios.get() sekali atau polling berkala → AMAN
- setInterval polling status server (5 detik+) → AMAN
- cluster.fork() untuk web server worker → AMAN (tanpa target attack argv)
- session.json, *.session → AMAN
- mineflayer (Minecraft bot) → AMAN
- rate limiting untuk API sendiri → AMAN

=== ATURAN SNIPPET — WAJIB DIIKUTI ===
Untuk setiap file di suspicious_files, field "snippet" WAJIB diisi dengan:
- Potong 1-3 baris kode ASLI yang paling mencurigakan dari isi file tersebut
- Maksimal 150 karakter, langsung dari kode (bukan penjelasan)
- Jika file obfuscated, ambil bagian eval/Buffer.from/hex pertama yang ditemukan
- DILARANG mengosongkan snippet atau mengisi dengan "N/A", "n/a", atau keterangan
- Contoh snippet valid: "socket.send(payload,0,65500,port,target)" atau "eval(Buffer.from('aGVsbG8=','base64').toString())"
- Jika benar-benar tidak ada kode yang bisa diambil (binary/zip), tulis: "[binary/terenkripsi — tidak bisa ditampilkan]"

Jawab HANYA dalam format JSON valid (tanpa teks lain, tanpa markdown):
{"status":"CLEAN|THREAT|SUSPICIOUS","threat_type":["ddos","mining","backdoor","spyware","spam"],"confidence":"HIGH|MEDIUM|LOW|NONE","suspicious_files":[{"path":"/path","reason":"Jelaskan bagian kode spesifik berbahaya dalam bahasa Indonesia","snippet":"POTONGAN KODE ASLI WAJIB DIISI max 150 char","risk":"HIGH|MEDIUM|LOW"}],"summary":"ringkasan singkat bahasa Indonesia"}`;

const SKIP_DIRS      = { node_modules:1, '.git':1, logs:1, cache:1, '.npm':1, '.cache':1, vendor:1, backup:1, __pycache__:1 };
const TEXT_EXTS      = { '.sh':1, '.bash':1, '.py':1, '.js':1, '.mjs':1, '.php':1, '.pl':1, '.rb':1, '.ts':1, '.lua':1, '.ps1':1, '.cmd':1, '.bat':1 };
const SUSPICIOUS_PATH = ['/tmp', '/dev/shm', '/var/tmp', '/run/shm'];
const MAX_FILE_SIZE  = 10 * 1024 * 1024;
const MIN_FILE_SIZE  = 2 * 1024;
const MAX_DEPTH      = 4;
const BATCH_SIZE     = 20;

function getExt(p) { const d = p.lastIndexOf('.'); return d === -1 ? '' : p.slice(d).toLowerCase(); }
function isSuspPath(p) { return SUSPICIOUS_PATH.some(s => p.startsWith(s)); }
function shouldRead(f) {
  if (!f.size) return false;
  if (isSuspPath(f.path)) return f.size <= MAX_FILE_SIZE;
  if (f.size < MIN_FILE_SIZE || f.size > MAX_FILE_SIZE) return false;
  return !!TEXT_EXTS[getExt(f.path)];
}

async function listFilesRecursive(srv, uuid, dir, depth) {
  dir   = dir   || '/';
  depth = depth || 0;
  if (depth > MAX_DEPTH) return [];
  const headers = { Accept: 'application/json', Authorization: 'Bearer ' + srv.client_key };
  try {
    const { data } = await axios.get(
      `${srv.domain}/api/client/servers/${uuid}/files/list?directory=${encodeURIComponent(dir)}`,
      { headers, timeout: 15000 }
    );
    const entries = data.data || [];
    const files   = [];
    const subs    = [];
    for (const e of entries) {
      const a        = e.attributes;
      const fullPath = (dir === '/' ? '' : dir) + '/' + a.name;
      if (a.is_file) {
        files.push({ path: fullPath, size: a.size || 0 });
      } else if (!a.is_symlink && depth < MAX_DEPTH && !SKIP_DIRS[a.name]) {
        subs.push(listFilesRecursive(srv, uuid, fullPath, depth + 1));
      }
    }
    const subResults = await Promise.all(subs);
    return files.concat(...subResults);
  } catch { return []; }
}

async function fetchFileContent(srv, uuid, filePath) {
  const headers = { Authorization: 'Bearer ' + srv.client_key, Accept: 'text/plain' };
  try {
    const { data } = await axios.get(
      `${srv.domain}/api/client/servers/${uuid}/files/contents?file=${encodeURIComponent(filePath)}`,
      { headers, timeout: 10000, responseType: 'text' }
    );
    const text = typeof data === 'string' ? data : JSON.stringify(data);
    return text.slice(0, 8000) || null;
  } catch { return null; }
}

const geminiScan = new GeminiScanClient();
function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

async function aiScanServer(srv, identifier, serverName) {
  const files  = await listFilesRecursive(srv, identifier);
  if (!files.length) return null;

  const toRead     = files.filter(shouldRead);
  const contentMap = {};

  for (let i = 0; i < toRead.length; i += BATCH_SIZE) {
    const batch   = toRead.slice(i, i + BATCH_SIZE);
    const results = await Promise.all(
      batch.map(f => fetchFileContent(srv, identifier, f.path).then(c => ({ path: f.path, content: c })))
    );
    for (const r of results) if (r.content) contentMap[r.path] = r.content;
    await delay(300);
  }

  const fileListText   = files.slice(0, 500).map(f => `${f.path} [${(f.size/1024).toFixed(1)}KB]`).join('\n');
  const keys           = Object.keys(contentMap);
  const contentSection = keys.length
    ? '\n\n--- ISI FILE (' + keys.length + ' file) ---\n' +
      keys.map(p => `=== FILE: ${p} ===\n${contentMap[p]}\n=== END ===`).join('\n\n')
    : '';

  const prompt = `Analisa server Pterodactyl "${serverName}".\n\n--- DAFTAR FILE (${files.length} file) ---\n${fileListText}${contentSection}\n\nBerikan analisa JSON sesuai format.`;

  try {
    let reply = await geminiScan.ask(prompt, AI_SCAN_SYSTEM);
    if (!reply) { geminiScan.reset(); reply = await geminiScan.ask(prompt, AI_SCAN_SYSTEM); }
    if (!reply) return null;
    const clean = reply.replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim();
    const fB = clean.indexOf('{'), lB = clean.lastIndexOf('}');
    if (fB === -1 || lB === -1) return null;
    return JSON.parse(clean.slice(fB, lB + 1));
  } catch { return null; }
}

function escH(s) { return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

const _scanCache   = new Map();
const CACHE_TTL_MS = 2 * 60 * 60 * 1000;

function _cacheSet(key, val) {
  _scanCache.set(key, { ...val, _ts: Date.now() });
  for (const [k, v] of _scanCache) {
    if (Date.now() - v._ts > CACHE_TTL_MS) _scanCache.delete(k);
  }
}
function cacheGet(key)    { return _scanCache.get(key) || null; }
function cacheDelete(key) { _scanCache.delete(key); }

function sensorStr(str, keepChars = 3) {
  if (!str) return '—';
  str = String(str);
  if (str.length <= keepChars * 2) return '*'.repeat(str.length);
  return str.slice(0, keepChars) + '*'.repeat(Math.max(4, str.length - keepChars * 2)) + str.slice(-keepChars);
}
function sensorDomain(domain) {
  if (!domain) return '—';
  try {
    const u    = new URL(domain.startsWith('http') ? domain : 'https://' + domain);
    const host = u.hostname;
    const parts = host.split('.');
    if (parts.length >= 2) parts[0] = sensorStr(parts[0], 2);
    return u.protocol + '//' + parts.join('.');
  } catch { return sensorStr(domain, 4); }
}

function buildPageContent(threats, page, totalPages, db) {
  const t = threats[page];
  if (!t) return null;

  const confIcon = { HIGH: '🔴', MEDIUM: '🟠', LOW: '🟡', NONE: '⚪' };
  const icon     = confIcon[t.sr.confidence] || '🔴';
  const types    = (t.sr.threat_type || []).join(', ').toUpperCase() || 'UNKNOWN';

  const suspFiles = (t.sr.suspicious_files || []).slice(0, 5)
    .map(f => {
      let line = `  ├ <code>${escH(f.path)}</code> [${f.risk || '?'}]\n     📌 ${escH(f.reason || '-')}`;
      const snip = f.snippet && f.snippet.trim() &&
                   !['n/a','na','null','undefined','-',''].includes(f.snippet.trim().toLowerCase())
        ? f.snippet.trim().slice(0, 150)
        : null;
      if (snip) line += `\n     🔎 <code>${escH(snip)}</code>`;
      return line;
    })
    .join('\n');

  const text =
    `🚨 <b>Ancaman Terdeteksi — AI Scan</b> [${page + 1}/${totalPages}]\n\n` +
    `${icon} Confidence : <b>${t.sr.confidence}</b>\n` +
    `⚔️ Tipe       : <b>${escH(types)}</b>\n` +
    `📡 Panel      : <code>${escH(t.srv.domain)}</code>\n` +
    `🆔 UUID       : <code>${escH(t.fullUuid)}</code>\n` +
    `🖥️ Server     : ${escH(t.serverName)}\n` +
    `👤 User       : ${escH(t.userEmail)}\n\n` +
    (suspFiles ? `📄 <b>File mencurigakan:</b>\n${suspFiles}\n\n` : '') +
    `🔍 <b>Analisis:</b>\n${escH(t.sr.summary || '-')}`;

  
  const navRow = [];
  if (totalPages > 1) {
    if (page > 0)               navRow.push({ text: '◀️ Prev', callback_data: `AISCAN_PAGE:${t.sessionKey}:${page - 1}` });
    navRow.push({ text: `${page + 1}/${totalPages}`, callback_data: 'AISCAN_NOOP' });
    if (page < totalPages - 1)  navRow.push({ text: 'Next ▶️', callback_data: `AISCAN_PAGE:${t.sessionKey}:${page + 1}` });
  }

  const actionRow = [
    { text: '🔴 Suspend', callback_data: `AISCAN_SUSPEND:${t.fullUuid.slice(0,8)}:${t.sessionKey}:${page}` },
    { text: '✖️ Tutup',   callback_data: 'AISCAN_CLOSE' },
  ];

  const keyboard = { inline_keyboard: navRow.length ? [navRow, actionRow] : [actionRow] };
  return { text, keyboard };
}

async function scanAllPanels(bot, chatId, db, ownerIdNotif) {
  const allSrvs = db.getAllServers();
  if (!allSrvs || !allSrvs.length)
    return bot.sendMessage(chatId, '❌ Tidak ada server terdaftar.', { parse_mode: 'HTML' });

  const domainMap = {};
  for (const srv of allSrvs) {
    if (!domainMap[srv.domain]) domainMap[srv.domain] = srv;
  }
  const panels = Object.values(domainMap);

  const statusMsg = await bot.sendMessage(chatId,
    `🔍 <b>AI Scan berjalan...</b>\n📡 Mengambil daftar server dari semua panel...\n<i>Bisa memakan beberapa menit.</i>`,
    { parse_mode: 'HTML' }
  );

  let totalServers = 0, totalScanned = 0, threats = 0;

  const allPanelServerLists = await Promise.all(panels.map(async (srv) => {
    let list = [];
    try {
      let page = 1;
      while (true) {
        const headers = { Accept: 'application/json', Authorization: 'Bearer ' + srv.api_key };
        const { data } = await axios.get(
          `${srv.domain}/api/application/servers?page=${page}&per_page=100`,
          { headers, timeout: 20000 }
        );
        list.push(...(data.data || []));
        const pg = data.meta?.pagination;
        if (!pg || pg.current_page >= pg.total_pages) break;
        page++;
      }
    } catch (e) {
      console.error(`[scanAll] gagal list servers panel ${srv.domain}:`, e.message);
    }
    return { srv, list };
  }));

  for (const { list } of allPanelServerLists) totalServers += list.length;

  await bot.editMessageText(
    `🔍 <b>AI Scan berjalan...</b>\n📡 ${panels.length} panel • 🖥️ ${totalServers} server\n⚡ Scan paralel penuh dimulai...`,
    { chat_id: chatId, message_id: statusMsg.message_id, parse_mode: 'HTML' }
  ).catch(() => {});

  let lastEditText = '';
  const statusInterval = setInterval(async () => {
    const txt = `🔍 <b>AI Scan berjalan...</b>\n📡 ${panels.length} panel • 🖥️ ${totalServers} server\n✅ ${totalScanned}/${totalServers} diperiksa • 🚨 ${threats} ancaman`;
    if (txt === lastEditText) return;
    lastEditText = txt;
    await bot.editMessageText(txt, {
      chat_id: chatId, message_id: statusMsg.message_id, parse_mode: 'HTML'
    }).catch(() => {});
  }, 5000);

  const allTasks = [];
  for (const { srv, list } of allPanelServerLists) {
    for (const item of list) allTasks.push({ srv, item });
  }

  
  const threatList = [];

  await Promise.all(allTasks.map(async ({ srv, item }) => {
    const attr       = item.attributes || item;
    
    const identifier = attr.identifier || (attr.uuid || '').slice(0, 8);
    
    const fullUuid   = attr.uuid || attr.identifier;
    
    const internalId = attr.id;
    const serverName = attr.name || fullUuid;
    const userEmail  = attr.user || attr.relationships?.user?.attributes?.email || '?';

    const sr = await aiScanServer(srv, identifier, serverName);
    totalScanned++;

    if (sr && sr.status !== 'CLEAN' && sr.status) {
      threats++;

      
      const sessionKey = `SS_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;

      const entry = { srv, fullUuid, internalId, serverName, userEmail, sr, sessionKey };
      threatList.push(entry);

      
      const cacheKey = `AISCAN_${fullUuid.slice(0,8)}`;
      _cacheSet(cacheKey, {
        uuid: fullUuid,
        internalId,
        domain: srv.domain,
        srv,
        serverName,
        userEmail,
        sr,
        types: (sr.threat_type || []).join(', ').toUpperCase() || 'UNKNOWN',
        icon : { HIGH: '🔴', MEDIUM: '🟠', LOW: '🟡', NONE: '⚪' }[sr.confidence] || '🔴',
        suspFiles: (sr.suspicious_files || []).slice(0, 5)
          .map(f => {
            let line = `  ├ <code>${escH(f.path)}</code> [${f.risk || '?'}]\n     📌 ${escH(f.reason || '-')}`;
            const snip = f.snippet && f.snippet.trim() &&
                         !['n/a','na','null','undefined','-',''].includes(f.snippet.trim().toLowerCase())
              ? f.snippet.trim().slice(0, 150)
              : null;
            if (snip) line += `\n     🔎 <code>${escH(snip)}</code>`;
            return line;
          })
          .join('\n'),
      });
    }
  }));

  clearInterval(statusInterval);

  
  const summary = threats === 0
    ? `✅ <b>Scan AI Selesai — Bersih!</b>\n\n📊 ${totalServers} server • ${totalScanned} diperiksa\n🔒 Tidak ada script mencurigakan.`
    : `⚠️ <b>Scan AI Selesai — ${threats} Ancaman!</b>\n\n📊 ${totalServers} server • ${totalScanned} diperiksa\n\nLihat laporan di bawah 👇`;

  await bot.editMessageText(summary, {
    chat_id: chatId, message_id: statusMsg.message_id, parse_mode: 'HTML',
  }).catch(() => {});

  
  if (threatList.length > 0) {
    
    for (const t of threatList) t.sessionKey = threatList[0].sessionKey;
    
    
    const sessionKey = `SC${Date.now().toString(36).slice(-6)}${Math.random().toString(36).slice(2,5)}`;
    for (const t of threatList) t.sessionKey = sessionKey;

    
    _cacheSet(sessionKey, { threatList, chatId });

    const page0 = buildPageContent(threatList, 0, threatList.length, db);
    if (page0) {
      const reportMsg = await bot.sendMessage(chatId, page0.text, {
        parse_mode: 'HTML',
        reply_markup: page0.keyboard,
      });

      
      if (ownerIdNotif && String(ownerIdNotif) !== String(chatId)) {
        await bot.sendMessage(ownerIdNotif, page0.text, {
          parse_mode: 'HTML',
          reply_markup: page0.keyboard,
        }).catch(() => {});
      }
    }
  }
}

module.exports = { scanAllPanels, cacheGet, cacheDelete, sensorDomain, sensorStr, buildPageContent };
