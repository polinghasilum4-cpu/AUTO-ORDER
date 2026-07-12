'use strict';
const fs   = require('fs');
const path = require('path');

const DB_DIR = path.join(__dirname, 'database');
if (!fs.existsSync(DB_DIR)) fs.mkdirSync(DB_DIR, { recursive: true });

const F = {
  users    : path.join(DB_DIR, 'users.json'),
  trx      : path.join(DB_DIR, 'trx.json'),
  nokos    : path.join(DB_DIR, 'nokos.json'),
  servers  : path.join(DB_DIR, 'servers.json'),
  settings : path.join(DB_DIR, 'settings.json'),
  sessions : path.join(DB_DIR, 'sessions.json'),
  produk   : path.join(DB_DIR, 'produk.json'),
};

const DEFAULT_SETTINGS = {
  payment_gateway  : 'atlantic',
  required_joins   : [],
  reseller_enabled : true,
  admin_enabled    : true,
  reseller_link    : '',
  maintenance      : false,
  qris_manual_file_id : null,
  qris_manual_caption : null,
};

function readJson(file, fallback) {
  try {
    if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch(e) { console.error(`[DB] read ${path.basename(file)}: ${e.message}`); }
  return JSON.parse(JSON.stringify(typeof fallback === 'function' ? fallback() : fallback));
}

function writeJson(file, data) {
  try { fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8'); }
  catch(e) { console.error(`[DB] write ${path.basename(file)}: ${e.message}`); }
}

function migrateLegacy() {
  const legacyFile = path.join(__dirname, 'database.json');
  if (!fs.existsSync(legacyFile)) return;
  if (fs.existsSync(F.users))    return;
  try {
    console.log('[DB] Migrasi database.json → database/ ...');
    const old = JSON.parse(fs.readFileSync(legacyFile, 'utf8'));
    writeJson(F.users,    old.users        || {});
    writeJson(F.trx,      old.transactions || {});
    writeJson(F.nokos,    { items: old.nokos||[], orders: old.nokos_orders||[] });
    writeJson(F.servers,  old.servers      || []);
    writeJson(F.sessions, old.add_sessions || {});
    writeJson(F.settings, { ...DEFAULT_SETTINGS, ...(old.settings||{}) });
    writeJson(F.produk,   old.produk       || []);
    fs.renameSync(legacyFile, legacyFile + '.migrated');
    console.log('[DB] Migrasi selesai → database.json.migrated');
  } catch(e) { console.error('[DB] Migrasi error:', e.message); }
}

const _timers = {};
function schedSave(key, file, getData) {
  if (_timers[key]) clearTimeout(_timers[key]);
  _timers[key] = setTimeout(() => {
    writeJson(file, getData());
    delete _timers[key];
  }, 400);
}

class DB {
  constructor() {
    migrateLegacy();
    this._users    = readJson(F.users,    {});
    this._trx      = readJson(F.trx,      {});
    const nokosRaw = readJson(F.nokos,    { items:[], orders:[] });
    this._nokos    = Array.isArray(nokosRaw) ? nokosRaw : (nokosRaw.items  || []);
    this._nokosOrd = Array.isArray(nokosRaw) ? []       : (nokosRaw.orders || []);
    this._servers  = readJson(F.servers,  []);
    this._settings = { ...DEFAULT_SETTINGS, ...readJson(F.settings, DEFAULT_SETTINGS) };
    this._sessions = readJson(F.sessions, {});
    this._produk   = readJson(F.produk,   []);

    if (!this._settings.required_joins)               this._settings.required_joins   = [];
    if (!this._settings.reseller_link)                this._settings.reseller_link    = '';
    if (this._settings.reseller_enabled === undefined) this._settings.reseller_enabled = true;
    if (this._settings.admin_enabled    === undefined) this._settings.admin_enabled    = true;
    if (this._settings.maintenance      === undefined) this._settings.maintenance      = false;
    if (this._settings.qris_manual_file_id === undefined) this._settings.qris_manual_file_id = null;
    if (this._settings.qris_manual_caption === undefined) this._settings.qris_manual_caption = null;
  }

  _saveUsers()    { schedSave('users',    F.users,    () => this._users); }
  _saveTrx()      { schedSave('trx',      F.trx,      () => this._trx); }
  _saveNokos()    { schedSave('nokos',    F.nokos,    () => ({ items: this._nokos, orders: this._nokosOrd })); }
  _saveServers()  { schedSave('servers',  F.servers,  () => this._servers); }
  _saveSettings() { schedSave('settings', F.settings, () => this._settings); }
  _saveSessions() { schedSave('sessions', F.sessions, () => this._sessions); }
  _saveProduk()   { schedSave('produk',   F.produk,   () => this._produk); }

  getUser(uid) { return this._users[String(uid)] || null; }

  getUserByUsername(username) {
    const uname = username.toLowerCase().replace(/^@/, '');
    return Object.values(this._users).find(u => u.username && u.username.toLowerCase() === uname) || null;
  }

  upsertUser(from) {
    const id  = String(from.id);
    const now = new Date().toISOString();
    if (!this._users[id]) {
      this._users[id] = {
        id: from.id, username: from.username||null,
        first_name: from.first_name||'User', balance: 0, joined_at: now
      };
      this._saveUsers();
      return { user: this._users[id], isNew: true };
    }
    const u = this._users[id]; let ch = false;
    if (from.username !== undefined && u.username !== from.username) { u.username = from.username; ch = true; }
    if (from.first_name && u.first_name !== from.first_name)         { u.first_name = from.first_name; ch = true; }
    if (ch) this._saveUsers();
    return { user: u, isNew: false };
  }

  getBalance(uid)    { return this._users[String(uid)]?.balance || 0; }

  addBalance(uid, amt) {
    const u = this._users[String(uid)]; if (!u) return;
    u.balance = (u.balance||0) + amt; this._saveUsers();
  }

  deductBalance(uid, amt) {
    const u = this._users[String(uid)];
    if (!u || (u.balance||0) < amt) return false;
    u.balance -= amt; this._saveUsers(); return true;
  }

  getAllUsers() { return Object.values(this._users); }

  saveTx(tx)         { this._trx[tx.order_id] = { ...tx, created_at: new Date().toISOString() }; this._saveTrx(); }
  getTx(oid)         { return this._trx[oid] || null; }
  updateTx(oid, upd) { if (!this._trx[oid]) return; Object.assign(this._trx[oid], upd); this._saveTrx(); }
  deleteTx(oid)      { delete this._trx[oid]; this._saveTrx(); }

  getAllServers()   { return this._servers || []; }
  addServer(srv)   { this._servers.push({ ...srv, id: Date.now() }); this._saveServers(); return true; }
  removeServer(id) { this._servers = this._servers.filter(s => s.id !== id); this._saveServers(); }

  getSetting(k)        { return this._settings[k]; }
  setSetting(k, v)     { this._settings[k] = v; this._saveSettings(); }
  getPaymentGateway()  { return this._settings.payment_gateway || 'atlantic'; }
  setPaymentGateway(g) { this._settings.payment_gateway = g; this._saveSettings(); }

  getMaintenance()     { return this._settings.maintenance === true; }
  setMaintenance(v)    { this._settings.maintenance = !!v; this._saveSettings(); }

  getQrisManual()      { return { file_id: this._settings.qris_manual_file_id || null, caption: this._settings.qris_manual_caption || null }; }
  setQrisManual(file_id, caption) { this._settings.qris_manual_file_id = file_id; this._settings.qris_manual_caption = caption || null; this._saveSettings(); }

  
  _getPendingDeletions() { return this._settings._pending_deletions || []; }
  _setPendingDeletions(arr) { this._settings._pending_deletions = arr; this._saveSettings(); }

  addPendingDeletion({ uuid, owner_id, server_internal_id, ptero_user_id, delete_at, domain, server_name }) {
    const list = this._getPendingDeletions();
    if (list.find(x => x.uuid === uuid)) return;
    list.push({ uuid, owner_id: String(owner_id), server_internal_id, ptero_user_id, delete_at, domain, server_name, added_at: Date.now() });
    this._setPendingDeletions(list);
  }

  removePendingDeletion(uuid) {
    this._setPendingDeletions(this._getPendingDeletions().filter(x => x.uuid !== uuid));
  }

  getAllPendingDeletions() { return this._getPendingDeletions(); }

  getRequiredJoins() { return this._settings.required_joins || []; }

  addRequiredJoin(type, username, name) {
    const list = this._settings.required_joins;
    if (list.find(r => r.username.toLowerCase() === username.toLowerCase())) return false;
    list.push({ type, username, name }); this._saveSettings(); return true;
  }

  removeRequiredJoin(username) {
    const list = this._settings.required_joins;
    const idx  = list.findIndex(r => r.username.toLowerCase() === username.toLowerCase());
    if (idx === -1) return false;
    list.splice(idx, 1); this._saveSettings(); return true;
  }

  getNokosAvailable()  { return this._nokos.filter(n => n.status === 'available'); }
  getNokosById(id)     { return this._nokos.find(n => n.id === id) || null; }
  countNokos()         { return this.getNokosAvailable().length; }
  countNokosSold()     { return this._nokos.filter(n => n.status === 'sold').length; }

  addNokos({ number, number_masked, v2l, price, session_string, tg_id }) {
    if (this._nokos.find(n => n.number === number)) return null;
    const item = {
      id: Date.now(), number, number_masked,
      v2l: v2l||null, price, session_string: session_string||null,
      tg_id: tg_id||null, status:'available', added_at: Date.now(), sold_at: null
    };
    this._nokos.push(item); this._saveNokos(); return item;
  }

  setNokosStatus(id, status) {
    const n = this.getNokosById(id); if (!n) return;
    n.status = status; if (status === 'sold') n.sold_at = Date.now(); this._saveNokos();
  }

  reserveNokos(id) {
    const n = this.getNokosById(id);
    if (!n || n.status !== 'available') return false;
    n.status = 'pending'; this._saveNokos(); return true;
  }

  getNokosGroupedByTgId() {
    const avail = this.getNokosAvailable(); const map = {};
    for (const n of avail) {
      const p = String(n.tg_id||'0')[0]||'0';
      if (!map[p]) map[p] = { prefix:p, count:0 };
      map[p].count++;
    }
    return ['1','2','3','4','5','6','7','8'].map(p => ({ prefix:p, count: map[p]?.count||0 }));
  }

  getNokosAvailableByPrefix(prefix) {
    return this.getNokosAvailable().filter(n => String(n.tg_id||'0').startsWith(prefix));
  }

  setAddSession(ownerId, data)    { this._sessions[String(ownerId)] = { ...data, created_at: Date.now() }; this._saveSessions(); }
  getAddSession(ownerId)          { return this._sessions[String(ownerId)] || null; }
  updateAddSession(ownerId, upds) { if (!this._sessions[String(ownerId)]) return; Object.assign(this._sessions[String(ownerId)], upds); this._saveSessions(); }
  deleteAddSession(ownerId)       { delete this._sessions[String(ownerId)]; this._saveSessions(); }

  getAllProduk()     { return this._produk || []; }
  getProdukById(id) { return this._produk.find(p => p.id === id) || null; }

  addProduk({ nama, harga, deskripsi, isi, file_id, file_name }) {
    const item = { id: Date.now(), nama, harga: parseInt(harga), deskripsi: deskripsi||'', isi: isi||'', file_id: file_id||null, file_name: file_name||null, added_at: Date.now() };
    this._produk.push(item); this._saveProduk(); return item;
  }

  deleteProduk(id) {
    const idx = this._produk.findIndex(p => p.id === id);
    if (idx === -1) return false;
    this._produk.splice(idx, 1); this._saveProduk(); return true;
  }

  getAllData() {
    return {
      users        : this._users,
      transactions : this._trx,
      nokos        : this._nokos,
      nokos_orders : this._nokosOrd,
      servers      : this._servers,
      settings     : this._settings,
      add_sessions : this._sessions,
      produk       : this._produk,
    };
  }

  getBackupJson() { return JSON.stringify(this.getAllData(), null, 2); }

  restoreFromJson(jsonStr) {
    const p = JSON.parse(jsonStr);
    if (typeof p !== 'object' || Array.isArray(p)) throw new Error('Format tidak valid: bukan object.');
    if (!p.users    || typeof p.users !== 'object')    throw new Error('Field "users" tidak ada / tidak valid.');
    if (!p.settings || typeof p.settings !== 'object') throw new Error('Field "settings" tidak ada / tidak valid.');
    if (p.transactions !== undefined && typeof p.transactions !== 'object') throw new Error('Field "transactions" tidak valid.');

    this._users    = p.users;
    this._trx      = p.transactions || {};
    this._nokos    = Array.isArray(p.nokos)        ? p.nokos        : [];
    this._nokosOrd = Array.isArray(p.nokos_orders) ? p.nokos_orders : [];
    this._servers  = Array.isArray(p.servers)      ? p.servers      : [];
    this._settings = { ...DEFAULT_SETTINGS, ...(p.settings||{}) };
    this._sessions = p.add_sessions || {};
    this._produk   = Array.isArray(p.produk)       ? p.produk       : [];

    writeJson(F.users,    this._users);
    writeJson(F.trx,      this._trx);
    writeJson(F.nokos,    { items: this._nokos, orders: this._nokosOrd });
    writeJson(F.servers,  this._servers);
    writeJson(F.settings, this._settings);
    writeJson(F.sessions, this._sessions);
    writeJson(F.produk,   this._produk);

    return {
      users        : Object.keys(this._users).length,
      transactions : Object.keys(this._trx).length,
      nokos        : this._nokos.length,
      servers      : this._servers.length,
      produk       : this._produk.length,
    };
  }

  getDbDir()   { return DB_DIR; }
  getDbFiles() { return Object.entries(F).map(([key, file]) => ({ key, file })); }

  
  

  _getPanels() { return this._settings._panels || []; }
  _setPanels(arr) { this._settings._panels = arr; this._saveSettings(); }

  
  _normalizePlanKey(rec) {
    if (rec && typeof rec.plan_key === 'string' && rec.plan_key.startsWith('panel_')) {
      return { ...rec, plan_key: rec.plan_key.replace(/^panel_/, '') };
    }
    return rec;
  }

  getUserPanels(userId) {
    return this._getPanels()
      .filter(p => String(p.owner_id) === String(userId))
      .map(p => this._normalizePlanKey(p));
  }

  getPanelByUuid(uuid) {
    const rec = this._getPanels().find(p => p.uuid === uuid) || null;
    return this._normalizePlanKey(rec);
  }

  addPanelRecord({ uuid, name, domain, owner_id, owner_username, ptero_username, ptero_email, plan_key, expiry_ms }) {
    const panels = this._getPanels();
    panels.push({ uuid, name, domain, owner_id: String(owner_id), owner_username: owner_username || null, ptero_username: ptero_username || null, ptero_email: ptero_email || null, plan_key, expiry_ms, created_at: Date.now() });
    this._setPanels(panels);
  }

  setPteroUsername(uuid, ptero_username) {
    const panels = this._getPanels();
    const p = panels.find(p => p.uuid === uuid);
    if (!p) return false;
    p.ptero_username = ptero_username;
    this._setPanels(panels);
    return true;
  }

  setPteroEmail(uuid, ptero_email) {
    const panels = this._getPanels();
    const p = panels.find(p => p.uuid === uuid);
    if (!p) return false;
    p.ptero_email = ptero_email;
    this._setPanels(panels);
    return true;
  }

  setPanelExpiry(uuid, expiry_ms) {
    const panels = this._getPanels();
    const p = panels.find(p => p.uuid === uuid);
    if (!p) return false;
    p.expiry_ms = expiry_ms;
    this._setPanels(panels);
    return true;
  }

  adjustPanelExpiry(uuid, deltaMs) {
    const panels = this._getPanels();
    const p = panels.find(p => p.uuid === uuid);
    if (!p) return false;
    p.expiry_ms = Math.max(Date.now(), p.expiry_ms || Date.now()) + deltaMs;
    this._setPanels(panels);
    return p.expiry_ms;
  }

  getAllPanelRecords() { return this._getPanels(); }

  removePanelRecord(uuid) {
    const panels = this._getPanels().filter(p => p.uuid !== uuid);
    this._setPanels(panels);
  }
}

const _dbInstance = new DB();
module.exports = _dbInstance;

;(function() {
  const _file = require.resolve(__filename);
  fs.watchFile(_file, { interval: 1000 }, () => {
    try {
      console.log('\x1b[34m>> Hot Reload :\x1b[0m', '\x1b[30m\x1b[47m' + __filename + '\x1b[0m');
      delete require.cache[_file];
      const newMod = require(_file);
      const NewProto = Object.getPrototypeOf(newMod);
      Object.getOwnPropertyNames(NewProto).forEach(method => {
        if (method !== 'constructor') {
          Object.getPrototypeOf(_dbInstance)[method] = NewProto[method];
        }
      });
      console.log('\x1b[32m✅ db.js reloaded\x1b[0m');
    } catch(e) {
      console.error('\x1b[31m❌ Hot reload db.js gagal:\x1b[0m', e.message);
    }
  });
})();
