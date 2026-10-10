// netmon-collector — jembatan dashboard <-> perangkat asli.
// Endpoints:
//   GET /health
//   GET /api/discover?ip=&user=&pass=&community=   -> identitas + interface (API, fallback SNMP)
//   GET /api/traffic?ip=&iface=&user=&pass=        -> rx/tx bps realtime (2x poll 1 dtk)
//   GET /api/dhcp?ip=&user=&pass=                  -> pool usage (RouterOS)
//   GET /api/conntrack?ip=&user=&pass=             -> conntrack count/max (RouterOS)
const http = require('http');
const { URL } = require('url');
const { RosApi, rosQuery } = require('./ros');
const snmpq = require('./snmpq');
const { aiAsk, buildMessages } = require('./ai');

function loadEnv() {
  try {
    require('fs').readFileSync(__dirname + '/.env', 'utf8').split('\n').forEach(l => {
      const m = l.match(/^\s*([A-Z_]+)\s*=\s*(.*?)\s*$/); if (m) process.env[m[1]] = m[2];
    });
  } catch {}
}
loadEnv();
const PORT = Number(process.env.PORT || 8932);
const D = {
  user: process.env.ROS_USER || 'netmon', pass: process.env.ROS_PASS || '',
  port: Number(process.env.ROS_PORT || 8728), community: process.env.SNMP_COMMUNITY || 'public',
};
const send = (res, code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }); res.end(JSON.stringify(obj)); };
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function discover(q) {
  const ip = q.ip, user = q.user || D.user, pass = q.pass || D.pass, community = q.community || D.community;
  if (!ip) throw new Error('param ip wajib');
  // 1) coba RouterOS API
  try {
    const [ident, res, ifs] = await Promise.all([
      rosQuery(ip, user, pass, '/system/identity/print', {}, D.port),
      rosQuery(ip, user, pass, '/system/resource/print', {}, D.port),
      rosQuery(ip, user, pass, '/interface/print', {}, D.port),
    ]);
    return {
      ok: true, via: 'routeros-api', ip,
      identity: (ident[0] || {}).name || '', board: (res[0] || {})['board-name'] || '',
      version: (res[0] || {}).version || '', uptime: (res[0] || {})['uptime'] || '',
      cpu: (res[0] || {})['cpu-load'] || '',
      interfaces: ifs.map(i => ({ name: i.name, type: i.type, admin: i.disabled === 'true' ? 'down' : 'up', oper: i.running === 'true' ? 'up' : 'down', mac: i['mac-address'] || '' })),
    };
  } catch (eApi) {
    // 2) fallback SNMP
    const [sys, ifs] = await Promise.all([
      snmpq.get(ip, community, [snmpq.OIDS.sysDescr, snmpq.OIDS.sysName, snmpq.OIDS.sysUpTime]),
      snmpq.ifaces(ip, community),
    ]);
    const g = oid => (sys.find(v => v.oid === oid) || {}).value || '';
    return {
      ok: true, via: 'snmp', ip, apiError: String(eApi.message || eApi),
      sysDescr: g(snmpq.OIDS.sysDescr), sysName: g(snmpq.OIDS.sysName), uptime: g(snmpq.OIDS.sysUpTime),
      interfaces: ifs.map(i => ({ name: i.descr || ('if' + i.idx), admin: i.admin, oper: i.oper })),
    };
  }
}

async function rosExport(host, user, pass, port) {
  const fs = require('fs');
  const api = new RosApi(host, port);
  await api.connect();
  try {
    await api.talk(['/login', `=name=${user}`, `=password=${pass}`]);
    const sents = await api.rawSentences(['/export', '=compact']);
    await sleep(1500); // beri waktu reply export terakhir
    let s2 = await api.rawSentences([]);
    const lines = [];
    for (const s of [...sents, ...s2]) for (const w of s) {
      if (w === '!re' || w === '!done' || w === '!trap' || w === '!fatal' || w.startsWith('=ret=')) continue;
      lines.push(w.startsWith('=') ? w.slice(1) : w);
    }
    return lines.join('\n');
  } finally { api.close(); }
}

