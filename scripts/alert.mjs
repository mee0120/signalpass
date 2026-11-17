// Publishes an alert, then keeps the server awake until the reveal is done.
// A free host sleeps after 15 idle minutes, and a sleeping server cannot reveal.
//   node scripts/alert.mjs "alert text"      (ADMIN_TOKEN from .env; SIGNALPASS_URL optional)
import { readFileSync } from 'node:fs';

const env = Object.fromEntries(readFileSync(new URL('../.env', import.meta.url), 'utf8').trim().split('\n')
  .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
const base = process.env.SIGNALPASS_URL || env.SIGNALPASS_URL || 'https://signalpass.onrender.com';
const text = process.argv.slice(2).join(' ').trim();
if (!text) { console.error('usage: node scripts/alert.mjs "alert text"'); process.exit(1); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const cfg = await (await fetch(base + '/api/config', { signal: AbortSignal.timeout(120_000) })).json(); // wakes the server
const res = await fetch(base + '/api/admin/alert', {
  method: 'POST', headers: { 'content-type': 'application/json', 'x-admin-token': env.ADMIN_TOKEN },
  body: JSON.stringify({ text }),
});
const out = await res.json();
console.log(new Date().toLocaleTimeString(), res.status, JSON.stringify(out));
if (!res.ok) process.exit(1);

// stay until the reveal (delay + a few ticks), checking every 5 minutes
const until = out.revealAt + 5 * 60_000;
while (Date.now() < until) {
  await sleep(5 * 60_000);
  const pub = await (await fetch(base + '/api/public')).json().catch(() => []);
  const a = pub.find((x) => x.hash === out.hash);
  console.log(new Date().toLocaleTimeString(), a ? `charged ${a.subscribersCharged}${a.revealTx ? ', revealed ' + a.revealTx : ''}` : 'waiting');
  if (a?.revealTx) break;
}
console.log(`done (reveal delay ${cfg.revealDelayMinutes} min)`);
