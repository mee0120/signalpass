// Rebuilds the public track record from the chain, so a restarted server
// (for example on a free host with no disk) shows every alert it ever charged for.
// Every charge pays the provider and carries OP_RETURN <sha256(salt || text)>;
// every reveal comes from the provider and carries OP_RETURN "SPv1" <salt> <text>.
import { decodeTransactionCommon, decodeAuthenticationInstructions, hexToBin, binToHex,
  cashAddressToLockingBytecode, lockingBytecodeToCashAddress, sha256 } from '@bitauth/libauth';
import { commitment, prefixOf } from './chain.js';

const SPV1 = binToHex(new TextEncoder().encode('SPv1'));

/** Electrum history of an address: [{ txid, height }] (height <= 0 means unconfirmed). */
export async function electrumHistory(provider, address) {
  const lock = cashAddressToLockingBytecode(address);
  if (typeof lock === 'string') throw new Error(lock);
  const scripthash = binToHex(sha256.hash(lock.bytecode).reverse());
  const rows = await provider.performRequest('blockchain.scripthash.get_history', scripthash);
  return rows.map((r) => ({ txid: r.tx_hash, height: r.height }));
}

/** Block time in ms for a height, from the 80-byte header (timestamp at bytes 68..71, little endian). */
export async function electrumBlockTime(provider, height) {
  const header = hexToBin(await provider.performRequest('blockchain.block.header', height));
  return new DataView(header.buffer, header.byteOffset).getUint32(68, true) * 1000;
}

const pushes = (bytecode) => decodeAuthenticationInstructions(bytecode.slice(1)).map((i) => i.data);

/** Classify one provider transaction as a charge, a reveal, or neither. */
export function classify(rawHex, providerAddress, network) {
  const tx = decodeTransactionCommon(hexToBin(rawHex));
  if (typeof tx === 'string') return null;
  const addr = (o) => {
    const a = lockingBytecodeToCashAddress({ bytecode: o.lockingBytecode, prefix: prefixOf(network) });
    return typeof a === 'string' ? null : a.address;
  };
  const opret = tx.outputs.find((o) => o.lockingBytecode[0] === 0x6a);
  if (!opret) return null;
  const data = pushes(opret.lockingBytecode);
  // charge: [price → provider, rest → escrow, OP_RETURN <32-byte hash>]
  if (tx.outputs.length === 3 && data.length === 1 && data[0]?.length === 32 && addr(tx.outputs[0]) === providerAddress) {
    return { kind: 'charge', hash: binToHex(data[0]), escrow: addr(tx.outputs[1]) };
  }
  // reveal: OP_RETURN "SPv1" <salt> <text>
  if (data.length === 3 && data[0] && binToHex(data[0]) === SPV1 && data[1] && data[2]) {
    const salt = binToHex(data[1]);
    let text;
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(data[2]); } catch { return null; }
    return { kind: 'reveal', salt, text, hash: commitment(salt, text) };
  }
  return null;
}

/**
 * Merge alerts found on chain into the store. Alerts already in the store are kept as they are
 * (they may hold text that is not revealed yet). Returns the number of alerts added.
 * history: [{ txid, height }]; raw(txid) → hex; blockTime(height) → ms.
 */
export async function recoverAlerts({ store, providerAddress, network, history, raw, blockTime, now = Date.now() }) {
  const known = new Map(store.data.alerts.map((a) => [a.hash, a]));
  const found = new Map();
  const times = new Map();
  const timeOf = async (h) => {
    if (!(h > 0)) return now;
    if (!times.has(h)) times.set(h, await blockTime(h));
    return times.get(h);
  };
  for (const { txid, height } of history) {
    const c = classify(await raw(txid), providerAddress, network);
    if (!c) continue;
    const at = await timeOf(height);
    const a = found.get(c.hash) ?? { hash: c.hash, charges: [], createdAt: at };
    if (c.kind === 'charge') {
      if (!a.charges.some((x) => x.txid === txid)) a.charges.push({ escrow: c.escrow, txid, at });
      a.createdAt = Math.min(a.createdAt, at);
    } else {
      Object.assign(a, { text: c.text, salt: c.salt, revealTx: txid });
    }
    found.set(c.hash, a);
  }
  let added = 0;
  for (const a of [...found.values()].sort((x, y) => x.createdAt - y.createdAt)) {
    const mine = known.get(a.hash);
    if (mine) {
      // fill in what a restart lost, never overwrite what the store already has
      for (const c of a.charges) if (!mine.charges.some((x) => x.txid === c.txid)) mine.charges.push(c);
      if (!mine.revealTx && a.revealTx) Object.assign(mine, { revealTx: a.revealTx, text: a.text, salt: a.salt });
      continue;
    }
    if (!a.charges.length) continue; // a reveal without a charge is not an alert of this service
    store.data.alerts.push({
      id: 0, text: a.text ?? null, salt: a.salt ?? null, hash: a.hash, createdAt: a.createdAt,
      revealAt: a.createdAt, pending: [], charges: a.charges, revealTx: a.revealTx, recovered: true,
    });
    added++;
  }
  store.data.alerts.sort((x, y) => x.createdAt - y.createdAt).forEach((a, i) => { a.id = i + 1; });
  store.save();
  return added;
}