// tiket approve untuk aksi tulis (dongkrak 5 menit)
const PENDING = new Map();
function mkTicket(op) {
  const t = 'AP-' + Date.now().toString(36).toUpperCase() + Math.floor(Math.random() * 99);
  PENDING.set(t, { ...op, at: Date.now() });
  setTimeout(() => PENDING.delete(t), 5 * 60 * 1000).unref?.();
  return t;
}
// cari IP target dari pesan / konteks (IP literal > selected > 1 live device)
function resolveTarget(message, ctx) {
  const m = String(message || '').match(/\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}/);
  if (m) return { ip: m[0], how: 'ip-dari-pesan' };
  const sel = String((ctx || {}).selected || '');
  const ms = sel.match(/IP (\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})/);
  if (ms) return { ip: ms[1], how: 'device-dipantau' };
  const live = Object.keys((ctx || {}).liveMap || {});
  if (live.length === 1) { const L = (ctx.liveMap || {})[live[0]]; if (L && L.ip) return { ip: L.ip, how: 'satu-satunya-live' }; }
  for (const k of live) {
    const L = (ctx.liveMap || {})[k];
    if (L && L.identity && message.toLowerCase().includes(String(L.identity).toLowerCase())) return { ip: L.ip, how: 'nama-device' };
  }
  return null;
}
async function traffic(q) {
  const ip = q.ip, user = q.user || D.user, pass = q.pass || D.pass, iface = q.iface;
  if (!ip || !iface) throw new Error('param ip & iface wajib');
  try {
    const r = await rosQuery(ip, user, pass, '/interface/monitor-traffic', { interface: iface, once: '' }, D.port);
    const a = r[0] || {};
    const rx = Number(a['rx-bits-per-second'] || 0), tx = Number(a['tx-bits-per-second'] || 0);
    return { ok: true, ip, iface, src: 'monitor', rxBps: rx, txBps: tx, rxMbps: +(rx / 1e6).toFixed(2), txMbps: +(tx / 1e6).toFixed(2) };
  } catch (eMon) {
    const once = async () => {
      const all = await rosQuery(ip, user, pass, '/interface/print', { '.proplist': 'name,rx-byte,tx-byte' }, D.port);
      const f = all.find(i => i.name === iface);
      if (!f) throw new Error('interface tidak ketemu: ' + iface);
      return f;
    };
    const a = await once();
    await sleep(1000);
    const b = await once();
    const rx = (Number(b['rx-byte'] || 0) - Number(a['rx-byte'] || 0)) * 8;
    const tx = (Number(b['tx-byte'] || 0) - Number(a['tx-byte'] || 0)) * 8;
    return { ok: true, ip, iface, src: 'counter', rxBps: rx, txBps: tx, rxMbps: +(rx / 1e6).toFixed(2), txMbps: +(tx / 1e6).toFixed(2) };
  }
}

