'use strict';
const axios = require('axios');

class PterodactylAPI {
  constructor() {}

  generateRandomPassword(length = 10) {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    let password = '';
    for (let i = 0; i < length; i++) password += chars.charAt(Math.floor(Math.random() * chars.length));
    return password;
  }

  capital(s) { return (s || '').charAt(0).toUpperCase() + (s || '').slice(1); }

  async checkServerStatus(server) {
    try {
      const headers = {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + server.api_key,
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      };
      const apiResponse = await axios.get(`${server.domain}/api/application/users`, {
        headers, timeout: 10000, maxRedirects: 5,
        validateStatus: s => s >= 200 && s < 500
      });
      const contentType  = apiResponse.headers['content-type'] || '';
      const responseData = apiResponse.data || '';
      if (contentType.includes('text/html') ||
          (typeof responseData === 'string' &&
           (responseData.includes('cloudflare') || responseData.includes('challenge') || responseData.includes('DDoS protection')))) {
        return { success: false, error: 'Cloudflare protection detected.', server };
      }
      return { success: true, server };
    } catch (error) {
      let errorMsg = error.message || 'Unknown error';
      const status = error.response?.status;
      if (status === 403 || status === 429 || status === 503) {
        errorMsg = `Cloudflare protection (HTTP ${status}).`;
      }
      return { success: false, error: errorMsg, server };
    }
  }

  async checkUsernameAvailability(server, username) {
    try {
      const headers = {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + server.api_key,
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      };
      const { data } = await axios.get(
        `${server.domain}/api/application/users?filter[username]=${encodeURIComponent(username.toLowerCase())}`,
        { headers, timeout: 8000, validateStatus: s => s >= 200 && s < 500 }
      );
      const users = data.data || [];
      return !users.some(u => u.attributes.username.toLowerCase() === username.toLowerCase());
    } catch (error) {
      if (error.message.includes('Cloudflare') || error.message.includes('timeout') || error.message.includes('network')) return true;
      return false;
    }
  }

  async createUserOnServer(server, { email, username, first_name, last_name, password }) {
    const url         = server.domain + '/api/application/users';
    const headers     = { Accept: 'application/json', 'Content-Type': 'application/json', Authorization: 'Bearer ' + server.api_key };
    const usernameLow = (username || '').toLowerCase();
    const { data }    = await axios.post(url, {
      email: email || `${usernameLow}@AlexBuyer.com`,
      username: usernameLow,
      first_name: first_name || usernameLow,
      last_name: last_name || 'User',
      language: 'en',
      password: password || this.generateRandomPassword()
    }, { headers, timeout: 30000 });
    if (data.errors) throw new Error(JSON.stringify(data.errors[0]));
    return data.attributes;
  }

  async getEggStartup(server) {
    const headers = { Accept: 'application/json', 'Content-Type': 'application/json', Authorization: 'Bearer ' + server.api_key };
    const { data } = await axios.get(
      `${server.domain}/api/application/nests/${server.nest_id}/eggs/${server.egg_id}`,
      { headers, timeout: 30000 }
    );
    return data.attributes.startup;
  }

  async createServerOnPanel(server, { name, description, userId, ram, disk, cpu, featureLimits }) {
    const startup = await this.getEggStartup(server);
    const headers = { Accept: 'application/json', 'Content-Type': 'application/json', Authorization: 'Bearer ' + server.api_key };

    let dockerImage, environment;
    if (server.egg_id == 15) {
      dockerImage = 'ghcr.io/ptero-eggs/yolks:nodejs_25';
      environment = { GIT_ADDRESS: '', BRANCH: '', USERNAME: '', ACCESS_TOKEN: '', MAIN_FILE: 'index.js', CMD_RUN: 'npm start', AUTO_UPDATE: '0', USER_UPLOAD: '1', NODE_PACKAGES: '', UNNODE_PACKAGES: '', CUSTOM_ENVIRONMENT_VARIABLES: '' };
    } else if (server.egg_id == 16) {
      dockerImage = 'ghcr.io/parkervcp/yolks:python_3.12';
      environment = { GIT_ADDRESS: '', BRANCH: '', USERNAME: '', ACCESS_TOKEN: '', PY_FILE: 'app.py', PY_PACKAGES: '', REQUIREMENTS_FILE: 'requirements.txt', AUTO_UPDATE: '0', USER_UPLOAD: '1' };
    } else {
      dockerImage = 'ghcr.io/ptero-eggs/yolks:nodejs_25';
      environment = { MAIN_FILE: 'index.js', USER_UPLOAD: '1', AUTO_UPDATE: '0' };
    }

    const body = {
      name, description, user: userId,
      egg: parseInt(server.egg_id),
      docker_image: dockerImage,
      startup, environment,
      limits: { memory: ram, swap: 0, disk, io: 500, cpu },
      feature_limits: featureLimits || { databases: 5, backups: 5, allocations: 5 },
      deploy: { locations: [parseInt(server.location_id)], dedicated_ip: false, port_range: [] }
    };

    const { data } = await axios.post(server.domain + '/api/application/servers', body, {
      headers, timeout: 60000, validateStatus: s => s >= 200 && s < 500
    });
    if (data.errors) throw new Error(JSON.stringify(data.errors[0]));
    return data.attributes;
  }

