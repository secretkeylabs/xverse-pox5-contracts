# Xverse PoX-5 Contracts

Clarity contracts for Xverse pooled sBTC participation in PoX-5 protocol
bonds.

## Canonical scope

The reviewed canonical implementation is the lane-0 development pair:

- `sbtc-bond-treasury-0` — holds queued and released member sBTC principal;
- `sbtc-bond-staker-0` — deposits, full-position rollover commitments, epochs,
  rewards, exits, claims, operators, and PoX-5 registration.

The source files omit a lane suffix so they remain the only canonical
production inputs reviewed and transformed by the deterministic six-lane
generator:

- `contracts/sbtc-bond-treasury.clar`
- `contracts/sbtc-bond-staker.clar`

`bun run generate` emits byte-pinned simnet, testnet, and mainnet variants under
`contracts/generated/`. Generated files must not be edited directly;
`bun run check:generated` rejects drift and invalid lane, sibling, placeholder,
or protocol-principal output. Canonical source and artifact hashes are recorded
in `generated/artifact-manifest.json`.

The deployed contract names are externally significant. The six isolated
staker principals are:

```text
<Xverse>.sbtc-bond-staker-0
<Xverse>.sbtc-bond-staker-1
<Xverse>.sbtc-bond-staker-2
<Xverse>.sbtc-bond-staker-3
<Xverse>.sbtc-bond-staker-4
<Xverse>.sbtc-bond-staker-5
```

Every lane has a dedicated `sbtc-bond-treasury-X`, references only that sibling,
and accepts only bond indexes where `index mod 6 = X`. See
[DEPLOYMENT.md](DEPLOYMENT.md) for exact principal forms, network protocol
principals, non-broadcast deployment inputs, ordering, and PoX-5 allowlist
requirements.

## Accounting model

The first bond accepts ordinary sBTC deposits and automatically collects its
required STX. Every later bond requires a member transaction:

```clarity
(commit-rollover (additional-sats uint))
```

A commitment reserves the member's complete existing position plus any added
sats. It uses all STX already attributed to that member and collects a
shortfall when the next bond requires more. Reservations consume the next
bond's allowance first-come-first-served.

At rollover:

- committed members carry their complete target and receive one share per sat;
- members without a commitment receive no next-epoch shares and have all old
  sBTC and STX principal released;
- excess STX belonging to a committed member remains carried and member-owned;
- prior-epoch and delayed final-cycle rewards remain claimable under the old
  epoch's shares.

There is no proportional best-effort rollover or partial commitment.

## Commitment timing and principal recovery

The commitment cutoff is the later of the configured stake-window opening and
the end of the binding notice period. Commitments require a burn height
strictly below that cutoff. Direct cancellation has the same cutoff while the
bond remains stakeable, but reopens if the bond becomes unstakeable; stale
commitments are also cancellable. A bond binding is rejected unless its cutoff
leaves at least one executable block before PoX-5's prepare phase freezes the
target cycle. `get-bound-bond` exposes that exclusive limit as
`stake-closes-at`, and `stakeable` becomes false when it is reached. Initial
deposits close at that limit, while previously queued initial principal remains
withdrawable.

Before the cutoff, `cancel-rollover-commitment` refunds the sBTC and STX added
by a commitment and releases its complete allowance reservation. After direct
cancellation closes, `request-exit` remains the full opt-out path until a
successful stake consumes the commitment:

- for an incumbent, it refunds additions, cancels the reservation, and marks
  the old bonded position for release;
- for a newcomer with no old bonded position, it refunds the complete queued
  contribution and returns `exit-epoch: none` without creating an exit
  liability.

The `request-exit` response and event expose `exit-epoch` as `(optional uint)`:
`some` identifies the incumbent epoch marked for release, while `none` means
newcomer recovery created no exit liability. Clients must decode both forms.

The `queued-sats` and `queued-ustx` fields returned by
`get-claimable-principal` describe assets supplied for a pending bond; they are
not paid by `claim-principal`. Initial queues use `withdraw`. Live rollover
queues use direct commitment cancellation before the cutoff, `request-exit`
before successful stake, or cancellation after the bond becomes unstakeable.
Only `released-sats` and `released-ustx` are immediately payable through
`claim-principal`.

### Missed bonds and delayed replacement

A replacement after a missed seamless bond is best-effort. Once the old live
bond unlocks, permissionless `unstake-sbtc` remains available even if a delayed
bond has been bound and members have committed to it. Transaction ordering is
decisive:

- if delayed `stake` succeeds first, the pool continues in that bond;
- if `unstake-sbtc` succeeds first, the pool finishes permanently, old
  principal is released, and commitment additions remain cancellable.

There is deliberately no replacement grace period, operator veto, commitment
threshold, or pending-binding priority. Repeated late bindings cannot postpone
the old position's permissionless release. This prioritizes bounded principal
recovery over delayed continuity.

## Reward synchronization

The intended signer manager exposes permissionless aggregate and per-staker
reward claims. Because this pool registers without a Bitcoin reward address,
its per-staker payout arrives as sBTC at the staker contract. `sync-rewards` is
also permissionless and credits every sBTC sat above existing reward liabilities
to the oldest bond accounting period still accepting rewards.

A prior bond remains the reward target for one complete reward cycle after its
successor starts, covering PoX-5's delayed final-cycle payout. Xverse should run
a keeper that claims the signer-manager payout and calls `sync-rewards`
promptly; members and other callers remain permissionless fallbacks. If no one
completes those calls before the prior period's tail closes, its payout can be
credited to the current bond's shares. That extended keeper failure is an
accepted operational risk, not an individual member claim deadline. Once a
payout is synchronized, members may claim their credited rewards later.

