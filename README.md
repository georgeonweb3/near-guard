# NearGuard

**Give an AI agent money without giving it the keys to everything.**

NearGuard is an on-chain spend-policy guard for AI agents, built on NEAR
(testnet). The human owner sets the rules once — a daily spend limit, a
per-transaction cap, an allowlist/blocklist of counterparties, a list of
permitted methods, and a freeze switch. Before the agent pays anyone, it
must ask the guard. The guard answers **allow**, **warn**, or **block**:

- **allow** — inside every limit. The spend is recorded against today's cap.
- **warn** — not clearly safe (unknown counterparty, unknown method, or a
  spend approaching a limit). The action is parked; only the human owner
  can approve it.
- **block** — hard refusal. On-chain, the `execute` call itself panics, so
  the guarded action cannot proceed at all.

Built for the **AI Security & Defense** track of NEAR HACKATHON
("Build Beyond Boundaries"). The track asks for a counterparty check that
returns allow/warn/block before an agent sends funds, an agent that refuses
to sign on block, and signing scoped to a function-call access key instead
of a full-access key. That is exactly this contract's design (see
"Function-call access keys" below).

## Baseline disclosure (hackathon rules Q-002 / Q-005)

NearGuard ports an existing, pre-hackathon design to NEAR:

- **tgp-guard** (pre-hackathon, on the Telegraph protocol) does pre-flight
  checks for autonomous agents — price sanity, sanctions screening, quote
  checks — and returns ALLOW / HOLD / BLOCK verdicts, aggregated
  worst-verdict-wins. NearGuard keeps that exact verdict model (HOLD is
  named "warn", the track's vocabulary).
- **Aegis** (pre-hackathon, on Base) is a spend-control layer for AI agents:
  daily caps, structured intents, instant freeze. NearGuard keeps those
  limit semantics.

The NEAR work in this repository — the policy engine port
(`src/policy.ts`), the near-sdk-js contract (`src/contract.ts`), the unit
tests, and the demos — was written inside the hackathon window
(announced 2026-10-19, window 2026-11-01 to 2026-11-14). Only this NEAR
piece is the submission.

## Reproduce it locally (no account, no network calls to NEAR)

Requires Node.js 20+.

```sh
TAR_OPTIONS=--no-same-owner npm install
```

(The `TAR_OPTIONS` flag works around a tar ownership error that the
near-sdk-js toolchain installer hits in some sandboxed environments; it is
harmless elsewhere.)

### 1. Unit tests — do this, see 16 passing tests

```sh
npm test
```

Expected tail of the output:

```
ℹ tests 16
ℹ pass 16
ℹ fail 0
```

The tests cover: clean allow, both caps at and over their limits,
cumulative daily-limit breach, blocklist hit, frozen guard, allowlist warn,
unknown-method warn, both warn zones, malformed amounts, worst-verdict-wins
aggregation, and UTC day bucketing.

### 2. Local demo — do this, see the guard refuse an attack

```sh
npm run demo
```

The demo runs the same policy engine the contract wraps, against a
simulated day ledger. Policy: daily limit 5 NEAR, per-transaction cap
2 NEAR, blocklist contains `known-scam.testnet`. You will see, in order:

1. **Clean action.** Pay `helper.testnet` 0.50 NEAR → every check ALLOW,
   ends with `helper.testnet  =>  ALLOW` and `EXECUTED. spent today: 0.50 NEAR`.
2. **Over-limit action.** Pay `helper.testnet` 3.00 NEAR →
   `BLOCK per-tx-cap`, ends with `helper.testnet  =>  BLOCK` and
   `REFUSED. The agent does not sign.`
3. **Prompt-injection attack.** The agent is told the vendor "changed
   address" and tries to pay `known-scam.testnet` 0.10 NEAR →
   `BLOCK blocklist`, ends with `known-scam.testnet  =>  BLOCK`, refused.
4. **Frozen guard.** The owner freezes the guard; a clean 0.10 NEAR payment
   is refused with `BLOCK frozen`. The owner then unfreezes it.
5. **Warn path.** With an allowlist set, paying unknown
   `newvendor.testnet` returns `WARN` and parks approval request #0;
   the owner approves it and it executes. Final line of the run:
   `=== demo complete ===`.

### 3. Build the contract — do this, get a WASM binary

```sh
npm run build
```

Expected: `Generated build/near-guard.wasm contract successfully!` and a
`build/near-guard.wasm` file (~551 KB). The build is deterministic: a clean
checkout produces a byte-identical-size binary.

## How it works

`src/policy.ts` is the whole decision engine — pure TypeScript, no NEAR
imports, BigInt-only money math (amounts are yoctoNEAR strings). Seven
sub-checks run for every proposed action and the worst verdict wins,
exactly like tgp-guard's preflight aggregation:

| Check | Block when | Warn when |
|---|---|---|
| frozen | guard is frozen | — |
| amount | amount is not a positive integer | — |
| blocklist | counterparty is blocklisted | — |
| per-tx-cap | amount > per-transaction cap | amount ≥ 80% of the cap (configurable) |
| daily-limit | spent today + amount > daily limit | projected total ≥ 80% of the limit |
| allowlist | — | list is non-empty and counterparty is not on it |
| method | — | list is non-empty and method is not on it |

`src/contract.ts` (near-sdk-js, no Rust) holds the policy on-chain, tracks
spend per UTC day, and exposes the gate:

| Method | Who | What it does |
|---|---|---|
| `init` | deployer | Set owner, daily limit, per-tx cap, warn threshold |
| `check` (view) | anyone | Evaluate an action, return `{verdict, reason, checks}` |
| `execute` | the agent | allow → spend recorded, returns `allowed`; warn → parked, returns `request_id`; block → **panics** |
| `approve` / `reject` | owner only | Settle a parked warn request (limits re-checked at approval) |
| `set_limits`, `set_frozen`, `set_warn_bps`, `allowlist_add/remove`, `blocklist_add/remove`, `set_allowed_methods` | owner only | Policy management |
| `get_policy`, `get_spent_today`, `get_request`, `get_log` (views) | anyone | Inspect state and the execution log |

`execute` is an authorisation gate, not a custody wallet: the agent acts
only on an `allowed`/`executed` result — the same pre-flight pattern
tgp-guard enforces off-chain today, now enforced by a contract the agent
cannot argue with.

## Function-call access keys (why a hijacked agent still can't drain you)

The agent's NEAR account should hold **only** a function-call access key:

- scoped to this contract,
- method names limited to `execute,check`,
- with a small NEAR allowance (the key dies when the allowance is spent).

Even a fully prompt-injected agent cannot call the owner methods
(`set_frozen`, `approve`, list edits) with that key — the key itself does
not permit it — and the owner methods additionally require the caller to be
the owner account. The worst a hijacked agent can do is ask the guard to
approve payments, and the guard's policy still applies to every ask.

## Deploy to NEAR testnet (free)

Status: **DEPLOYED 2026-11-04** to `guard.georgeonweb3.testnet` (owner
`georgeonweb3.testnet`), with the full five-scenario demo run live
on-chain — see `DEPLOYMENT.md` for every transaction link and the exact
panic messages. The generic commands below are how it was done; set
`GUARD` to your deployed account (e.g. `nearguard.<yourname>.testnet`).
Two field notes: near-cli-rs 0.30's deploy grammar has no `sign-as`
step (the contract account signs its own deploy), and the guard
sub-account needs ~6 NEAR, not 0.5, because the 551 KB WASM costs
~5.51 NEAR of storage.

```sh
# 1. Create a testnet account (faucet-sponsored, free) and save its key:
near account create-account sponsor-by-faucet-service <yourname>.testnet \
  autogenerate-new-keypair save-to-keychain networkId testnet

# 2. Create a sub-account for the guard and deploy:
near account create-account fund-myself guard.<yourname>.testnet \
  '0.5 NEAR' autogenerate-new-keypair save-to-keychain networkId testnet
near contract deploy guard.<yourname>.testnet use-file build/near-guard.wasm \
  with-init-call init json-args \
  '{"owner":"<yourname>.testnet","daily_limit":"5000000000000000000000000","per_tx_cap":"2000000000000000000000000","warn_bps":8000}' \
  prepaid-gas '100 TeraGas' attached-deposit '0 NEAR' \
  sign-as guard.<yourname>.testnet networkId testnet

# 3. Policy setup (owner):
near contract call-function as-transaction guard.<yourname>.testnet blocklist_add \
  json-args '{"account":"known-scam.testnet"}' prepaid-gas '30 TeraGas' \
  attached-deposit '0 NEAR' sign-as <yourname>.testnet networkId testnet
near contract call-function as-transaction guard.<yourname>.testnet set_allowed_methods \
  json-args '{"methods":["transfer","ft_transfer"]}' prepaid-gas '30 TeraGas' \
  attached-deposit '0 NEAR' sign-as <yourname>.testnet networkId testnet

# 4. Give the agent its scoped key (run on the AGENT's account):
near account add-key agent.<yourname>.testnet <agent-public-key> \
  grant-function-call-access --receiver-account-id guard.<yourname>.testnet \
  --method-names execute,check --allowance '0.25 NEAR' \
  sign-as agent.<yourname>.testnet networkId testnet
```

Then replay the demo on-chain: `check` is a view call
(`near contract call-function as-read-only ... check json-args '{...}'`),
and `execute` calls from the agent key show allows landing in `get_log`,
warns parking until `approve`, and blocks failing the transaction.

## Submission checklist (NEAR HACKATHON, deadline 2026-11-14 23:59 UTC)

Per the official HACKATHON.md (nearhackathon.com/HACKATHON.md), there is
**no registration** — the only form is the one-shot final submission, and
it cannot be edited. Target: submit **Friday 2026-11-13**.

- [x] Deploy to testnet (above) and run the on-chain demo. Done 2026-11-04, see DEPLOYMENT.md.
- [x] Push this repo to a **public** GitHub repository. Done 2026-11-04: https://github.com/georgeonweb3/near-guard
- [x] Record a demo video: the local demo refusing the injection attack, plus the on-chain execute calls. Done 2026-11-04 (73s, 1080p, produced by Muse; posting with the X post below).
      plus the on-chain `execute` calls.
- [x] Publish the demo post on X (human posts it): it must say the project
      was built at NEAR HACKATHON, tag @NEARProtocol and #NEARHackathon,
      and attach the video. Done 2026-11-04: https://x.com/georgebuilding2/status/2117936258848559574
- [x] Prepare a NEAR **mainnet** account address for the payout field
      (a named `*.near` or a 64-character implicit account, created by the
      team lead in any NEAR wallet; nothing needs to be funded).
      Done: implicit account supplied by the team lead 2026-11-04.
- [x] Submit once at https://nearhackathon.com/#apply with: project name,
      team lead name, email, team size `1`, tracks `security` and `agents`,
      payout address, repo link, demo post link, description (20–2000
      chars), and consent — after confirming the exact payload.
      SUBMITTED 2026-11-04: confirmation page read "SUBMISSION RECEIVED /
      You're on the radar!" Results announced 18 Nov 2026.

Draft description for the submission (approve before use):

> AI agents are starting to hold wallets, and a prompt-injected or simply
> mistaken agent can drain one in a single transaction. NearGuard is a
> NEAR smart contract that sits between an agent and its money: the human
> owner sets a daily spend limit, a per-transaction cap, counterparty
> allow/blocklists, permitted methods, and a freeze switch. Before paying,
> the agent must call the guard's execute; the guard returns allow, warn
> (parked for human approval), or block (the call panics and the agent
> cannot proceed). The agent's wallet holds only a function-call access
> key scoped to the guard, so even a hijacked agent cannot change the
> rules. It ports the live tgp-guard/Aegis design to NEAR using
> near-sdk-js, with the full policy engine unit-tested and reproducible
> from the README. Testnet.

Draft demo post (the human posts this; attach the video):

> An AI agent with a wallet is one prompt injection away from sending your
> money to a scammer. I built NearGuard at NEAR HACKATHON: a @NEARProtocol
> contract that checks every agent payment against owner-set limits and
> lists, and refuses to sign on block. Demo below. #NEARHackathon

## License

MIT — see LICENSE.
