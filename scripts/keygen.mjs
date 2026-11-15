// Creates the provider key in .env (chmod 600) and prints only the address.
//   node scripts/keygen.mjs            mainnet address
// Copy PROVIDER_KEY from .env into the hosting provider's secret settings yourself; it is never printed.
import { existsSync, writeFileSync, readFileSync, chmodSync } from 'node:fs';
import { generatePrivateKey, binToHex } from '@bitauth/libauth';
import { providerWallet } from '../src/chain.js';

const ENV = new URL('../.env', import.meta.url);
const read = () => (existsSync(ENV) ? Object.fromEntries(readFileSync(ENV, 'utf8').trim().split('\n').filter(Boolean).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)])) : {});
let env = read();
if (!env.PROVIDER_KEY) {
  writeFileSync(ENV, (existsSync(ENV) ? readFileSync(ENV, 'utf8') : '') + `PROVIDER_KEY=${binToHex(generatePrivateKey())}\n`);
  chmodSync(ENV, 0o600);
  env = read();
}
console.log('provider address:', providerWallet(env.PROVIDER_KEY, process.env.NETWORK || 'mainnet').address);
