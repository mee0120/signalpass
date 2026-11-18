// SignalPass web server: subscriber API (WizardConnect requests are built here,
// signed in the subscriber's wallet), provider admin API, and the static app.
import express from 'express';
import { timingSafeEqual } from 'node:crypto';
import { ElectrumNetworkProvider, MockNetworkProvider } from 'cashscript';
import { rules, providerWallet, buildDeposit, buildRefund, toWire, MAX_ALERT_BYTES } from './chain.js';
import { Service, Store } from './service.js';
import { recoverAlerts, electrumHistory, electrumBlockTime } from './recover.js';

export function createApp({ provider, prov, r, store, adminToken, revealDelayMs, broadcast }) {
  const svc = new Service({ provider, prov, r, store, revealDelayMs });
  const app = express();
  app.use(express.json({ limit: '64kb' }));
  app.use(express.static(new URL('../public', import.meta.url).pathname));

  const wrap = (fn) => async (req, res) => {
    try { res.json(await fn(req, res)); }
    catch (e) { res.status(e.status ?? 500).json({ error: String(e.reason ?? e.message ?? e).split('\n')[0].slice(0, 300) }); }
  };
  const session = (req) => svc.bySession(req.get('x-session') || req.body?.token);
  const admin = (req) => {
    const t = req.get('x-admin-token') || '';
    if (!adminToken || t.length !== adminToken.length || !timingSafeEqual(Buffer.from(t), Buffer.from(adminToken)))
      throw Object.assign(new Error('admin token required'), { status: 401 });
  };

  app.get('/api/config', wrap(() => ({
    network: r.network, priceSats: String(r.price), intervalBlocks: String(r.interval), maxFeeSats: String(r.maxFee),
    minDepositSats: String(r.minDeposit), providerAddress: prov.address, revealDelayMinutes: Math.round(svc.revealDelayMs / 60000),
    maxAlertBytes: MAX_ALERT_BYTES,
    // hackathon banner, set on the host so links can change without a new build
    slidesUrl: process.env.SLIDES_URL || null, repoUrl: process.env.REPO_URL || 'https://github.com/mee0120/signalpass',
    tokenAddress: process.env.TOKEN_ADDRESS || null,
  })));
  app.post('/api/session', wrap((req) => svc.session(req.body?.keys)));
  app.get('/api/wallet', wrap((req) => svc.wallet(session(req))));
  app.get('/api/feed', wrap((req) => svc.feed(session(req))));
  app.get('/api/public', wrap(() => svc.publicFeed()));

  app.post('/api/build/deposit', wrap(async (req) => {
    const sub = session(req);
    const amount = BigInt(Math.floor(Number(req.body?.amount)));
    if (!(amount >= r.minDeposit)) throw Object.assign(new Error(`minimum deposit is ${r.minDeposit} sats`), { status: 400 });
    const { wc, inputPaths } = await buildDeposit({ provider, network: r.network, keys: sub.keys, escrowAddress: sub.escrow, amount });
    return { request: toWire(wc), inputPaths };
  }));
  app.post('/api/build/refund', wrap(async (req) => {
    const sub = session(req);
    const { wc, inputPaths } = await buildRefund({ contract: svc.escrow(sub.pubkey), subscriberAddress: svc.publicSub(sub).address, provider });
    return { request: toWire(wc), inputPaths };
  }));
  // The wallet signs; the server broadcasts and keeps a short log for the page.
  app.post('/api/broadcast', wrap(async (req) => {
    const sub = session(req);
    const hex = String(req.body?.signedTransaction ?? '');
    if (!/^[0-9a-f]+$/i.test(hex) || hex.length > 200_000) throw Object.assign(new Error('bad transaction'), { status: 400 });
    const txid = await broadcast(hex);
    svc.d.events.push({ escrow: sub.escrow, kind: String(req.body?.kind ?? 'tx'), txid, at: Date.now() });
    svc.store.save();
    return { txid };
  }));
  app.get('/api/events', wrap((req) => svc.d.events.filter((e) => e.escrow === session(req).escrow).slice(-20).reverse()));

  app.post('/api/admin/alert', wrap(async (req) => {
    admin(req);
    const a = await svc.publish(req.body?.text);
    return { id: a.id, hash: a.hash, charged: a.charges.length, pending: a.pending.length, revealAt: a.revealAt };
  }));
  app.post('/api/admin/tick', wrap(async (req) => { admin(req); await svc.tick(); return { ok: true }; }));

  return { app, svc };
}

if (process.argv[1] && new URL(import.meta.url).pathname === process.argv[1]) {
  const r = rules();
  if (!process.env.PROVIDER_KEY) throw new Error('PROVIDER_KEY is not set (run: node scripts/keygen.mjs)');
  const prov = providerWallet(process.env.PROVIDER_KEY, r.network);
  const provider = r.network === 'mock' ? new MockNetworkProvider() : new ElectrumNetworkProvider(r.network);
  const store = new Store(process.env.STATE_FILE || new URL('../data/state.json', import.meta.url).pathname);
  const { app, svc } = createApp({
    provider, prov, r, store, adminToken: process.env.ADMIN_TOKEN,
    revealDelayMs: Number(process.env.REVEAL_DELAY_MINUTES || 30) * 60_000,
    broadcast: (hex) => provider.sendRawTransaction(hex),
  });
  // a free host may restart with an empty disk: rebuild the track record from the provider's history
  if (r.network !== 'mock') {
    (async () => {
      const n = await recoverAlerts({
        store, providerAddress: prov.address, network: r.network,
        history: await electrumHistory(provider, prov.address),
        raw: (txid) => provider.getRawTransaction(txid),
        blockTime: (h) => electrumBlockTime(provider, h),
      });
      console.log(`recovered ${n} alert(s) from chain`);
    })().catch((e) => console.error('recover:', e.message));
  }
  setInterval(() => svc.tick().catch((e) => console.error('tick:', e.message)), 60_000);
  const port = Number(process.env.PORT || 3000);
  app.listen(port, () => console.log(`SignalPass on :${port} (${r.network}), provider ${prov.address}`));
}
