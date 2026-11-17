// SignalPass tests on the CashScript mock network: subscriber requests for the wallet,
// provider charges with commitments, on-chain reveals, and the HTTP API.
// Run: node --test test/app.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MockNetworkProvider, randomUtxo } from 'cashscript';
import { generatePrivateKey, secp256k1, binToHex, hexToBin, sha256, utf8ToBin, hash160,
  decodeTransactionCommon } from '@bitauth/libauth';
import { parseExtendedJson } from '@wizardconnect/core';
import { rules, providerWallet, escrowFor, buildDeposit, buildRefund, commitment, p2pkhAddress, toWire } from '../src/chain.js';
import { Service, Store } from '../src/service.js';
import { createApp } from '../src/server.js';
import { recoverAlerts } from '../src/recover.js';

const r = rules({ NETWORK: 'chipnet' });
const keyPair = () => { const priv = generatePrivateKey(); return { priv, pub: binToHex(secp256k1.derivePublicKeyCompressed(priv)) }; };
const walletKeys = () => [0, 1, 2].map((i) => ({ path: 'receive', index: i, pubkey: keyPair().pub }))
  .concat([{ path: 'change', index: 0, pubkey: keyPair().pub }]);
const addr = (pub) => p2pkhAddress(hash160(hexToBin(pub)), 'chipnet');

function setup(opts = {}) {
  let clock = 1_800_000_000_000;
  const provider = new MockNetworkProvider();
  const prov = providerWallet(binToHex(generatePrivateKey()), 'chipnet');
  const svc = new Service({ provider, prov, r, store: new Store(null), now: () => clock, log: () => {}, ...opts });
  return { provider, prov, svc, advance: (ms) => { clock += ms; } };
}

test('a subscriber gets a deterministic escrow for their receive/0 key', () => {
  const { svc, prov, provider } = setup();
  const keys = walletKeys();
  const s1 = svc.session(keys), s2 = svc.session(keys);
  assert.equal(s1.escrowAddress, s2.escrowAddress);
  assert.notEqual(s1.token, s2.token);
  assert.equal(s1.escrowAddress, escrowFor(keys[0].pubkey, prov.pkh, r, provider).address);
  assert.equal(s1.address, addr(keys[0].pubkey));
  assert.throws(() => svc.session([{ path: 'receive', index: 0, pubkey: 'zz' }]));
  assert.throws(() => svc.session([{ path: 'change', index: 0, pubkey: keys[3].pubkey }]));
});

test('deposit request: wallet UTXOs in, exact amount to the escrow, change back, input paths for signing', async () => {
  const { provider, svc } = setup();
  const keys = walletKeys();
  const s = svc.session(keys);
  provider.addUtxo(addr(keys[1].pubkey), randomUtxo({ satoshis: 8_000n }));
  provider.addUtxo(addr(keys[3].pubkey), randomUtxo({ satoshis: 30_000n }));
  const { wc, inputPaths } = await buildDeposit({ provider, network: 'chipnet', keys, escrowAddress: s.escrowAddress, amount: 20_000n });
  assert.deepEqual(inputPaths, [[0, 'change', 0]]);           // the larger UTXO alone is enough
  assert.equal(wc.broadcast, false);
  const outs = wc.transaction.outputs;
  assert.equal(outs[0].valueSatoshis, 20_000n);
  assert.ok(outs[1].valueSatoshis > 9_000n && outs[1].valueSatoshis < 10_000n); // change minus fee
  // the wire format round-trips through WizardConnect's parser
  const back = parseExtendedJson(toWire(wc));
  const decoded = decodeTransactionCommon(hexToBin(back.transaction));   // the transaction goes as hex
  assert.equal(decoded.outputs[0].valueSatoshis, 20_000n);
  assert.equal(binToHex(decoded.inputs[0].outpointTransactionHash), binToHex(wc.transaction.inputs[0].outpointTransactionHash));
  assert.equal(back.sourceOutputs[0].valueSatoshis, 30_000n);
  await assert.rejects(buildDeposit({ provider, network: 'chipnet', keys, escrowAddress: s.escrowAddress, amount: 100_000n }), /not enough BCH/);
});

