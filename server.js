// netmon-collector — jembatan dashboard <-> perangkat asli.
// Endpoints:
//   GET /health
//   GET /api/discover?ip=&user=&pass=&community=   -> identitas + interface (API, fallback SNMP)
//   GET /api/traffic?ip=&iface=&user=&pass=        -> rx/tx bps realtime (2x poll 1 dtk)
//   GET /api/dhcp?ip=&user=&pass=                  -> pool usage (RouterOS)
//   GET /api/conntrack?ip=&user=&pass=             -> conntrack count/max (RouterOS)
const http = require('http');
const { URL } = require('url');
const { rosQuery } = require('./ros');
const snmpq = require('./snmpq');

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
    if (u.pathname === '/api/discover') return send(res, 200, await discover(q));
    if (u.pathname === '/api/traffic') return send(res, 200, await traffic(q));
    if (u.pathname === '/api/dhcp') {
      const pools = await rosQuery(q.ip, q.user || D.user, q.pass || D.pass, '/ip/pool/print', {}, D.port);
      return send(res, 200, { ok: true, pools });
    }
    if (u.pathname === '/api/conntrack') {
      const s = await rosQuery(q.ip, q.user || D.user, q.pass || D.pass, '/ip/firewall/connection/tracking/get', {}, D.port);
      const c = await rosQuery(q.ip, q.user || D.user, q.pass || D.pass, '/ip/firewall/connection/print', { 'count-only': '' }, D.port);
      return send(res, 200, { ok: true, tracking: s[0] || {}, count: c });
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
