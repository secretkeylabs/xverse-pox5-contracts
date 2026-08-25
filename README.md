# Xverse PoX-5 Contracts

Clarity contracts for Xverse pooled sBTC participation in PoX-5 protocol
bonds.

## TASK-001 scope

The current canonical implementation is the lane-0 development pair:

- `sbtc-bond-treasury-0` — holds queued and released member sBTC principal;
- `sbtc-bond-staker-0` — deposits, full-position rollover commitments, epochs,
  rewards, exits, claims, operators, and PoX-5 registration.

The source files omit a lane suffix so they remain the canonical files reviewed
and transformed by the six-lane generator planned in TASK-002:

- `contracts/sbtc-bond-treasury.clar`
- `contracts/sbtc-bond-staker.clar`

The deployed contract names are externally significant. TASK-002 will generate
six isolated pairs whose staker principals are:

```text
<Xverse>.sbtc-bond-staker-0
<Xverse>.sbtc-bond-staker-1
<Xverse>.sbtc-bond-staker-2
<Xverse>.sbtc-bond-staker-3
<Xverse>.sbtc-bond-staker-4
<Xverse>.sbtc-bond-staker-5
```

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

## Deliberate exclusions

The suite has no:

- L1 Bitcoin bridge or BTC-address withdrawal;
- Esbee DAO contract;
- generic STX-only top-up;
- passive or partial rollover;
- sponsorship;
- cross-lane balance or aggregate receipt.

Users enter and leave using sBTC and STX on Stacks. Operator and signer-manager
controls cannot move accounted member principal.

## Development

Requirements:

- Clarinet 3.23.1 or newer
- Bun 1.4.0 or newer

```bash
bun install
bun run check
bun run test
bun run test:report
```

The tests use the real simnet PoX-5 contract and sBTC protocol contracts. The
local signer manager is a test fixture only.

## Provenance

The treasury and staker are adapted from the ISC-declared
`fastpool/sbtc-pool-bond-staker` project at revision
`d8406b725b231d899dfad4d92393422559cd0eda`. See [NOTICE.md](NOTICE.md).
