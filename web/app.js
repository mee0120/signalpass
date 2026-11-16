// SignalPass browser app. Connects the subscriber's wallet with WizardConnect,
// asks it to sign deposit/refund transactions built by the server, and shows
// the alerts with a local check of every on-chain commitment.
import { DappConnectionManager } from '@wizardconnect/dapp';
import { initiateDappRelay } from '@wizardconnect/core';
import QRCode from 'qrcode';
import { decodeHdPublicKey } from '@bitauth/libauth';

const $ = (id) => document.getElementById(id);
const EXPLORER = 'https://blockchair.com/bitcoin-cash/transaction/';
const KEYS = { receive: 10, change: 5 };           // addresses scanned for deposits
const TOKEN_KEY = 'signalpass-token';
let cfg, manager, relay, token = null;

const safeGet = (k) => { try { return localStorage.getItem(k); } catch { return null; } };
const safeSet = (k, v) => { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch { /* private mode */ } };
const hex = (b) => [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
const fromHex = (h) => new Uint8Array(h.match(/../g).map((x) => parseInt(x, 16)));
const sats = (s) => Number(s).toLocaleString('en-US') + ' sats';
const short = (t) => t.slice(0, 8) + '…' + t.slice(-6);
const txLink = (t) => `<a class="mono" target="_blank" rel="noopener" href="${EXPLORER}${t}">${short(t)}</a>`;
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

async function api(path, body) {
  const res = await fetch(path, {
    method: body ? 'POST' : 'GET',
    headers: { 'content-type': 'application/json', ...(token ? { 'x-session': token } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error || res.statusText);
  return json;
}

function status(msg, kind = '') { $('status').className = 'status ' + kind; $('status').textContent = msg; }

async function verify(saltHex, text, hashHex) {
  const data = new Uint8Array([...fromHex(saltHex), ...new TextEncoder().encode(text)]);
  return hex(new Uint8Array(await crypto.subtle.digest('SHA-256', data))) === hashHex;
}

// ---------- wallet connection ----------
async function connect() {
  $('connect').disabled = true;
  status('Waiting for the wallet…');
  manager = new DappConnectionManager('SignalPass', location.origin + '/icon.svg');
  relay = initiateDappRelay((p) => manager.updateConnection(p.client, p.status));
  manager.attachRelay(relay);
  manager.on('walletready', onWalletReady);
  manager.on('disconnect', () => { status('The wallet disconnected. Connect again.', 'warn'); reset(); });
  $('qr').innerHTML = '';
  const canvas = document.createElement('canvas');
  await QRCode.toCanvas(canvas, relay.qrUri, { width: 240, margin: 1 });
  $('qr').appendChild(canvas);
  $('deeplink').href = relay.uri;
  $('pair').hidden = false;
}

let readyTimer = null;
async function onWalletReady(msg) {
  const paths = manager.getSessionPaths();
  const receive = paths.find((p) => p.name === 'receive');
  if (!receive || !manager.hasPath(0)) {
    // Some wallets send wallet_ready more than once while pairing; wait for the one with keys.
    const seen = JSON.stringify({ protocol: manager.protocol, paths: paths.map((p) => [p.name, String(p.xpub).slice(0, 4)]),
      session: msg && msg.session ? Object.keys(msg.session) : null });
    console.warn('SignalPass: wallet_ready without a receive key yet', seen);
    status('Connected. Waiting for the wallet to share its addresses…');
    clearTimeout(readyTimer);
    readyTimer = setTimeout(() => status(`The wallet did not share a receive address (${seen}). Disconnect in the wallet and connect again.`, 'err'), 20_000);
    return;
  }
  clearTimeout(readyTimer);
  $('pair').hidden = true;
  // WizardConnect does not say which network the wallet is on; the receive xpub does.
  const decoded = decodeHdPublicKey(receive.xpub);
  const want = cfg.network === 'mainnet' ? 'mainnet' : 'testnet';
  if (typeof decoded === 'string' || decoded.network !== want) {
    const got = typeof decoded === 'string' ? decoded : decoded.network;
    status(`Your wallet is not on ${cfg.network} (it reported: ${got}). Switch the wallet to ${cfg.network} and connect again.`, 'err');
    reset();
    return;
  }
  const keys = [];
  for (const [path, n] of Object.entries(KEYS)) {
    const child = path === 'receive' ? 0 : 1;
    if (!manager.hasPath(child)) continue;
    for (let i = 0; i < n; i++) keys.push({ path, index: i, pubkey: hex(manager.getPubkey(child, BigInt(i))) });
  }
  const s = await api('/api/session', { keys });
  token = s.token; safeSet(TOKEN_KEY, token);
  status(`Connected to ${manager.walletName || 'your wallet'}.`, 'ok');
  await refresh();
}

function reset() {
  try { relay?.cleanup(); } catch { /* already closed */ }
  relay = null;
  $('connect').disabled = false; $('pair').hidden = true; $('account').hidden = true;
  token = null; safeSet(TOKEN_KEY, null);
}

// ---------- signing ----------
async function signAndSend(kind, body = {}) {
  const buttons = [$('deposit'), $('refund')];
  buttons.forEach((b) => { b.disabled = true; });
  try {
    status(kind === 'deposit' ? 'Building the deposit…' : 'Building the refund…');
    const built = await api('/api/build/' + kind, body);
    status('Approve the transaction in your wallet…');
    const res = await manager.signTransaction({ transaction: JSON.parse(built.request), inputPaths: built.inputPaths });
    if (res.error || !res.signedTransaction) throw new Error(res.error || 'the wallet did not sign');
    const { txid } = await api('/api/broadcast', { signedTransaction: res.signedTransaction, kind });
    status(`${kind === 'deposit' ? 'Deposit' : 'Refund'} sent.`, 'ok');
    $('lasttx').innerHTML = `${kind}: ${txLink(txid)}`;
    setTimeout(refresh, 2500);
  } catch (e) {
    status(e.message, 'err');
  } finally { buttons.forEach((b) => { b.disabled = false; }); }
}

// ---------- views ----------
async function refresh() {
  if (!token) return;
  const w = await api('/api/wallet');
  $('account').hidden = false;
  $('escrow').textContent = w.escrowAddress;
  $('me').textContent = w.address;
  $('walletSats').textContent = sats(w.walletSats);
  $('escrowSats').textContent = sats(w.escrowSats);
  $('alertsLeft').textContent = w.alertsLeft;
  const feed = await api('/api/feed');
  $('myfeed').innerHTML = feed.length ? '' : '<p class="muted">No alerts yet. You pay only when one arrives.</p>';
  for (const a of feed) $('myfeed').appendChild(await alertCard(a, { mine: true }));
}

async function alertCard(a, { mine }) {
  const el = document.createElement('div');
  el.className = 'alert';
  const when = new Date(a.createdAt).toLocaleString();
  let body;
  if (a.text) {
    const ok = await verify(a.salt, a.text, a.hash);
    body = `<p class="text">${esc(a.text)}</p>
      <p class="check ${ok ? 'ok' : 'err'}">${ok ? '✓ matches the commitment on chain' : '✗ does not match the commitment'}</p>`;
  } else {
    body = `<p class="muted">Committed. The text is revealed on chain ${cfg.revealDelayMinutes} min after the alert.</p>`;
  }
  const txs = mine
    ? `paid in ${txLink(a.chargeTx)}`
    : `${a.subscribersCharged} subscriber${a.subscribersCharged === 1 ? '' : 's'} charged, first in ${txLink(a.chargeTxs[0])}`;
  el.innerHTML = `<div class="meta"><span>#${a.id} · ${when}</span><span>${txs}${a.revealTx ? ` · revealed in ${txLink(a.revealTx)}` : ''}</span></div>
    ${body}<p class="mono hash">sha256(salt‖text) = ${a.hash}</p>`;
  return el;
}

async function loadPublic() {
  const list = await api('/api/public');
  $('public').innerHTML = list.length ? '' : '<p class="muted">No alerts published yet.</p>';
  for (const a of list) $('public').appendChild(await alertCard(a, { mine: false }));
}

// ---------- start ----------
(async () => {
  cfg = await api('/api/config');
  $('price').textContent = sats(cfg.priceSats);
  $('interval').textContent = cfg.intervalBlocks === '1' ? 'once per block (about 10 minutes)' : `once per ${cfg.intervalBlocks} blocks`;
  $('reveal').textContent = cfg.revealDelayMinutes + ' minutes';
  $('minDeposit').textContent = sats(cfg.minDepositSats);
  $('amount').value = Number(cfg.minDepositSats) * 2;
  $('connect').onclick = () => connect().catch((e) => status(e.message, 'err'));
  $('deposit').onclick = () => signAndSend('deposit', { amount: Number($('amount').value) });
  $('refund').onclick = () => signAndSend('refund');
  $('reload').onclick = () => refresh().catch((e) => status(e.message, 'err'));
  // an earlier session on this browser can show balances, but signing needs a fresh connection
  token = safeGet(TOKEN_KEY);
  if (token) refresh().then(() => status('Connect your wallet again to deposit or refund.')).catch(() => reset());
  loadPublic().catch((e) => { $('public').textContent = e.message; });
  setInterval(() => { loadPublic().catch(() => {}); if (token) refresh().catch(() => {}); }, 30_000);
})();
