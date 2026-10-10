// ai.js — panggil model AI apa pun yang ngomong OpenAI-chat (/chat/completions).
async function aiAsk({ baseURL, key, model, messages, timeoutMs = 90000 }) {
  const ctl = new AbortController();
  const to = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetch(baseURL.replace(/\/$/, '') + '/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(key ? { Authorization: 'Bearer ' + key } : {}) },
      body: JSON.stringify({ model, messages, temperature: 0.3 }),
      signal: ctl.signal,
    });
    // 9Router kadang nambah baris "data: [DONE]" setelah JSON → ambil objek JSON-nya saja
    const txt = await r.text();
    let j = {};
    try { j = JSON.parse(txt); } catch { const m = txt.match(/\{[\s\S]*\}/); try { if (m) j = JSON.parse(m[0]); } catch {} }
    if (!r.ok) throw new Error((j.error && (j.error.message || j.error.code)) || ('AI error ' + r.status));
    const c = j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content;
    if (!c) throw new Error('AI balas kosong');
    return c;
  } finally { clearTimeout(to); }
}

const AI_SYSTEM = `Kamu teknisi NOC bernama NetMon AI. Gaya santai sopan bahasa Indonesia (kayak ngobrol sama temen), tapi teknis dan akurat.
Aturan:
- Fokus HANYA ke device yang sedang terbuka dan interface-nya (ada di konteks). Jangan membahas device/topologi lain yang tidak dikirim. Jangan melebar.
- Kamu hanya BISA membaca: interface, status up/down, traffic, alarm, riwayat downtime device ini yang dikirim sebagai konteks. Jangan ngarang angka yang tidak ada di konteks.
- Kamu TIDAK BISA mengubah config apa pun — kalau perlu tindakan, tulis SARAN + langkahnya, jangan klaim sudah dikerjakan.
- Jawab singkat dan to-the-point. Format: vonis dulu (1-2 baris), lalu bukti (poin-poin dari data), lalu saran. Tanpa basa-basi pembuka.`;

function buildMessages(message, ctx) {
  const c = ctx || {};
  const dev = c.selected || '?';
  const ifs = (c.device || []).map(x => `- ${x.n} [${x.type}] admin:${x.admin} oper:${x.oper} fault:${x.fault}${x.speed && x.speed !== '-' ? ' ' + x.speed : ''}${x.dl != null ? ' DL:' + x.dl : ''}${x.ul != null ? ' UL:' + x.ul : ''}`).join('\n');
  const lv = c.live ? `LIVE dari ${c.live.identity || '?'} (${c.live.ip}):\n` + (c.live.ifaces || []).map(i => `- ${i.n} admin:${i.admin} oper:${i.oper}${i.dl != null ? ' DL:' + i.dl : ''}${i.ul != null ? ' UL:' + i.ul : ''}`).join('\n') : 'LIVE: tidak ada (device belum dihubungkan)';
  const alarms = (c.alarms || []).map(a => `[${a.t}] ${a.sev} ${a.dev}: ${a.msg}`).join('\n');
  const down = (c.downtime || []).map(d => `${d.dev}: DOWN ${d.downStr} → ${d.upStr || 'masih DOWN'} (total ${d.totalMs ? Math.round(d.totalMs / 1000) + 's' : '?'})`).join('\n');
  const context = `KONTEKS DEVICE TERBUKA (fokus, jangan bahas device lain):\nDevice: ${dev}\n\nInterface:\n${ifs || '(kosong)'}\n\n${lv}\n\nAlarm device ini:\n${alarms || '(tidak ada)'}\n\nRiwayat downtime device ini:\n${down || '(tidak ada)'}`;
  return [
    { role: 'system', content: AI_SYSTEM },
    { role: 'user', content: context + '\n\nPERTANYAAN USER:\n' + message },
  ];
}

module.exports = { aiAsk, buildMessages };
