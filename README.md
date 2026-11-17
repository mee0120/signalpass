# SignalPass — pay per alert on Bitcoin Cash

SignalPass is a paid alert feed where the subscriber's money never leaves their control.

- You deposit BCH into **your own escrow contract**. Only you can empty it.
- The provider can take a fixed price per alert, at most once per interval, and **only by writing
  the alert's sha256 fingerprint on chain** in the same transaction.
- You read the alert at once. Everyone else sees the full text on chain 30 minutes later, so anyone
  can check that the provider never changed an alert after it was paid for.
- One tap refunds everything, signed by your own wallet.

The wallet connection uses **WizardConnect** (tested with Selene on mainnet). The server only builds
unsigned transactions; your wallet signs them.

Built for **BCH BLAZE 2026**.

## Try it

1. Open the app, press **Connect wallet**, and scan the QR code with Selene (or tap *Open in wallet* on the phone).
2. Deposit at least 10,000 sats.
3. When an alert is published, 2,000 sats move from your escrow to the provider, and the alert appears with a
   ✓ that your browser checked against the on-chain fingerprint.
4. Press **Refund everything** at any time.

## How it works

```
 subscriber wallet (Selene)            SignalPass server                  BCH chain
 ───────────────────────────           ────────────────────               ─────────
 connect via WizardConnect  ─xpubs──▶  derive escrow for receive/0
 sign deposit              ◀─request─  build P2PKH → escrow tx  ──────────▶ escrow funded
                                       alert published:
                                         hash = sha256(salt ‖ text)
                                         charge each escrow     ──────────▶ price → provider,
                                                                            rest → same escrow,
                                                                            OP_RETURN <hash>
 sees text + salt, checks hash         after 30 min: reveal tx  ──────────▶ OP_RETURN "SPv1" salt text
 sign refund               ◀─request─  build refund tx          ──────────▶ everything → subscriber
```

### Rules enforced by the contract (`SignalEscrow.cash`)

| Rule | How |
|---|---|
| Only the provider can charge | provider pubkey hash + signature |
| Exact price, paid to the provider | `tx.outputs[0]` locking bytecode and value |
| At most one charge per interval | relative timelock `this.age >= minInterval` (BIP68) |
| The rest goes back to the same escrow | `tx.outputs[1]` locks to the same contract, minus at most `maxFee` |
| Every charge publishes the alert's fingerprint | `tx.outputs[2]` is OP_RETURN with the 32-byte hash |
| Subscriber can always leave | `refund` needs only the subscriber's signature |

Defaults: price 2,000 sats, interval 1 block, max fee 1,000 sats, minimum deposit 10,000 sats.

## Before and during BLAZE

The contract and its command-line chipnet test were built **before** the hackathon, on 2026-10-28.
They are the first commit of this repository, copied unchanged from
[mee0120/signal-escrow-proto](https://github.com/mee0120/signal-escrow-proto) (commit 7ab7932).
The old README is kept as [PREHACKATHON.md](PREHACKATHON.md), and the old static demo page as
[prehackathon-demo.html](prehackathon-demo.html).

Built **during** BLAZE (every commit after `3a0d36f`):

- the web app and server (`src/`, `web/`, `public/`)
- WizardConnect wallet connection, with deposit and refund signed in the subscriber's wallet
- per-subscriber escrows derived from the wallet's receive/0 key
- the commit-then-reveal flow: salted sha256 in each charge, public reveal transaction after a delay
- browser-side verification of every alert against its on-chain fingerprint
- the public track record
- rebuilding the track record from the chain after a restart (`src/recover.js`)
- mainnet deployment and tests (`test/app.test.mjs`)

## Run it yourself

```bash
npm install
npm run build          # bundles web/app.js into public/app.js
npm test               # app tests on the CashScript mock network, plus the original contract tests
npm run keygen         # writes PROVIDER_KEY to .env (chmod 600) and prints only the address
```

Start the server with these environment variables:

| Variable | Meaning |
|---|---|
| `PROVIDER_KEY` | provider private key (hex). Keep it secret. |
| `ADMIN_TOKEN` | token for publishing alerts |
| `NETWORK` | `mainnet` (default) or `chipnet` |
| `REVEAL_DELAY_MINUTES` | default 30 |
| `STATE_FILE` | default `data/state.json` |

```bash
set -a; . ./.env; set +a; ADMIN_TOKEN=... npm start
```

Publish an alert (1–180 bytes). The script reads `ADMIN_TOKEN` from `.env`, publishes, and keeps a
free host awake until the text is revealed on chain:

```bash
npm run alert -- "Deck the Pixels: 538 registered, 9 cash prizes"
```

Or call the API directly:

```bash
curl -X POST https://<host>/api/admin/alert -H "x-admin-token: $ADMIN_TOKEN" \
  -H 'content-type: application/json' -d '{"text":"..."}'
```

The provider address needs a small balance (a few thousand sats) to pay for reveal transactions;
each charge also refills it.

## Limits

- The server keeps subscriber and alert records in a JSON file. If the host restarts with an empty
  disk, the server rebuilds the public track record from the provider address's history on chain
  (charges carry the hash, reveals carry the salt and text). `npm run chain-check` prints what it would
  rebuild. An alert that was charged but not yet revealed when the disk was lost stays a bare
  commitment, because its text only existed on the server.
- Subscribers reconnect their wallet after such a restart; their escrows are derived again from their keys.
- WizardConnect does not report the wallet's network, so the app checks the xpub prefix and refuses
  testnet wallets on mainnet.
- Alerts are public after the delay by design. The product sells speed, not secrecy.

## License

MIT