  async suspendServer(server, uuid) {
    const headers = { Accept: 'application/json', 'Content-Type': 'application/json', Authorization: 'Bearer ' + server.api_key };
    await axios.post(`${server.domain}/api/application/servers/${uuid}/suspend`, {}, { headers, timeout: 15000 });
  }

  async unsuspendServer(server, uuid) {
    const headers = { Accept: 'application/json', 'Content-Type': 'application/json', Authorization: 'Bearer ' + server.api_key };
    await axios.post(`${server.domain}/api/application/servers/${uuid}/unsuspend`, {}, { headers, timeout: 15000 });
  }

  
  async getServerResources(server, uuid) {
    try {
      const headers = { Accept: 'application/json', 'Content-Type': 'application/json', Authorization: 'Bearer ' + server.client_key };
      const { data } = await axios.get(`${server.domain}/api/client/servers/${uuid}/resources`, { headers, timeout: 15000 });
      return data.attributes || null;
    } catch { return null; }
  }

  
  async sendPowerAction(server, uuid, action) {
    const headers = { Accept: 'application/json', 'Content-Type': 'application/json', Authorization: 'Bearer ' + server.client_key };
    await axios.post(`${server.domain}/api/client/servers/${uuid}/power`, { signal: action }, { headers, timeout: 15000 });
  }

  async listAllServers(server, page = 1) {
    const headers = { Accept: 'application/json', 'Content-Type': 'application/json', Authorization: 'Bearer ' + server.api_key };
    const { data } = await axios.get(`${server.domain}/api/application/servers?page=${page}&per_page=50`, { headers, timeout: 20000 });
    return data;
  }

  async getServerCount(server) {
    try {
      const headers = { Accept: 'application/json', 'Content-Type': 'application/json', Authorization: 'Bearer ' + server.api_key };
      const { data } = await axios.get(server.domain + '/api/application/servers', { headers, timeout: 30000 });
      return data.meta?.pagination?.total || 0;
    } catch { return 999999; }
  }

  
  async getUserByEmail(server, email) {
    const headers = { Accept: 'application/json', 'Content-Type': 'application/json', Authorization: 'Bearer ' + server.api_key };
    const { data } = await axios.get(
      `${server.domain}/api/application/users?filter[email]=${encodeURIComponent(email.toLowerCase())}`,
      { headers, timeout: 15000, validateStatus: s => s >= 200 && s < 500 }
    );
    const users = (data.data || []).filter(u => u.attributes.email.toLowerCase() === email.toLowerCase());
    return users.length ? users[0].attributes : null;
  }

  
  async getUserByUsername(server, username) {
    const headers = { Accept: 'application/json', 'Content-Type': 'application/json', Authorization: 'Bearer ' + server.api_key };
    const { data } = await axios.get(
      `${server.domain}/api/application/users?filter[username]=${encodeURIComponent(username.toLowerCase())}`,
      { headers, timeout: 15000, validateStatus: s => s >= 200 && s < 500 }
    );
    const users = (data.data || []).filter(u => u.attributes.username.toLowerCase() === username.toLowerCase());
    return users.length ? users[0].attributes : null;
  }

  
  async resolveExistingUser(server, pteroUsername, pteroEmail) {
    
    if (pteroEmail) {
      const byEmail = await this.getUserByEmail(server, pteroEmail);
      if (byEmail) return byEmail;
    }
    
    const byUsername = await this.getUserByUsername(server, pteroUsername);
    if (byUsername) return byUsername;
    throw new Error(`Akun "${pteroUsername}" (${pteroEmail || '-'}) tidak ditemukan di panel. Hubungi owner.`);
  }

