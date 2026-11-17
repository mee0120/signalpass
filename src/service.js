// SignalPass provider service: subscribers, alerts, charges and reveals.
// State is a small JSON file; every money movement is on chain and can be checked there.
import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { dirname } from 'node:path';
import { hash160, hexToBin, utf8ToBin } from '@bitauth/libauth';
import { escrowFor, p2pkhAddress, buildCharge, buildReveal, commitment, MAX_ALERT_BYTES, DUST } from './chain.js';

export class Store {
  constructor(file) {
    this.file = file;
    this.data = file && existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : { subscribers: {}, tokens: {}, alerts: [], events: [] };
  }
  save() {
    if (!this.file) return;
    mkdirSync(dirname(this.file), { recursive: true });
    writeFileSync(this.file + '.tmp', JSON.stringify(this.data, null, 1));
    renameSync(this.file + '.tmp', this.file);
  }
}

const sum = (us) => us.reduce((a, u) => a + u.satoshis, 0n);

export class Service {
  constructor({ provider, prov, r, store, revealDelayMs = 30 * 60_000, now = () => Date.now(), log = console.log }) {
    Object.assign(this, { provider, prov, r, store, revealDelayMs, now, log });
  }

  get d() { return this.store.data; }

  escrow(pubkey) { return escrowFor(pubkey, this.prov.pkh, this.r, this.provider); }

  /** Register (or re-register) a subscriber from the wallet's receive/change keys. */
  session(keys) {
    if (!Array.isArray(keys) || !keys.length || keys.length > 40) throw Object.assign(new Error('bad keys'), { status: 400 });
    for (const k of keys) {
      if (!['receive', 'change'].includes(k.path) || !Number.isInteger(k.index) || !/^0[23][0-9a-f]{64}$/.test(k.pubkey))
        throw Object.assign(new Error('bad key entry'), { status: 400 });
    }
    const main = keys.find((k) => k.path === 'receive' && k.index === 0);
    if (!main) throw Object.assign(new Error('receive/0 key missing'), { status: 400 });
    const contract = this.escrow(main.pubkey);
    const sub = this.d.subscribers[main.pubkey] ?? { pubkey: main.pubkey, escrow: contract.address, since: this.now() };
    sub.keys = keys;
    this.d.subscribers[main.pubkey] = sub;
    const token = randomBytes(18).toString('base64url');
    this.d.tokens[token] = main.pubkey;
    this.store.save();
    return { token, ...this.publicSub(sub) };
  }

  bySession(token) {
    const pk = token && this.d.tokens[token];
    const sub = pk && this.d.subscribers[pk];
    if (!sub) throw Object.assign(new Error('unknown session: connect the wallet again'), { status: 401 });
    return sub;
  }

  publicSub(sub) {
    return { escrowAddress: sub.escrow, address: p2pkhAddress(hash160(hexToBin(sub.pubkey)), this.r.network) };
  }

  async wallet(sub) {
    const contract = this.escrow(sub.pubkey);
    const escrowUtxos = await contract.getUtxos();
    let walletSats = 0n;
    for (const k of sub.keys) {
      const a = p2pkhAddress(hash160(hexToBin(k.pubkey)), this.r.network);
      walletSats += sum((await this.provider.getUtxos(a)).filter((u) => !u.token));
    }
    const escrowSats = sum(escrowUtxos.filter((u) => !u.token));
    const perAlert = this.r.price + this.r.chargeFee;
    const usable = escrowSats > DUST ? escrowSats - DUST : 0n;
    return {
      ...this.publicSub(sub),
      walletSats: String(walletSats), escrowSats: String(escrowSats),
      alertsLeft: String(usable / perAlert),
    };
  }

  /** Alerts this subscriber paid for, with the text and salt to verify each commitment. */
  feed(sub) {
    return this.d.alerts.filter((a) => a.charges.some((c) => c.escrow === sub.escrow)).map((a) => ({
      id: a.id, text: a.text, salt: a.salt, hash: a.hash, createdAt: a.createdAt,
      chargeTx: a.charges.find((c) => c.escrow === sub.escrow).txid, revealTx: a.revealTx ?? null,
    })).reverse();
  }

  /** Track record for everyone: commitments right away, the text once revealed on chain. */
  publicFeed() {
    return this.d.alerts.filter((a) => a.charges.length).map((a) => ({
      id: a.id, hash: a.hash, createdAt: a.createdAt, revealAt: a.revealAt, subscribersCharged: a.charges.length,
      chargeTxs: a.charges.map((c) => c.txid), revealTx: a.revealTx ?? null,
      text: a.revealTx ? a.text : null, salt: a.revealTx ? a.salt : null,
    })).reverse();
  }

  async publish(text) {
    text = String(text ?? '').trim();
    const bytes = utf8ToBin(text).length;
    if (!bytes || bytes > MAX_ALERT_BYTES) throw Object.assign(new Error(`alert must be 1-${MAX_ALERT_BYTES} bytes`), { status: 400 });
    const salt = randomBytes(16).toString('hex');
    const alert = {
      id: this.d.alerts.length + 1, text, salt, hash: commitment(salt, text),
      createdAt: this.now(), revealAt: this.now() + this.revealDelayMs,
      // everyone subscribed when the alert is published; empty escrows are skipped at charge time
      pending: Object.values(this.d.subscribers).map((s) => s.escrow), charges: [],
    };
    this.d.alerts.push(alert);
    this.store.save();
    await this.tick();
    return alert;
  }

  /** Charge what is pending and reveal what is due. Safe to call repeatedly. */
  async tick() {
    const subByEscrow = Object.fromEntries(Object.values(this.d.subscribers).map((s) => [s.escrow, s]));
    for (const a of this.d.alerts) {
      if (!a.pending.length) continue;
      if (this.now() - a.createdAt > 24 * 3600_000) { a.pending = []; continue; } // stale alerts are not charged
      const still = [];
      for (const escrow of a.pending) {
        const sub = subByEscrow[escrow];
        if (!sub) continue;
        try {
          const tb = await buildCharge({ contract: this.escrow(sub.pubkey), prov: this.prov, r: this.r, hashHex: a.hash });
          if (!tb) continue; // empty escrow: not charged for this alert
          const tx = await tb.send();
          a.charges.push({ escrow, txid: tx.txid, at: this.now() });
          this.log(`charged alert ${a.id} from ${escrow}: ${tx.txid}`);
        } catch (e) {
          const msg = String(e.reason ?? e.message ?? e);
          if (/BIP68|non-final|age/i.test(msg)) still.push(escrow); // interval not reached yet: retry later
          else this.log(`charge failed for alert ${a.id} / ${escrow}: ${msg.split('\n')[0].slice(0, 200)}`);
        }
      }
      a.pending = still;
      this.store.save();
    }
    for (const a of this.d.alerts) {
      if (a.revealTx || !a.text || !a.charges.length || this.now() < a.revealAt) continue; // recovered alerts without text cannot be revealed
      try {
        const tb = await buildReveal({ provider: this.provider, prov: this.prov, saltHex: a.salt, text: a.text });
        if (!tb) { this.log(`reveal of alert ${a.id} waits for provider funds`); continue; }
        a.revealTx = (await tb.send()).txid;
        this.log(`revealed alert ${a.id}: ${a.revealTx}`);
        this.store.save();
      } catch (e) {
        this.log(`reveal failed for alert ${a.id}: ${String(e.reason ?? e.message).split('\n')[0].slice(0, 200)}`);
      }
    }
  }
}
