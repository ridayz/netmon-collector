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
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error((j.error && (j.error.message || j.error.code)) || ('AI error ' + r.status));
    const c = j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content;
    if (!c) throw new Error('AI balas kosong');
    return c;
  } finally { clearTimeout(to); }
}

const AI_SYSTEM = `Kamu teknisi NOC bernama NetMon AI. Gaya santai sopan bahasa Indonesia (kayak ngobrol sama temen), tapi teknis dan akurat.
Aturan:
- Kamu hanya BISA membaca: topologi, status up/down, traffic, alarm, riwayat downtime yang dikirim user sebagai konteks. Jangan ngarang angka yang tidak ada di konteks.
- Kamu TIDAK BISA mengubah config apa pun — kalau perlu tindakan, tulis SARAN + langkahnya, jangan klaim sudah dikerjakan.
- Jawab singkat dan to-the-point. Format: vonis dulu (1-2 baris), lalu bukti (poin-poin dari data), lalu saran. Tanpa basa-basi pembuka.`;

function buildMessages(message, ctx) {
  const c = ctx || {};
  const nodes = (c.nodes || []).map(n => `- ${n.label} (${n.sub || ''}) [${n.icon}] status:${n.st || '?'}`).join('\n');
  const alarms = (c.alarms || []).map(a => `[${a.t}] ${a.sev} ${a.dev}: ${a.msg}`).join('\n');
  const down = (c.downtime || []).map(d => `${d.dev}: DOWN ${d.downStr} → ${d.upStr || 'masih DOWN'} (total ${d.totalMs ? Math.round(d.totalMs / 1000) + 's' : '?'})`).join('\n');
  const context = `KONTEKS LIVE DARI DASHBOARD:\nLayer: ${c.layerLabel || c.layer || '?'}\nTopologi:\n${nodes || '(kosong)'}\n\nDevice yang lagi dipantau: ${c.selected || '?'}\nDevice LIVE: ${(c.live || []).join(', ') || 'tidak ada'}\n\nAlarm terakhir:\n${alarms || '(tidak ada)'}\n\nRiwayat downtime:\n${down || '(tidak ada)'}`;
  return [
    { role: 'system', content: AI_SYSTEM },
    { role: 'user', content: context + '\n\nPERTANYAAN USER:\n' + message },
  ];
}

module.exports = { aiAsk, buildMessages };