test('refund request spends every escrow UTXO through the refund function, signed by receive/0', async () => {
  const { provider, svc, prov } = setup();
  const keys = walletKeys();
  const s = svc.session(keys);
  provider.addUtxo(s.escrowAddress, randomUtxo({ satoshis: 12_000n }));
  provider.addUtxo(s.escrowAddress, randomUtxo({ satoshis: 7_000n }));
  const contract = escrowFor(keys[0].pubkey, prov.pkh, r, provider);
  const { wc, inputPaths } = await buildRefund({ contract, subscriberAddress: s.address, provider });
  assert.deepEqual(inputPaths, [[0, 'receive', 0], [1, 'receive', 0]]);
  assert.equal(wc.sourceOutputs[0].contract.abiFunction.name, 'refund');
  assert.equal(wc.transaction.outputs.length, 1);
  assert.equal(wc.transaction.outputs[0].valueSatoshis, 19_000n - 720n);
});

test('an alert charges every funded escrow once and commits sha256(salt || text) on chain', async () => {
  const { provider, svc } = setup();
  const a = svc.session(walletKeys()), b = svc.session(walletKeys()), empty = svc.session(walletKeys());
  provider.addUtxo(a.escrowAddress, randomUtxo({ satoshis: 20_000n }));
  provider.addUtxo(b.escrowAddress, randomUtxo({ satoshis: 20_000n }));
  const alert = await svc.publish('Reactive Omni Buildathon: 36 registered, 0 submitted, closes Dec 6');
  assert.equal(alert.charges.length, 2);
  assert.equal(alert.hash, binToHex(sha256.hash(new Uint8Array([...hexToBin(alert.salt), ...utf8ToBin(alert.text)]))));
  // the charge transaction carries the commitment in OP_RETURN and pays the provider the price
  const raw = await provider.getRawTransaction(alert.charges[0].txid);
  const tx = decodeTransactionCommon(hexToBin(raw));
  assert.equal(binToHex(tx.outputs[2].lockingBytecode), '6a20' + alert.hash);
  assert.equal(tx.outputs[0].valueSatoshis, r.price);
  // the empty escrow was not charged, and the next tick does not charge twice
  await svc.tick();
  assert.equal(alert.charges.length, 2);
  assert.ok(!alert.charges.some((c) => c.escrow === empty.escrowAddress));
});

test('subscribers see the text at once; the public sees only the commitment until the reveal', async () => {
  const { provider, svc, advance } = setup();
  const keys = walletKeys();
  const s = svc.session(keys);
  provider.addUtxo(s.escrowAddress, randomUtxo({ satoshis: 20_000n }));
  const alert = await svc.publish('Deck the Pixels: 538 registered, 9 cash prizes');
  const sub = svc.bySession(s.token);
  assert.equal(svc.feed(sub)[0].text, alert.text);
  assert.equal(svc.publicFeed()[0].text, null);
  assert.equal(svc.publicFeed()[0].hash, alert.hash);
  advance(31 * 60_000);
  await svc.tick();                                   // the price payment funds the reveal
  assert.ok(alert.revealTx);
  const tx = decodeTransactionCommon(hexToBin(await provider.getRawTransaction(alert.revealTx)));
  const opret = binToHex(tx.outputs[0].lockingBytecode);
  assert.ok(opret.includes(binToHex(utf8ToBin('SPv1'))) && opret.includes(alert.salt) && opret.includes(binToHex(utf8ToBin(alert.text))));
  assert.equal(svc.publicFeed()[0].text, alert.text);
  assert.equal(commitment(svc.publicFeed()[0].salt, svc.publicFeed()[0].text), alert.hash);
});

test('alerts must be 1-180 bytes', async () => {
  const { svc } = setup();
  await assert.rejects(svc.publish(''), /1-180/);
  await assert.rejects(svc.publish('x'.repeat(181)), /1-180/);
});