The pool intentionally does not distinguish unsolicited sBTC from signer
rewards. Any bare sBTC transferred to the staker is a donation and is allocated
on the next successful `sync-rewards`. No separate donation ledger, attribution
proof, monitoring requirement, or sweep path is provided.

### Whole-satoshi flooring and locked dust

Reward indices use `PRECISION = 1e12`. Aggregate synchronization and every
member settlement floor independently to whole sats. Settlement persists the
new checkpoint even when a fractional entitlement floors to zero. Consequently,
repeated settlements and many members can permanently lock multiple recognized
sats; there is no lifetime or pool-wide one-sat bound.

Locked dust remains funded at the staker and is included in
`total-credited - total-paid`, but it is not a realizable member claim,
unrecognized reward, future-bond reward, or sweepable balance. The resulting
reward reserve is conservative: it can exceed the sum of realizable member
claims without affecting principal solvency. This inherited behavior is
intentional; the pool has no fractional carry, redistribution, claim expiry,
finalization, or reward sweep.

## Signer callback safety

PoX-5 invokes the configured signer manager while a stake or rollover is still
executing. On a growing rollover, net member sBTC principal has already moved
from the treasury to the staker at that point but PoX-5 has not taken custody
yet. The staker therefore keeps a protocol-transition guard active from before
the first principal movement through completion of PoX-5 and local accounting.

Every public state-changing staker entry point checks the guard before writing
and returns error `u134` when a nested callback reaches it while the transition
is active; Clarity separately rejects direct same-function recursion. Read-only
inspection remains available. A signer manager must not depend on mutating the
pool during `validate-stake!`;
failed outer transitions roll the guard and every asset/counter change back
atomically. The intended Xverse signer manager's reviewed validation path only
updates manager-local state and is compatible with this boundary.

The test suite includes an adversarial manager that calls reward, claim,
settlement, and protocol entry points during validation, including the exact
growing-rollover sequence that would otherwise recognize temporary principal
as rewards.

The production compatibility pin is `secretkeylabs/pool-contracts` revision
`2e6e418c9918af0366cc5640fb281c1419c20e04`. Its three generated mainnet signer
manager artifacts are byte-identical with SHA-256
`c0a2cc8e83de2b1bc60e07c5e0f5da8991c6f79eb05d077bba8cb984eee226b3`.
The canonical pre-generation source hash is
`f86819132e5c4e6f00d491b27f32ded4c3342c2be875ff90d1eba70fd5f0a5cf`.
Deployment review must select a principal whose code matches that artifact.

## Caller and authority semantics

Member, deployer, and operator checks intentionally use `tx-sender`:

- direct standard origins act as themselves;
- consensus-valid sequential or order-independent P2SH/P2WSH multisig origins,
  including MPC/TSS-controlled accounts, act as their resulting standard
  principal;
- in sponsored transactions, the origin has authority and the sponsor only
  pays fees;
- an ordinary forwarding contract preserves the origin as `tx-sender` and can
  exercise any pool operation currently available to that origin during the
  transaction; no persistent delegate is created;
- a contract wallet owns a position or operator seat only when it calls under
  `as-contract?`, which makes the contract principal the effective sender;
- a direct relayer has no authority from an off-chain signature the pool does
  not verify. Permissionless pay-to-member claims remain relayable because
  assets always go to the recorded member.

Bitcoin multisig and the sBTC signer threshold are separate systems and do not
create a Stacks member or operator identity. Contract-level support does not
guarantee every wallet frontend can construct each transaction form. Users
must treat an ordinary forwarding contract as transaction-scoped authority to
use their currently available pool operations.

See [SECURITY.md](SECURITY.md) for the complete trust boundary and
[REVIEW-DISPOSITION.md](REVIEW-DISPOSITION.md) for the canonical review matrix.

## Deliberate exclusions

The suite has no:

- L1 Bitcoin bridge or BTC-address withdrawal;
- Esbee DAO contract;
- generic STX-only top-up;
- passive or partial rollover;
- contract-specific sponsorship or delegated-caller state;
- cross-lane balance or aggregate receipt.

Users enter and leave using sBTC and STX on Stacks. Operator and signer-manager
controls cannot move accounted member principal.

## Development

Requirements:

- Clarinet 3.23.1 or newer
- Bun 1.4.0 or newer

```bash
bun install
bun run generate
bun run check:generated
bun run check
bun run test
bun run test:lanes
bun run simulate:rollover
bun run test:report
bun run check:format
# or run all non-mutating checks after generation:
bun run validate
```

A clean regeneration is byte-identical:

```bash
bun run generate
git diff --exit-code -- contracts Clarinet.toml generated deployments/default.simnet-plan.yaml
```

The tests use the real simnet PoX-5 contract and sBTC protocol contracts. The
six-lane suite exercises concurrent memberships, every `N -> N+6` rollover,
exhaustive modulo-lane rejection, treasury authority, lane-local liabilities,
reward dust, caller contexts, and failure/wind-down isolation. The report check
requires 67/67 canonical-equivalent functions, all 20 public cost paths, and 42
critical per-lane cost paths.

Local signer managers and caller-context contracts are test fixtures only and
are not production generation inputs. See [AUDIT-SCOPE.md](AUDIT-SCOPE.md) for
the exact reviewed inputs, generated mainnet hashes, protocol pins, exclusions,
and validation revision.

## Provenance

The treasury and staker are adapted from the ISC-declared
`fastpool/sbtc-pool-bond-staker` project at revision
`d8406b725b231d899dfad4d92393422559cd0eda`. See [NOTICE.md](NOTICE.md).

## License

This repository is licensed under the [MIT License](LICENSE). Third-party
provenance is recorded in [NOTICE.md](NOTICE.md).
