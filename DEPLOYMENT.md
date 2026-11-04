# NearGuard - Testnet Deployment Record

Deployed 2026-11-04. All transactions on NEAR testnet, all amounts test NEAR.

## Accounts
- Owner / agent operator: `georgeonweb3.testnet` (created via faucet sponsor, 10 test NEAR grant)
  - Creation tx: https://explorer.testnet.near.org/transactions/9fa1Bqr44VKmCvy7AStYQVPJbEp9YMyFHjcAjqhsboQi
- Guard contract account: `guard.georgeonweb3.testnet` (sub-account, funded 6 NEAR)
  - Creation tx: https://explorer.testnet.near.org/transactions/9rYrYrZVJGLeTjYr39yPgEVUNemNHd3VtwDZasxh6vWf

## Contract
- WASM: `build/near-guard.wasm` (551,287 bytes, built with `npm run build`;
  not committed to git, reproducible from source)
  SHA-256: `314451125da10e08123a9779ea3ee365ac4d1f48b1b6a1a50dce8cbbba48ea76`
- Deploy + init tx: https://explorer.testnet.near.org/transactions/4uPiBYb9mxEr6CsEZ4DWpqaNWYYVygccdmna774RUUUT
- Init args: owner `georgeonweb3.testnet`, daily limit 5 NEAR, per-tx cap 2 NEAR, warn threshold 80% (warn_bps 8000)
- `get_policy` read-back confirmed all values on-chain.

## Policy setup (owner transactions)
- `blocklist_add` known-scam.testnet: https://explorer.testnet.near.org/transactions/AxtEWRjh29DwHoa52o6toatu49d7T5jLaj3uHRYXqRh3
- `set_allowed_methods` [transfer, ft_transfer]: https://explorer.testnet.near.org/transactions/GVxvpofNXTr9Bu6AJbdVMPZQXcTwVoqeNH5FMeXXQPr1
- `allowlist_add` helper.testnet: https://explorer.testnet.near.org/transactions/F8CU6zocqdDa16X9stjcGbTPQz9vFZvka3Jc5x8rEPnm

## On-chain demo (all five scenarios, live)
1. **Clean ALLOW** - `check` view returned allow on every sub-check; `execute` 0.5 NEAR to helper.testnet returned `{"status":"allowed"}`:
   https://explorer.testnet.near.org/transactions/BscwCRwVYGZS2hu7bEKdP5EgxWjy1Hv14iMwUDZPPcpx
2. **Over-cap BLOCK** - `execute` 3 NEAR to helper.testnet FAILED with panic:
   `BLOCKED: amount 3000000000000000000000000 exceeds the per-transaction cap 2000000000000000000000000`
3. **Blocklist BLOCK (prompt-injection case)** - `execute` 0.1 NEAR to known-scam.testnet FAILED with panic:
   `BLOCKED: counterparty known-scam.testnet is on the blocklist (known-bad)`
4. **WARN then owner approve** - `execute` 0.1 NEAR to newvendor.testnet (not on allowlist) returned `{"request_id":0,"status":"warn"}`:
   https://explorer.testnet.near.org/transactions/7a7ZnjSDJ2Gu2T6wyFVaWDteWKz9K4NdyiTgDdM5q6Mp
   Owner `approve` request 0 returned `{"status":"executed","spent_today":"600000000000000000000000"}`:
   https://explorer.testnet.near.org/transactions/5NsMetaM5rnH519GmpZKFeWSKJ8e5U9aoUr98QDaDSc2
5. **Freeze BLOCK, then unfreeze** - owner `set_frozen(true)`:
   https://explorer.testnet.near.org/transactions/9cfVjTisV3Grw1quwjhgfSvaVGSxRnhoVJpQRHApPpkp
   `execute` while frozen FAILED with panic: `BLOCKED: guard is frozen by the owner; all agent actions are refused`
   Owner `set_frozen(false)`:
   https://explorer.testnet.near.org/transactions/BU6awjAXdy2G8SNCuvszvYFdY1dH2bmaTUqxQhLXBo1M

Final state check: `get_spent_today` = 0.6 NEAR (0.5 clean + 0.1 approved warn), guard unfrozen.

## Tooling note
Deployed with near-cli-rs 0.30.1. Note the 0.30 deploy grammar has no
`sign-as` step: the contract account signs its own deploy via
`network-config testnet sign-with-legacy-keychain send`. The guard
sub-account was funded with 6 NEAR (not 0.5) because the 551 KB WASM
needs ~5.51 NEAR of storage at 0.00001 NEAR per byte.
