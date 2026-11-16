// SignalPass chain logic: escrow contracts, deposit/refund requests for the
// subscriber's wallet (WizardConnect), charges and on-chain reveals for the provider.
// Pure functions of a CashScript network provider, so tests can use MockNetworkProvider.
import { readFileSync } from 'node:fs';
import { Contract, SignatureTemplate, TransactionBuilder, placeholderP2PKHUnlocker,
  placeholderPublicKey, placeholderSignature } from 'cashscript';
import { secp256k1, hash160, hexToBin, binToHex, sha256, utf8ToBin, encodeCashAddress,
  stringify, encodeTransaction } from '@bitauth/libauth';

export const artifact = JSON.parse(readFileSync(new URL('../SignalEscrow.json', import.meta.url)));
export const DUST = 546n;
const FEE_PER_P2PKH_INPUT = 150n;   // 1 sat/byte, generous
const FEE_PER_ESCROW_INPUT = 300n;
const FEE_BASE = 120n;

export function rules(env = process.env) {
  return {
    network: env.NETWORK || 'mainnet',
    price: BigInt(env.PRICE_SATS || 2000),          // paid to the provider per alert
    interval: BigInt(env.INTERVAL_BLOCKS || 1),     // at most one charge per N blocks
    maxFee: BigInt(env.MAX_FEE_SATS || 1000),       // miner fee the provider may take from the escrow per charge
    chargeFee: BigInt(env.CHARGE_FEE_SATS || 600),  // miner fee actually used for a charge
    minDeposit: BigInt(env.MIN_DEPOSIT_SATS || 10000),
  };
}

export const prefixOf = (network) => (network === 'mainnet' ? 'bitcoincash' : 'bchtest');
export const p2pkhAddress = (pkh, network) =>
  encodeCashAddress({ prefix: prefixOf(network), type: 'p2pkh', payload: pkh }).address;

export function providerWallet(keyHex, network) {
  const priv = hexToBin(keyHex);
  const pub = secp256k1.derivePublicKeyCompressed(priv);
  if (typeof pub === 'string') throw new Error('invalid provider key');
  const pkh = hash160(pub);
  return { pub, pkh, sig: new SignatureTemplate(priv), address: p2pkhAddress(pkh, network) };
}

/** The escrow for one subscriber (identified by their receive/0 public key). */
export function escrowFor(subscriberPubHex, providerPkh, r, provider) {
  const subPkh = hash160(hexToBin(subscriberPubHex));
  return new Contract(artifact, [subPkh, providerPkh, r.price, r.interval, r.maxFee],
    { provider, addressType: 'p2sh32' });
}

/** Commitment published in every charge: sha256(salt || text). */
export function commitment(saltHex, text) {
  return binToHex(sha256.hash(new Uint8Array([...hexToBin(saltHex), ...utf8ToBin(text)])));
}

const sum = (us) => us.reduce((a, u) => a + u.satoshis, 0n);
const plain = (us) => us.filter((u) => !u.token);

/**
 * Deposit request for the subscriber's wallet.
 * keys: [{ path: 'receive'|'change', index, pubkey }] derived from the wallet's xpubs.
 */
