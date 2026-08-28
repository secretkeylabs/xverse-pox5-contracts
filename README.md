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

## Early sBTC withdrawal

A live member may release a positive part or all of their currently bonded sBTC
before the bond unlocks:

```clarity
(unstake-sbtc-early (manager <signer-manager-trait>) (sats uint))
```

The call uses `tx-sender` as the member, removes exactly `sats` from PoX-5,
member/pool bonded principal, and live shares, then forwards the returned sBTC
to the same-lane treasury as immediately claimable principal. A partial
withdrawal retains all attributed STX with the residual position. A full
withdrawal leaves the STX locked and marks a non-cancellable exit; rollover or
normal wind-down releases that STX later.

An unconsumed current or stale rollover commitment blocks early withdrawal.
The member must first use `cancel-rollover-commitment` under its existing
current/stale recovery rules. The withdrawal never resizes or bypasses a frozen
full-position snapshot. After partial withdrawal, a later commitment covers the
complete reduced position.

`get-early-unstake-preview(member)` is a one-read position snapshot. It returns
the maximum withdrawable sats, selected reward epoch, banked rewards, and raw
`risk-reward-pot`/`risk-total-shares`. An amount-specific quote uses:

```text
floor(riskRewardPot * requestedSats / riskTotalShares)
```

Only unrecognized rewards currently targeted to the live epoch are at risk;
predecessor-tail rewards remain protected. Do not scale the already-floored
full-position `at-risk-rewards` field. If the final live share would leave while
live-targeted rewards are unrecognized, the call returns `u135`; one successful
permissionless `sync-rewards` consumes that complete snapshot surplus before
retrying. The transactions are not atomic, so a new transfer mined between them
can re-trigger the guard.

If every sat leaves early, `unstake-sbtc` still becomes available only at the
recorded normal unlock. It then finalizes locally, releases aggregate STX, and
skips both PoX-5 and sBTC-token zero-amount calls. A reward or donation arriving
after all shares leave has no member reward weight; `sync-rewards` classifies it
as funded, permanently locked terminal dust without blocking STX wind-down.

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

A prior bond remains the reward target until half of the successor's first
reward cycle has elapsed. That is PoX-5's first possible successor-distribution
boundary. The boundary derives from PoX-5's runtime reward-cycle length rather
than a network constant, and the same predicate controls both reward targeting
and the prior member-share tail.

Live epoch shares may shrink through early withdrawal. Each epoch therefore
maintains `credit-offset` and the invariant:

```text
credited = floor(totalShares * rewardIndex / 1e12) + creditOffset
```

Removing shares rebases only the offset, leaving cumulative epoch/global credit
and every settled member reward unchanged. Later synchronization advances the
reward index through exactly one floor delta, then places every funded surplus
sat not represented by that aggregate index into the offset as permanently
locked residual. The complete current surplus is recognized in one successful
call without advancing across heterogeneous member checkpoint fractions.

Xverse must run a keeper that completes the prior bond's final signer-manager
payout and `sync-rewards` before that half-cycle boundary; members and other
callers remain permissionless fallbacks. If the old payout arrives only after
the boundary, or old and new payouts are co-mingled before one synchronization,
the untagged balance can be credited to current shares. That keeper failure is
an accepted operational risk, not an individual member claim deadline. Once a
payout is synchronized, members may claim their credited rewards later.

The pool intentionally does not distinguish unsolicited sBTC from signer
rewards. Any bare sBTC transferred while the selected epoch has shares is a
donation and is included in the next successful `sync-rewards`. If the selected
epoch has zero shares, the transfer is recognized only as permanently locked
terminal dust. No separate donation ledger, attribution proof, monitoring
requirement, or sweep path is provided.

### Whole-satoshi flooring and locked dust

Reward indices use `PRECISION = 1e12`. Aggregate index representation and every
member settlement floor independently to whole sats. Settlement persists the
new checkpoint even when a fractional entitlement floors to zero. Consequently,
repeated synchronization/settlement, many members, index granularity, and
zero-share transfers can permanently lock multiple recognized sats; there is no
lifetime or pool-wide one-sat bound.

Locked dust remains funded at the staker and is included in
`total-credited - total-paid`, but it is not a realizable member claim,
unrecognized reward, future-bond reward, or sweepable balance. The resulting
reward reserve is conservative: it can exceed the sum of realizable member
claims without affecting principal solvency. This behavior is intentional; the
pool has no fractional carry, redistribution, claim expiry, finalization payout,
or reward sweep.

## Signer callback safety

PoX-5 invokes the configured signer manager while a stake or rollover is still
executing. On a growing rollover, net member sBTC principal has already moved
from the treasury to the staker at that point but PoX-5 has not taken custody
yet. The staker therefore keeps a protocol-transition guard active from before
the first principal movement through completion of PoX-5 and local accounting.

Every public state-changing staker entry point, including early withdrawal,
checks the guard before writing and returns error `u134` when a nested callback
reaches it while the transition is active; Clarity separately rejects direct
same-function recursion. The early PoX-5/token path keeps the guard set through
protocol removal, treasury forwarding, and local completion. Read-only
inspection remains available. A signer manager must not depend on mutating the
pool during `validate-stake!`; failed outer transitions roll the guard and every
asset/counter change back atomically. The intended Xverse signer manager's reviewed validation path only
updates manager-local state and is compatible with this boundary.

The test suite includes an adversarial manager that calls reward, claim,
settlement, ordinary wind-down, and early-withdrawal entry points during
validation, including the exact growing-rollover sequence that would otherwise
recognize temporary principal as rewards.

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

See [SECURITY.md](SECURITY.md) for the complete trust boundary.

## Deliberate exclusions

The suite has no:

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
reward dust, caller contexts, and failure/wind-down isolation. The report check requires complete canonical-equivalent function coverage,
every public cost path, and the eight critical paths on all six lanes, including
`unstake-sbtc-early`.

Local signer managers and caller-context contracts are test fixtures only and
are not production generation inputs. Exact generated hashes and protocol
principals are recorded in `generated/artifact-manifest.json`; deployment
boundaries and exclusions are documented in [DEPLOYMENT.md](DEPLOYMENT.md) and
[SECURITY.md](SECURITY.md).