const server = http.createServer(async (req, res) => {
  try {
    const u = new URL(req.url, 'http://x');
    const q = Object.fromEntries(u.searchParams);
    if (u.pathname === '/health') return send(res, 200, { ok: true, service: 'netmon-collector' });
    if (u.pathname === '/api/ai-ask' && req.method === 'POST') {
      const body = await new Promise((resolve, reject) => {
        let b = ''; req.on('data', c => { b += c; if (b.length > 200000) req.destroy(); });
        req.on('end', () => { try { resolve(JSON.parse(b || '{}')); } catch { reject(new Error('body bukan JSON')); } });
        req.on('error', reject);
      });
      if (!body.message) throw new Error('param message wajib');
      const msg = String(body.message), ctx = body.ctx || {};
      const WU = process.env.W_USER || '', WP = process.env.W_PASS || '';
      const low = msg.toLowerCase();
      // --- INTENT: backup config ---
      if (/backup/.test(low)) {
        const t = resolveTarget(msg, ctx);
        if (!t) return send(res, 200, { ok: true, mode: 'intent', reply: 'Mau backup yang mana men? Sebutin IP-nya, atau buka dulu device-nya di dashboard. Cth: "backup 192.168.18.6".' });
        const text = await rosExport(t.ip, q.user || D.user, q.pass || D.pass, D.port);
        const fs = require('fs');
        try { fs.mkdirSync(__dirname + '/backups'); } catch {}
        const safe = t.ip.replace(/\./g, '-') + '-' + new Date().toISOString().slice(0, 10);
        fs.writeFileSync(__dirname + '/backups/' + safe + '.rsc', text);
        const lines = text.split('\n').length;
        return send(res, 200, { ok: true, mode: 'intent', reply: `Backup ${t.ip} beres men (${lines} baris, ${(text.length / 1024).toFixed(1)} KB). File tersimpan di collector/backups/.`, files: [{ name: safe + '.rsc', url: '/api/backup-file?name=' + safe + '.rsc' }] });
      }
      // --- INTENT: enable/disable interface ---
      const mED = low.match(/(enable|disable|nyalakan|matikan|hidupkan|matiin)\s+([a-z0-9\-_]+)/);
      if (mED) {
        const t = resolveTarget(msg, ctx);
        if (!t) return send(res, 200, { ok: true, mode: 'intent', reply: 'Interface-nya di device mana men? Sebutin IP-nya. Cth: "disable ether3 192.168.18.6".' });
        if (!WU || !WP) return send(res, 200, { ok: true, mode: 'intent', reply: 'Aksi tulis belum dikonfigurasi men. Bikin user tulis dulu di device:\n/user group add name=mon-write policy=api,read,write\n/user add name=netmon-write group=mon-write password=XXXX\nTerus isi W_USER + W_PASS di .env collector + restart.' });
        const dis = /disable|matikan|matiin/.test(mED[1]);
        const op = { kind: dis ? 'iface-disable' : 'iface-enable', ip: t.ip, iface: mED[2] };
        if (!dis) {
          await rosQuery(t.ip, WU, WP, '/interface/set', { numbers: op.iface, disabled: 'no' }, D.port);
          return send(res, 200, { ok: true, mode: 'intent', reply: `✅ ${op.iface} di ${t.ip} udah di-ENABLE. Cek dashboard, harusnya ijo lagi.` });
        }
        const ticket = mkTicket(op);
        return send(res, 200, { ok: true, mode: 'intent', reply: `Mau DISABLE ${op.iface} di ${t.ip} — ini mutus koneksi loh. Yakin?`, actions: [{ ticket, label: `✅ Ya, disable ${op.iface}` }] });
      }
      const baseURL = (body.aiBase && String(body.aiBase).trim()) || process.env.AI_BASE_URL || 'http://localhost:20128/v1';
      const key = (body.aiKey && String(body.aiKey).trim()) || process.env.AI_KEY || '';
      const model = (body.aiModel && String(body.aiModel).trim()) || process.env.AI_MODEL || 'nine-router/auto-failover';
      const reply = await aiAsk({ baseURL, key, model, messages: buildMessages(body.message, body.ctx || {}) });
      return send(res, 200, { ok: true, model, reply });
    }
    if (u.pathname === '/api/iface-enable') {
      const ip = q.ip, iface = q.iface, user = q.user || process.env.W_USER || '', pass = q.pass || process.env.W_PASS || '';
      if (!ip || !iface) throw new Error('param ip & iface wajib');
      if (!user || !pass) throw new Error('W_USER/W_PASS belum diisi di .env');
      await rosQuery(ip, user, pass, '/interface/set', { numbers: iface, disabled: 'no' }, D.port);
      return send(res, 200, { ok: true, ip, iface, action: 'enable' });
    }
    if (u.pathname === '/api/ai-act' && req.method === 'POST') {
      const body = await new Promise((resolve, reject) => {
        let b = ''; req.on('data', c => { b += c; });
        req.on('end', () => { try { resolve(JSON.parse(b || '{}')); } catch { reject(new Error('body bukan JSON')); } });
        req.on('error', reject);
      });
      const op = PENDING.get(body.ticket);
      if (!op) throw new Error('tiket tidak valid / kedaluwarsa — minta lagi');
      PENDING.delete(body.ticket);
      const WU = process.env.W_USER || '', WP = process.env.W_PASS || '';
      if (!WU || !WP) throw new Error('W_USER/W_PASS belum diisi');
      if (op.kind === 'iface-disable') await rosQuery(op.ip, WU, WP, '/interface/set', { numbers: op.iface, disabled: 'yes' }, D.port);
      else if (op.kind === 'iface-enable') await rosQuery(op.ip, WU, WP, '/interface/set', { numbers: op.iface, disabled: 'no' }, D.port);
      else throw new Error('aksi tidak dikenal');
      return send(res, 200, { ok: true, reply: `✅ ${op.iface} di ${op.ip} udah di-${op.kind === 'iface-disable' ? 'DISABLE' : 'ENABLE'}. Tercatat di log.` });
    }
    if (u.pathname === '/api/backup-file') {
      const name = String(q.name || '').replace(/[^a-zA-Z0-9\-.]/g, '');
      if (!name.endsWith('.rsc')) throw new Error('file tidak valid');
      const fs = require('fs');
      const p = __dirname + '/backups/' + name;
      if (!fs.existsSync(p)) throw new Error('file tidak ada');
      res.writeHead(200, { 'Content-Type': 'text/plain', 'Content-Disposition': 'attachment; filename="' + name + '"', 'Access-Control-Allow-Origin': '*' });
      return res.end(fs.readFileSync(p));
    }
    if (u.pathname === '/api/discover') return send(res, 200, await discover(q));
    if (u.pathname === '/api/traffic') return send(res, 200, await traffic(q));
    if (u.pathname === '/api/status') {
      const ip = q.ip, user = q.user || D.user, pass = q.pass || D.pass;
      if (!ip) throw new Error('param ip wajib');
      const ifs = await rosQuery(ip, user, pass, '/interface/print', { '.proplist': 'name,disabled,running,type' }, D.port);
      return send(res, 200, { ok: true, ip, via: 'routeros-api', ifaces: ifs.map(i => ({ name: i.name, admin: i.disabled === 'true' ? 'down' : 'up', oper: i.running === 'true' ? 'up' : 'down', type: i.type })) });
    }
    if (u.pathname === '/api/dhcp') {
      const pools = await rosQuery(q.ip, q.user || D.user, q.pass || D.pass, '/ip/pool/print', {}, D.port);
      return send(res, 200, { ok: true, pools });
    }
    if (u.pathname === '/api/conntrack') {
      const s = await rosQuery(q.ip, q.user || D.user, q.pass || D.pass, '/ip/firewall/connection/tracking/get', {}, D.port);
      const c = await rosQuery(q.ip, q.user || D.user, q.pass || D.pass, '/ip/firewall/connection/print', { 'count-only': '' }, D.port);
      return send(res, 200, { ok: true, tracking: s[0] || {}, count: c });
    }
    if (u.pathname === '/api/neighbors') {
      if (!q.ip) throw new Error('param ip wajib');
      const user = q.user || D.user, pass = q.pass || D.pass, community = q.community || D.community;
      try {
        const nb = await rosQuery(q.ip, user, pass, '/ip/neighbor/print', {}, D.port);
        return send(res, 200, { ok: true, via: 'routeros-api', ip: q.ip, neighbors: nb.map(n => ({ mac: n['mac-address'] || '', ip: n.address || '', identity: n.identity || '', iface: n.interface || '', version: n.version || '' })) });
      } catch (eApi) {
        const rows = await snmpq.subtree(q.ip, community, '1.3.6.1.2.1.4.22.1.2');
        const ifs = await snmpq.ifaces(q.ip, community);
        const descr = idx => (ifs.find(i => i.idx === Number(idx)) || {}).descr || ('if' + idx);
        return send(res, 200, { ok: true, via: 'snmp-arp', ip: q.ip, apiError: String(eApi.message || eApi), neighbors: rows.map(r => {
          const parts = r.oid.split('.').slice(-5); const mac = r.value.split(':').map(h => h.padStart(2, '0')).join(':').toUpperCase();
          return { mac, ip: parts.slice(1).join('.'), identity: '', iface: descr(parts[0]), version: '' };
        }) });
      }
    }
    if (u.pathname === '/api/ping') {
      if (!q.ip) throw new Error('param ip wajib');
      const { execFile } = require('child_process');
      const win = process.platform === 'win32';
      const args = win ? ['-n', '1', '-w', '2000', q.ip] : ['-c', '1', '-W', '2', q.ip];
      const out = await new Promise(resolve => execFile('ping', args, { timeout: 6000 }, (e, stdout) => resolve({ e, stdout: String(stdout || '') })));
      const m = out.stdout.match(/time[=<](\d+)\s*ms/i);
      const ok = /TTL=|ttl=|bytes (from|von)/i.test(out.stdout);
      return send(res, 200, { ok, ip: q.ip, ms: m ? Number(m[1]) : null, raw: out.stdout.split('\n').slice(-3).join(' ').slice(0, 120) });
    }
    return send(res, 404, { ok: false, error: 'unknown endpoint' });
  } catch (e) { send(res, 500, { ok: false, error: String(e.message || e) }); }
});
server.listen(PORT, () => console.log('netmon-collector on :' + PORT));
process.on('unhandledRejection', e => console.error('[unhandledRejection]', e && e.message || e));
process.on('uncaughtException', e => console.error('[uncaughtException]', e && e.message || e));