test('HTTP API: session, wallet, deposit request, admin alert and feeds', async () => {
  const { provider, prov } = setup();
  const { app } = createApp({ provider, prov, r, store: new Store(null), adminToken: 'secret-admin', revealDelayMs: 60_000,
    broadcast: (hex) => provider.sendRawTransaction(hex) });
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (p, body, h = {}) => fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json', ...h }, body: JSON.stringify(body) }).then(async (x) => ({ status: x.status, body: await x.json() }));
  const get = (p, h = {}) => fetch(base + p, { headers: h }).then(async (x) => ({ status: x.status, body: await x.json() }));
  try {
    const keys = walletKeys();
    provider.addUtxo(addr(keys[0].pubkey), randomUtxo({ satoshis: 50_000n }));
    const cfg = (await get('/api/config')).body;
    assert.equal(cfg.priceSats, '2000');
    const s = (await post('/api/session', { keys })).body;
    const h = { 'x-session': s.token };
    assert.equal((await get('/api/wallet', h)).body.walletSats, '50000');
    assert.equal((await post('/api/build/deposit', { amount: 5000 }, h)).status, 400);   // below minimum
    const dep = (await post('/api/build/deposit', { amount: 20000 }, h)).body;
    assert.match(dep.request, /<Uint8Array: 0x/);
    assert.deepEqual(dep.inputPaths, [[0, 'receive', 0]]);
    assert.equal((await post('/api/admin/alert', { text: 'hello' })).status, 401);
    provider.addUtxo(s.escrowAddress, randomUtxo({ satoshis: 20_000n }));
    const al = (await post('/api/admin/alert', { text: 'QNX: 1,468 registered, 14 cash prizes' }, { 'x-admin-token': 'secret-admin' })).body;
    assert.equal(al.charged, 1);
    assert.equal((await get('/api/feed', h)).body[0].text, 'QNX: 1,468 registered, 14 cash prizes');
    assert.equal((await get('/api/public')).body[0].text, null);
    assert.equal((await get('/api/feed')).status, 401);
  } finally { server.close(); }
});

test('after a restart with an empty disk, the public track record is rebuilt from the chain', async () => {
  const { provider, prov, svc, advance } = setup();
  const s1 = svc.session(walletKeys()), s2 = svc.session(walletKeys());
  provider.addUtxo(s1.escrowAddress, randomUtxo({ satoshis: 20_000n }));
  provider.addUtxo(s2.escrowAddress, randomUtxo({ satoshis: 20_000n }));
  const revealed = await svc.publish('Reddit Daily Games: 412 registered');
  advance(31 * 60_000);
  await svc.tick();
  assert.ok(revealed.revealTx);
  // the provider's history as an indexer would list it: the charges and the reveal
  const history = [...revealed.charges.map((c) => c.txid), revealed.revealTx].map((txid, i) => ({ txid, height: 100 + i }));
  const fresh = new Store(null);
  const added = await recoverAlerts({ store: fresh, providerAddress: prov.address, network: 'chipnet', history,
    raw: (txid) => provider.getRawTransaction(txid), blockTime: (h) => 1_800_000_000_000 + h * 600_000 });
  assert.equal(added, 1);
  const svc2 = new Service({ provider, prov, r, store: fresh, log: () => {} });
  const [pub] = svc2.publicFeed();
  assert.equal(pub.text, revealed.text);
  assert.equal(pub.hash, revealed.hash);
  assert.equal(pub.revealTx, revealed.revealTx);
  assert.equal(pub.subscribersCharged, 2);
  assert.equal(commitment(pub.salt, pub.text), pub.hash);
  // running it again adds nothing
  assert.equal(await recoverAlerts({ store: fresh, providerAddress: prov.address, network: 'chipnet', history,
    raw: (txid) => provider.getRawTransaction(txid), blockTime: () => 0 }), 0);
});

test('an alert recovered before its reveal shows the commitment only and is never revealed without text', async () => {
  const { provider, prov, svc, advance } = setup();
  const s = svc.session(walletKeys());
  provider.addUtxo(s.escrowAddress, randomUtxo({ satoshis: 20_000n }));
  const a = await svc.publish('QNX: 1,468 registered');
  const fresh = new Store(null);
  await recoverAlerts({ store: fresh, providerAddress: prov.address, network: 'chipnet',
    history: [{ txid: a.charges[0].txid, height: 0 }], raw: (txid) => provider.getRawTransaction(txid), blockTime: () => 0 });
  const svc2 = new Service({ provider, prov, r, store: fresh, log: () => {} });
  assert.equal(svc2.publicFeed()[0].text, null);
  assert.equal(svc2.publicFeed()[0].hash, a.hash);
  advance(31 * 60_000);
  await svc2.tick();
  assert.equal(fresh.data.alerts[0].revealTx, undefined);
});