  async createPanelMultiServer(db, { username, planKey, isAdmin = false, language = 'javascript' }) {
    let servers = await db.getAllServers();
    if (servers.length === 0) throw new Error('Tidak ada server yang tersedia');

    if (!isAdmin) {
      const expectedEggId = language === 'javascript' ? 15 : 16;
      servers = servers.filter(s => s.egg_id == expectedEggId);
      if (servers.length === 0) throw new Error(`Tidak ada server ${language === 'javascript' ? 'JavaScript' : 'Python'} yang tersedia`);
    } else {
      if (servers.length === 0) throw new Error('Tidak ada server yang tersedia untuk Admin Panel');
    }

    const email    = `${username}@hekaly.com`;
    const name     = this.capital(username) + (isAdmin ? ' AdminPanel' : ' Server');
    const password = this.generateRandomPassword();

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

    const res          = RAM_OPTIONS[planKey] || RAM_OPTIONS['1gb'];
    const featureLimits = isAdmin ? { databases: 10, backups: 10, allocations: 10 } : { databases: 5, backups: 5, allocations: 5 };

    const serverLoads = await Promise.all(servers.map(async s => ({ server: s, count: await this.getServerCount(s) })));
    serverLoads.sort((a, b) => a.count !== b.count ? a.count - b.count : a.server.priority - b.server.priority);

    let lastError = null;
    let triedServers = [];

    for (const { server, count } of serverLoads) {
      try {
        const isUsernameAvailable = await this.checkUsernameAvailability(server, username);
        if (!isUsernameAvailable) {
          triedServers.push({ server: server.name, reason: `Username "${username}" sudah digunakan`, available: false });
          lastError = new Error(`Username "${username}" sudah digunakan di server ${server.name}`);
          continue;
        }
        triedServers.push({ server: server.name, reason: 'Username tersedia', available: true });

        const user = await this.createUserOnServer(server, {
          email, username: username.toLowerCase(),
          first_name: name, last_name: isAdmin ? 'Adp' : 'Server', password
        });

        const panelServer = await this.createServerOnPanel(server, {
          name,
          description: `Buyer || t.me/AlexSTR10 || ${language === 'javascript' ? 'JS' : 'Py'}`,
          userId: user.id, ram: parseInt(res.ram), disk: parseInt(res.disk), cpu: parseInt(res.cpu),
          featureLimits
        });

        return { success: true, server: server.name, domain: server.domain, user, panelServer, password, serverLoad: count + 1, triedServers, language };
      } catch (error) {
        const errorMsg = error.message || '';
        const isUsernameTaken = errorMsg.includes('already exists') || errorMsg.includes('already been taken') ||
                                errorMsg.includes('sudah digunakan') || errorMsg.includes('The username has already been taken');
        triedServers.push({ server: server.name, reason: isUsernameTaken ? `Username "${username}" sudah digunakan` : error.message, available: false, error: true });
        if (isUsernameTaken) { lastError = new Error(`Username "${username}" sudah digunakan di server ${server.name}`); continue; }
        lastError = error;
        continue;
      }
    }

    const allUsernameTaken = triedServers.every(s => s.reason.includes('Username') && s.reason.includes('sudah digunakan'));
    if (allUsernameTaken) throw new Error(`Username "${username}" sudah digunakan di semua server ${language}. Silakan gunakan username lain.`);
    throw lastError || new Error(`Gagal membuat panel ${language}. Semua server dicoba: ${triedServers.map(s => s.server).join(', ')}`);
  }
}

module.exports = PterodactylAPI;

;(function() {
  const fs    = require('fs');
  const _file = require.resolve(__filename);
  fs.watchFile(_file, { interval: 1000 }, () => {
    try {
      console.log('\x1b[34m>> Hot Reload :\x1b[0m', '\x1b[30m\x1b[47m' + __filename + '\x1b[0m');
      delete require.cache[_file];
      const NewClass = require(_file);
      Object.getOwnPropertyNames(NewClass.prototype).forEach(method => {
        if (method !== 'constructor') PterodactylAPI.prototype[method] = NewClass.prototype[method];
      });
      console.log('\x1b[32m✅ ptero.js reloaded\x1b[0m');
    } catch(e) {
      console.error('\x1b[31m❌ Hot reload ptero.js gagal:\x1b[0m', e.message);
    }
  });
})();
