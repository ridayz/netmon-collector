// Wrapper SNMP v2c cepat pakai net-snmp (promisified).
const snmp = require('net-snmp');

const OIDS = {
  sysDescr: '1.3.6.1.2.1.1.1.0',
  sysName: '1.3.6.1.2.1.1.5.0',
  sysUpTime: '1.3.6.1.2.1.1.3.0',
  ifNumber: '1.3.6.1.2.1.2.1.0',
  ifTable: '1.3.6.1.2.1.2.2.1', // .2=descr .7=admin .8=oper .10=inOct .16=outOct .13=discards...
};

function session(ip, community, timeout = 3000) {
  return snmp.createSession(ip, community, { timeout, retries: 1, version: snmp.Version2c });
}
function get(ip, community, oids) {
  return new Promise((res, rej) => {
    const s = session(ip, community);
    s.get(oids, (e, vb) => { s.close(); e ? rej(e) : res(vb.map(v => ({ oid: v.oid, type: snmp.ObjectType[v.type], value: String(v.value) }))); });
  });
}
function walk(ip, community, base) {
  return new Promise((res, rej) => {
    const s = session(ip, community);
    const out = [];
    const maxRep = 20;
    function cb(e, table) {
      s.close();
      if (e) return rej(e);
      for (const idx of Object.keys(table)) for (const col of Object.keys(table[idx])) {
        const cell = table[idx][col];
        out.push({ idx, col, type: snmp.ObjectType[cell.type], value: String(cell.value) });
      }
      res(out);
    }
    s.table(base, maxRep, cb);
  });
}
async function ifaces(ip, community) {
  const rows = await walk(ip, community, OIDS.ifTable);
  const byIdx = {};
  for (const r of rows) { (byIdx[r.idx] = byIdx[r.idx] || {})[r.col] = r.value; }
  return Object.entries(byIdx).map(([idx, c]) => ({
    idx: Number(idx), descr: c['2'] || '', admin: c['7'] === '1' ? 'up' : 'down',
    oper: c['8'] === '1' ? 'up' : 'down', inOct: Number(c['10'] || 0), outOct: Number(c['16'] || 0),
  }));
}
module.exports = { OIDS, get, walk, ifaces };
