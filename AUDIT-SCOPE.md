# Audit scope: Xverse PoX-5 six-lane suite

## Candidate boundary

The exact implementation candidate validated by TASK-003 is repository revision
[`a9dc1178ca8f079464cbb3b71e86e3b92afb6a6a`](https://github.com/secretkeylabs/xverse-pox5-contracts/commit/a9dc1178ca8f079464cbb3b71e86e3b92afb6a6a).
It contains the generated artifacts from TASK-002 revision
`89eacf8b140f0f640401c18a0cd7aa8975db726e` without production Clarity or
generator changes. TASK-003 added only tests, test-only caller functions,
report checks, package commands, and documentation.

The independent reviewer should treat these as one security boundary:

1. canonical accounting source;
2. bounded deterministic generator;
3. twelve mainnet generated contracts;
4. PoX-5, sBTC token, and signer-manager call assumptions; and
5. the accepted authority, liveness, reward-attribution, and reward-flooring
   residuals documented below.

## Canonical source and generator pins

| Input | SHA-256 |
|---|---|
| `contracts/sbtc-bond-staker.clar` | `767c5bcba17d1b4d1f263c6a04d7ca82e75b1834385137d2cf78af79468d6691` |
| `contracts/sbtc-bond-treasury.clar` | `ce4b5a4df371b2395ae9a9154f2cb690e4e87277553d002fef0ecdb5ce4e665c` |
| `scripts/generate.ts` | `da0eedeecbeb64cbabf49530aa558cc81bafc26ff64815485655585b7baa684b` |
| `generated/artifact-manifest.json` | `4894bbebca1ff4679f46a22e75e96619b06321cedb1d82b02cbd6681810be119` |

Every generated header pins reviewed canonical revision
`1c40228765dabbcaa47809183d3cf17e9d498c20` and the applicable canonical
source hash. `bun run check:generated` independently renders all 36 network
artifacts and rejects drift, undeclared substitutions, wrong-network protocol
principals, incomplete lane/network sets, duplicate names, cross-lane sibling
references, unexpected files, and unresolved Clarity placeholders.

## Mainnet artifact set

Deployment by one Xverse standard principal produces the following twelve
externally significant contract principals. The complete manifest also pins the
simnet and testnet derivatives.

| Lane | Contract name | Mainnet artifact SHA-256 |
|---:|---|---|
| 0 | `sbtc-bond-treasury-0` | `ebe9a1e2ee62944b1de4d4da612e20709d64b9485d650b930252b6745f9b7a7e` |
| 0 | `sbtc-bond-staker-0` | `126bc0f683f9023b254247962e559a5e7e501ca190d6494785960ecceb197c00` |
| 1 | `sbtc-bond-treasury-1` | `ae21718b05af65ab6ddab6c7685a73bfbdca1402afef8722f019855857b44044` |
| 1 | `sbtc-bond-staker-1` | `ddb530dc418b87caca5949beb4d3e1f23ec470b85dceeb7b573ff6eaf4aafa49` |
| 2 | `sbtc-bond-treasury-2` | `56bb4bcc346a52de9c3e6fbb35ae60f6f205d87e7b204bb2878c12f0c015e777` |
| 2 | `sbtc-bond-staker-2` | `55748586cc27cd2887da152ee6425816a2f3e1dd77bc9db83d2bb54985cf58cf` |
| 3 | `sbtc-bond-treasury-3` | `6d809377faf18008f9b5871e23ded419819f83034bae9ad7510e220934a444da` |
| 3 | `sbtc-bond-staker-3` | `df618f9434ad60cfd6c63bbdac4e088d94d50253cc1843a4b63d667698ed18a1` |
| 4 | `sbtc-bond-treasury-4` | `c31e2e4015b8133094812f8a49472ef0dbdb5445d9d900e66dd0440382a4b9f3` |
| 4 | `sbtc-bond-staker-4` | `bc8195e21ab559a537b61c2a3a5e57e201d33a028ccd314cfbc428b00e86a471` |
| 5 | `sbtc-bond-treasury-5` | `17acac7eebeb224adac020ad97a49bcae166e14c67d38edbfb7dc6a2595ed027` |
| 5 | `sbtc-bond-staker-5` | `02ecd2e3df60bdade2f1431b479fdf8a83950bf611da6919b00e8195bc4010c7` |

The mainnet static protocol references are:

- PoX-5: `SP000000000000000000002Q6VF78.pox-5`;
- sBTC token: `SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token`; and
- same-lane sibling contracts under the publishing Xverse principal.

## Protocol and signer dependencies

- PoX-5 behavior is pinned to Stacks Core revision
  `a7e3e76019d911aef9bd6f8dbde0da81517a3b45`; the inspected
  `stackslib/src/chainstate/stacks/boot/pox-5.clar` SHA-256 is
  `ffad35ad181d85832ebd7b998f445204c92d5cd19549166e644fb1f3988fa385`.
- The intended signer-manager source is pinned to `secretkeylabs/pool-contracts`
  revision `2e6e418c9918af0366cc5640fb281c1419c20e04`; canonical source SHA-256
  `f86819132e5c4e6f00d491b27f32ded4c3342c2be875ff90d1eba70fd5f0a5cf`;
  generated artifact SHA-256
  `c0a2cc8e83de2b1bc60e07c5e0f5da8991c6f79eb05d077bba8cb984eee226b3`.
- The signer manager used at deployment must be registered with PoX-5 and must
  match the reviewed validation behavior. A principal match without a code
  match is insufficient.
- Simnet integration uses Clarinet's real epoch-4.0 PoX-5 boot contract and the
  configured sBTC protocol requirement, not a pool-specific PoX mock.

## Security properties in scope

Review should establish, independently of the test claims:

- one dedicated treasury/controller pair per lane with no bridge authority;
- `bond-index mod 6` enforcement and same-principal `N -> N+6` continuity;
- PoX-5 net sBTC movement and STX lock resizing;
- full-position commitments, FCFS capacity, cancellation, exit, stale recovery,
  and all-or-nothing settlement;
- lane-local members, commitments, shares, principal liabilities, reward
  liabilities, signer/operator state, and unattributed balances;
- current/prior epoch reward attribution and the one-cycle tail;
- inherited whole-sat flooring and funded but permanently inaccessible dust;
- permissionless settlement, claims, reward synchronization, rollover, and
  wind-down;
- callback rollback and `protocol-transition-active` protection; and
- effective-origin `tx-sender` behavior for direct, forwarded, sponsored, and
  `as-contract?` callers.

## Accepted residuals, not proposed fixes

- Prompt permissionless reward payout and synchronization are operational
  requirements. A keeper outage through the complete attribution tail can
  assign an old payout to current shares.
- Unsolicited bare sBTC at a staker is a reward donation.
- Independent member flooring can accumulate multiple sats of recognized,
  permanently locked reward dust. There is no carry, redistribution,
  finalization, expiration, or sweep.
- Ordinary forwarding contracts receive transaction-scoped origin authority.
- After a missed seamless successor, permissionless wind-down may preempt a
  delayed replacement. Principal release takes priority over continuity.
- Clarinet's accepted warning classes are unchecked-input taint reports at
  intended map/write boundaries and deliberate `unwrap-panic` use at invariant
  or known SIP-010 boundaries. See `REVIEW-DISPOSITION.md`.

## Explicit exclusions

The candidate does not include and this review need not assess:

- production deployment execution, private keys, fees, or transaction signing;
- PoX-5 bond selection, allowance amounts, allowlist administration, or keeper
  infrastructure;
- Xverse frontend, wallet UX, external sBTC mint/redemption, or monitoring;
- an L1 bridge, Bitcoin-address payout, DAO, cross-lane router, aggregate
  receipt, passive rollover, or partial rollover; or
- unrelated test fixtures as deployable contracts. Contracts named `test-*`,
  `tests/`, and validation scripts are assurance tooling only.

Any production Clarity, generator, protocol dependency, signer-manager, static
principal, contract name, or generated hash change creates a new audit
candidate and requires regeneration plus complete revalidation.
