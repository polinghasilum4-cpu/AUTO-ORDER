'use strict';
const axios = require('axios');
const qs    = require('qs');

class AtlantichH2H {
  constructor(c) { this.c = c; }
  _h() { return { 'Content-Type': 'application/x-www-form-urlencoded' }; }
  _e(e) { return e?.response?.data ? JSON.stringify(e.response.data) : (e.message||String(e)); }

  async createQris({ amount, orderId }) {
    const body  = qs.stringify({ api_key: this.c.ATLANTIC_API_KEY, reff_id: orderId, nominal: amount, type: 'ewallet', metode: 'qris' });
    try {
      const { data } = await axios.post('https://atlantich2h.com/deposit/create', body, { headers: this._h(), timeout: 30000 });
      if (!data?.status) throw new Error(data?.message||'Gagal buat QRIS Atlantic.');
      const i = data.data;
      return { qr_string: i.qr_string, nominal: i.nominal, reff_id: i.reff_id, id: i.id };
    } catch(e) { e.message = 'Atlantic createQris: '+this._e(e); throw e; }
  }

  async checkStatus({ id }) {
    if (!id) throw new Error('Atlantic ID diperlukan');
    const body = qs.stringify({ api_key: this.c.ATLANTIC_API_KEY, id });
    try {
      const { data } = await axios.post('https://atlantich2h.com/deposit/status', body, { headers: this._h(), timeout: 30000 });
      if (!data?.status) throw new Error(data?.message||'Gagal cek status');
      const info = data.data||{};
      const raw  = (info.status||'pending').toLowerCase();
      const instant = this.c.DEPOSIT_INSTANT !== false;
      let status;
      if (raw === 'success') status = 'completed';
      else if (raw === 'processing' && !instant) status = 'completed';
      else if (raw === 'processing' && instant)  status = 'processing';
      else if (['cancel','cancelled','expired','failed'].includes(raw)) status = 'cancelled';
      else status = raw;
      return { status, raw_status: raw, amount: parseInt(info.nominal||0), _raw: info };
    } catch(e) { e.message = 'Atlantic checkStatus: '+this._e(e); throw e; }
  }

  async cancel({ orderId, atlanticId }) {
    if (!atlanticId) return { success: true };
    const body = qs.stringify({ api_key: this.c.ATLANTIC_API_KEY, id: atlanticId });
    try {
      await axios.post('https://atlantich2h.com/deposit/cancel', body, { headers: this._h(), timeout: 30000 });
      return { success: true };
    } catch(e) { return { success: false, error: e.message }; }
  }

  async getProfile() {
    const body = qs.stringify({ api_key: this.c.ATLANTIC_API_KEY });
    try {
      const { data } = await axios.post('https://atlantich2h.com/get_profile', body, { headers: this._h(), timeout: 30000 });
      if (!data?.status) throw new Error(data?.message || 'Gagal ambil profil Atlantic.');
      return data?.data || {};
    } catch(e) { e.message = 'Atlantic getProfile: '+this._e(e); throw e; }
  }

  async transferCreate({ refId, kodeBank, nomorAkun, namaPemilik, nominal }) {
    const body = qs.stringify({
      api_key     : this.c.ATLANTIC_API_KEY,
      ref_id      : refId || `CAIRKAN-${Date.now()}`,
      kode_bank   : kodeBank,
      nomor_akun  : nomorAkun,
      nama_pemilik: namaPemilik,
      nominal     : nominal
    });
    try {
      const { data } = await axios.post('https://atlantich2h.com/transfer/create', body, { headers: this._h(), timeout: 30000 });
      return data;
    } catch(e) { e.message = 'Atlantic transferCreate: '+this._e(e); throw e; }
  }
}

class PakasirAPI {
  constructor(c) { this.c = c; }
  _e(e) { return e?.response?.data ? JSON.stringify(e.response.data) : (e.message||String(e)); }

  async createQris({ amount, orderId }) {
    try {
      const { data } = await axios.post('https://app.pakasir.com/api/transactioncreate/qris',
        { project: this.c.PAKASIR_PROJECT, order_id: orderId, amount, api_key: this.c.PAKASIR_API_KEY },
        { headers: { 'Content-Type': 'application/json' }, timeout: 30000 });
      if (!data?.payment) throw new Error('Respons tidak valid dari Pakasir.');
      const p = data.payment;
      const qrString = p.payment_number || p.qr_string || p.payment_url;
      if (!qrString) throw new Error('Pakasir tidak mengembalikan QR string. Cek PAKASIR_PROJECT dan PAKASIR_API_KEY.');
      return { qr_string: qrString, nominal: amount, reff_id: orderId, id: p.order_id || orderId };
    } catch(e) { e.message = 'Pakasir createQris: '+this._e(e); throw e; }
  }

