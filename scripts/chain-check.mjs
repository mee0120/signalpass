// Reads the provider's history from a mainnet indexer and prints the track record
// the server would rebuild after a restart. Nothing is sent or signed.
//   node scripts/chain-check.mjs            (uses PROVIDER_KEY from .env)
import { readFileSync } from 'node:fs';
import { ElectrumNetworkProvider } from 'cashscript';
import { providerWallet } from '../src/chain.js';
import { Store } from '../src/service.js';
import { electrumHistory, electrumBlockTime, recoverAlerts } from '../src/recover.js';

const env = Object.fromEntries(readFileSync(new URL('../.env', import.meta.url), 'utf8').trim().split('\n')
  .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
const network = process.env.NETWORK || 'mainnet';
const { address } = providerWallet(env.PROVIDER_KEY, network);
const provider = new ElectrumNetworkProvider(network);
const history = await electrumHistory(provider, address);
const store = new Store(null);
await recoverAlerts({ store, providerAddress: address, network, history,
  raw: (t) => provider.getRawTransaction(t), blockTime: (h) => electrumBlockTime(provider, h) });
console.log(`${address}: ${history.length} transaction(s), ${store.data.alerts.length} alert(s)`);
for (const a of store.data.alerts) {
  console.log(`#${a.id} ${new Date(a.createdAt).toISOString()} charged ${a.charges.length} · ${a.revealTx ? 'revealed: ' + a.text : 'not revealed yet'}`);
}
process.exit(0);
