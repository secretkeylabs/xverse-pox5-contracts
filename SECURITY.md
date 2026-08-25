# Security and trust model

This document describes the canonical single-lane contract. Six-lane isolation
is generated and validated separately.

## Assets and accounting boundaries

- PoX-5 holds live bonded sBTC and locks the staker principal's bonded STX.
- The paired treasury holds exactly accounted queued and released sBTC plus any
  separately measurable mistaken direct transfer.
- The staker's liquid sBTC is reward balance, never principal during a completed
  transaction.
- `total-credited - total-paid` is a funded, conservative reward reserve. It may
  include permanently inaccessible member-flooring dust.
- The treasury accepts payouts only from its paired staker. Operators and signer
  managers have no direct principal withdrawal path.

The test suite checks these relationships after deposits, withdrawals,
commitments, cancellation, staking, rollover, reward settlement, claims, and
wind-down.

## Authorities

The deployer initializes once. Keyed operators may bind a configured PoX-5 bond,
rotate the operator set, maintain the trusted signer-code-hash set, update a live
registration to a manager whose notice has matured, and sweep only treasury
sBTC above accounted principal. Operators cannot select claim recipients for
member principal or rewards.

Staking, wind-down, synchronization, settlement, and pay-to-member claims are
permissionless. Permissionless callers progress deterministic state or pay the
recorded member; they cannot redirect member assets.

All member and authority identity uses `tx-sender`. Ordinary forwarding retains
the transaction origin's authority for that transaction. `as-contract?` changes
the effective sender and makes the contract principal the position or operator
owner. A sponsor is only a fee payer. A direct relayer has no signature-based
authority unless the relayer itself is the effective sender authorized by the
contract. Native Stacks multisig acts as its consensus-derived standard
principal; Bitcoin and sBTC signer multisig are unrelated to this identity.

## External dependencies

- The Stacks PoX-5 boot contract defines bond terms, allowances, timing, signer
  registration, custody, and release.
- The configured signer manager validates PoX-5 transitions and pays rewards.
  Production compatibility is pinned in the README; deployment review must
  verify the selected principal's code.
- The canonical sBTC token contract performs principal and reward transfers.

A failing external call rolls the complete Clarity transaction back.

## Accepted residual risks

### Signer-manager callbacks

PoX-5 may call the configured manager while principal is temporarily in transit.
Every public pool mutator rejects during that transition with `u134`. Read-only
observation remains possible. A manager may reject and roll back the outer
operation, but cannot persist a nested pool mutation.

### Reward keeper outage

PoX-5 calculation, manager claims, per-staker payout, and pool synchronization
all require submitted transactions. Xverse is the primary keeper and arbitrary
callers are fallbacks. The old epoch remains the reward target for one complete
cycle after its successor starts. If all callers neglect the flow through that
tail, an old payout may be assigned to current shares.

### Whole-satoshi flooring

Each settlement floors independently and advances its checkpoint. Repeated
settlements can permanently lock recognized sats. Locked dust is funded but
cannot be claimed, redistributed, rolled into a future epoch, or swept.

### Missed seamless replacement

After the old bond unlocks, permissionless wind-down takes priority over any
pending delayed replacement. Delayed `stake` first continues the pool;
`unstake-sbtc` first finishes it. Added commitment assets remain recoverable.
There is no grace period or operator veto.

### Unsolicited transfers

Bare sBTC sent to the staker is an intentional reward donation. sBTC sent
straight to the treasury is not attributed to a member and may be swept by an
operator only to the extent it exceeds queued and released principal.

### Forwarding contracts

An ordinary forwarding contract called by an authorized origin receives no
persistent delegation, but can make nested pool calls with that origin's
`tx-sender` during the transaction. Users must understand and trust contracts
they invoke.

## Deployment boundary

`contracts/sbtc-bond-staker.clar` and
`contracts/sbtc-bond-treasury.clar` are the only canonical production generation
inputs. Contracts prefixed `test-` and `deployments/default.simnet-plan.yaml` are
simnet-only. No lane artifact should be generated from a revision older than the
validated TASK-010 commit.