  async checkStatus({ id, orderId, amount }) {
    try {
      const { data } = await axios.get('https://app.pakasir.com/api/transactiondetail',
        { params: { project: this.c.PAKASIR_PROJECT, amount, order_id: orderId, api_key: this.c.PAKASIR_API_KEY }, timeout: 30000 });
      if (!data?.transaction) throw new Error('Respons tidak valid dari Pakasir.');
      const tx  = data.transaction;
      const raw = (tx.status||'pending').toLowerCase();
      let status;
      if (['completed','success','paid'].includes(raw)) status = 'completed';
      else if (['expired','cancel','cancelled','failed'].includes(raw)) status = 'cancelled';
      else status = raw;
      return { status, raw_status: raw, amount: parseInt(tx.amount||amount), _raw: tx };
    } catch(e) { e.message = 'Pakasir checkStatus: '+this._e(e); throw e; }
  }

  async cancel({ orderId, amount }) {
    try {
      await axios.post('https://app.pakasir.com/api/transactioncancel',
        { project: this.c.PAKASIR_PROJECT, order_id: orderId, amount: parseInt(amount), api_key: this.c.PAKASIR_API_KEY },
        { headers: { 'Content-Type': 'application/json' }, timeout: 30000 });
      return { success: true };
    } catch(e) { return { success: false, error: e.message }; }
  }
}

class PaymentGateway {
  constructor(config, db) {
    this.config   = config;
    this.db       = db;
    this.atlantic = new AtlantichH2H(config);
    this.pakasir  = new PakasirAPI(config);
  }

  _gw()    { return (this.db.getPaymentGateway()||'atlantic').toLowerCase(); }
  getName(){ return this._gw() === 'pakasir' ? '𝗣𝗮𝗸𝗮𝘀𝗶𝗿' : '𝗔𝘁𝗹𝗮𝗻𝘁𝗶𝗰𝗛𝟮𝗛'; }

  async createQris(o) {
    const MAX_RETRY = 3;
    const DELAYS_MS = [0, 3000, 7000];
    let lastErr;
    for (let attempt = 1; attempt <= MAX_RETRY; attempt++) {
      if (DELAYS_MS[attempt - 1] > 0) await new Promise(res => setTimeout(res, DELAYS_MS[attempt - 1]));
      try {
        return this._gw() === 'pakasir' ? await this.pakasir.createQris(o) : await this.atlantic.createQris(o);
      } catch (err) {
        lastErr = err;
        console.error(`[createQris] Percobaan ${attempt}/${MAX_RETRY} gagal: ${err.message}`);
        if (attempt === MAX_RETRY) break;
      }
    }
    throw lastErr;
  }

  async checkStatus(o){ return this._gw()==='pakasir' ? this.pakasir.checkStatus(o) : this.atlantic.checkStatus(o); }
  async cancel(o)     { return this._gw()==='pakasir' ? this.pakasir.cancel(o) : this.atlantic.cancel(o); }
  async getAtlanticProfile() { return this.atlantic.getProfile(); }
  async transferCreate(o)    { return this.atlantic.transferCreate(o); }
}

module.exports = PaymentGateway;

;(function() {
  const fs    = require('fs');
  const _file = require.resolve(__filename);
  fs.watchFile(_file, { interval: 1000 }, () => {
    try {
      console.log('\x1b[34m>> Hot Reload :\x1b[0m', '\x1b[30m\x1b[47m' + __filename + '\x1b[0m');
      delete require.cache[_file];
      const NewClass = require(_file);
      Object.getOwnPropertyNames(NewClass.prototype).forEach(method => {
        if (method !== 'constructor') PaymentGateway.prototype[method] = NewClass.prototype[method];
      });
      console.log('\x1b[32m✅ payment.js reloaded\x1b[0m');
    } catch(e) {
      console.error('\x1b[31m❌ Hot reload payment.js gagal:\x1b[0m', e.message);
    }
  });
})();