export async function buildDeposit({ provider, network, keys, escrowAddress, amount }) {
  const withUtxos = [];
  for (const k of keys) {
    const address = p2pkhAddress(hash160(hexToBin(k.pubkey)), network);
    for (const u of plain(await provider.getUtxos(address))) withUtxos.push({ k, address, u });
  }
  withUtxos.sort((a, b) => (b.u.satoshis > a.u.satoshis ? 1 : -1));
  const picked = [];
  let total = 0n;
  for (const w of withUtxos) {
    if (total >= amount + FEE_BASE + FEE_PER_P2PKH_INPUT * BigInt(picked.length) + 300n) break;
    picked.push(w); total += w.u.satoshis;
  }
  const fee = FEE_BASE + 40n + FEE_PER_P2PKH_INPUT * BigInt(picked.length);
  if (total < amount + fee) {
    const err = new Error(`not enough BCH in the wallet: ${total} sats available, ${amount + fee} needed`);
    err.status = 400; throw err;
  }
  const changeTo = p2pkhAddress(hash160(hexToBin(keys[0].pubkey)), network);
  const tb = new TransactionBuilder({ provider });
  picked.forEach((w) => tb.addInput(w.u, placeholderP2PKHUnlocker(w.address)));
  tb.addOutput({ to: escrowAddress, amount });
  const change = total - amount - fee;
  if (change >= DUST) tb.addOutput({ to: changeTo, amount: change });
  return {
    wc: tb.generateWcTransactionObject({ broadcast: false, userPrompt: `Deposit ${amount} sats into your SignalPass escrow` }),
    inputPaths: picked.map((w, i) => [i, w.k.path, w.k.index]),
  };
}

/** Refund request: every escrow UTXO back to the subscriber, signed by receive/0. */
export async function buildRefund({ contract, subscriberAddress, provider }) {
  const utxos = plain(await contract.getUtxos());
  if (!utxos.length) { const e = new Error('the escrow is empty'); e.status = 400; throw e; }
  const fee = FEE_BASE + FEE_PER_ESCROW_INPUT * BigInt(utxos.length);
  const tb = new TransactionBuilder({ provider });
  utxos.forEach((u) => tb.addInput(u, contract.unlock.refund(placeholderPublicKey(), placeholderSignature())));
  tb.addOutput({ to: subscriberAddress, amount: sum(utxos) - fee });
  return {
    wc: tb.generateWcTransactionObject({ broadcast: false, userPrompt: 'Take everything back from your SignalPass escrow' }),
    inputPaths: utxos.map((_, i) => [i, 'receive', 0]),
  };
}

/** Provider charges one alert from one escrow (largest UTXO). Returns null if nothing to charge. */
export async function buildCharge({ contract, prov, r, hashHex }) {
  const utxos = plain(await contract.getUtxos()).sort((a, b) => (b.satoshis > a.satoshis ? 1 : -1));
  const u = utxos[0];
  if (!u || u.satoshis < r.price + r.chargeFee + DUST) return null;
  return new TransactionBuilder({ provider: contract.provider })
    .addInput(u, contract.unlock.charge(prov.pub, prov.sig, hashHex), { sequence: Number(r.interval) })
    .addOutput({ to: prov.address, amount: r.price })
    .addOutput({ to: contract.address, amount: u.satoshis - r.price - r.chargeFee })
    .addOpReturnOutput(['0x' + hashHex]);
}

/** Public reveal of an alert from the provider wallet: OP_RETURN "SPv1" <salt> <text>. */
export async function buildReveal({ provider, prov, saltHex, text }) {
  const utxos = plain(await provider.getUtxos(prov.address));
  const fee = FEE_BASE + 80n + BigInt(utf8ToBin(text).length) + FEE_PER_P2PKH_INPUT * BigInt(utxos.length);
  const total = sum(utxos);
  if (total < fee + DUST) return null;
  const tb = new TransactionBuilder({ provider });
  utxos.forEach((u) => tb.addInput(u, prov.sig.unlockP2PKH()));
  tb.addOpReturnOutput(['SPv1', '0x' + saltHex, text]);
  tb.addOutput({ to: prov.address, amount: total - fee });
  return tb;
}

/** JSON for the browser: Uint8Array/bigint in the extended format WizardConnect parses. */
// WizardConnect wire format: the unsigned transaction as hex (as in the Riften docs),
// source outputs with tagged byte arrays and bigints ("<Uint8Array: 0x..>", "<bigint: Nn>").
export const toWire = (wc) => stringify({ ...wc, transaction: binToHex(encodeTransaction(wc.transaction)) });
export const MAX_ALERT_BYTES = 180;
