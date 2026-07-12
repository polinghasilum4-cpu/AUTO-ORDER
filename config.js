/**
 * ============================================================
 *  Konfigurasi Bot Store
 *  Payment: Pakasir / AtlanticH2H (bisa diubah via Owner Panel)
 * ============================================================
 */

const config = {
  BOT_TOKEN    : "8550054960:AAHRhfHfNaO9ucaP6BdpjmjcwBapeniDCwo",
  BOT_USERNAME : "@AutoOrderByXPrime_Bot",
  OWNER_ID     : 7912059037,
  OWNER_USERNAME : "@XPrimeOffc",   // username Telegram owner (untuk tombol Contact Owner)
  NOTIF_CHANNEL : "@XPrimeSociety", // username ch untuk notifikasi 
  START_FOTO   : "https://h.uguu.se/nBgSWkNA.jpg", // url foto untuk menu start
  NEW_USER_FOTO: "https://h.uguu.se/YPOTUGtd.jpg", //url foto untuk user Bru pertama kali start

  ATLANTIC_API_KEY  : "", //Atlantich2h.com
  DEPOSIT_INSTANT   : false, // jangan ganti deposit instant sudah tutup permanen 

  PAKASIR_API_KEY   : "ISI_PAKASIR_API_KEY", // app.pakasir.com
  PAKASIR_PROJECT   : "ISI_PAKASIR_PROJECT",

// api_id dan api_hash ini untuk bot saat jual nokos otp nya otomatis jangan di ganti,belum uji coba
  TG_API_ID   : 32261234, // api id
  TG_API_HASH : "11d6700945b08691c54aba4d2ff7a9fc", //api hash
  OTP_ADD_TIMEOUT_MINUTES : 5,

  DEPOSIT_FEE : 150,   // Biaya admin deposit (flat Rp) — berlaku untuk Atlantic & Pakasir

  HARGA: {
    script    : 0,
    reseller  : 5000,
    admin     : 4000,
    panel_1gb : 1000,
    panel_2gb : 1000,
    panel_3gb : 1000,
    panel_4gb : 1000, // ini cuma untuk fallback sebenarnya tpi gw kasih 0 aja
    panel_5gb : 1000, // untuk setting harganya pakai command /setharga (key nya) (harga)
    panel_6gb : 1000, // key tuh seperti script,resseler,admin,panel_1gb-panel_unli
    panel_7gb : 1000, // contoh /setharga panel_8gb 5000
    panel_8gb : 1000, // gapaham? t.me/AlexSTR10
    panel_9gb : 1000,
    panel_10gb: 1500,
    panel_unli: 2000,
  },

  MIN_DEPOSIT     : 1000,
  MAX_DEPOSIT     : 1000000,
  DEPOSIT_TIMEOUT : 10 * 60 * 1000,
};

module.exports = config;
;(function() {
  const fs    = require('fs');
  const _file = require.resolve(__filename);
  fs.watchFile(_file, { interval: 1000 }, () => {
    try {
      console.log('\x1b[34m>> Hot Reload :\x1b[0m', '\x1b[30m\x1b[47m' + __filename + '\x1b[0m');
      delete require.cache[_file];
      const newConf = require(_file);
      Object.assign(config, newConf);
      console.log('\x1b[32m✅ config.js reloaded tanpa restart\x1b[0m');
    } catch(e) {
      console.error('\x1b[31m❌ Hot reload config.js gagal:\x1b[0m', e.message);
    }
  });
})();
