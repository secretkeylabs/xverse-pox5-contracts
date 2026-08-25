# Canonical review disposition

This matrix closes the twelve observations in planning evidence EVD-011. The
canonical implementation revision is recorded in TASK-010 after all commands in
this document pass and the commit is available from `origin`.

| # | Observation | Disposition | Durable validation |
|---|---|---|---|
| 1 | Signer callback could recognize principal in transit | Fixed by the protocol-transition guard around treasury payout, PoX-5 calls, manager validation, and local accounting. All public mutators reject nested calls with `u134`; rollback clears the guard. | `tests/protocol-transition.test.ts`, including growing rollover, multiple nested mutators, manager rejection, revoked grant, rollback, and retry. |
| 2 | Reward ownership depended on delayed synchronization time | Accepted under DEC-003. The prior epoch remains selected for one complete cycle; Xverse operates the primary keeper and all steps remain permissionless. Failure through the full tail may assign an old payout to current shares. | Timely-tail regression in `tests/sbtc-bond-staker.test.ts`; expired-tail regression in `tests/task010-regressions.test.ts`; README and SECURITY. |
| 3 | Newcomer could not exit after direct cancellation closed | Fixed. `request-exit` first cancels an unconsumed commitment and returns `exit-epoch: none` for a newcomer. | Cutoff and rollback tests in `tests/sbtc-bond-staker.test.ts`. |
| 4 | Late binding could admit post-start commitments | Fixed with exclusive cutoff/start checks, dynamic prepare deadline, and a binding requirement that leaves an executable block. Initial deposits use the same exclusive stake deadline. | Boundary matrix, latest-valid bind, late-bind, deposit-deadline, and prepare-closure tests. |
| 5 | Authority is transitive through `tx-sender` | Accepted under DEC-006. Standard origins and ordinary forwarders retain origin identity; `as-contract?` wallets use the contract principal. Sponsor, relayer, native multisig, and Bitcoin/sBTC multisig boundaries are explicit. | `contracts/test-caller.clar`, caller-context tests, README, and SECURITY. |
| 6 | Independent member flooring can strand credited dust | Accepted under DEC-005. `PRECISION = 1e12`, independent floor, and checkpoint advancement remain unchanged. Recognized dust is permanently inaccessible and non-sweepable. | Repeated half-sat and unequal-share funded-reserve regressions in `tests/task010-regressions.test.ts`; README and Clarity comments. |
| 7 | Source-license treatment was unresolved | Closed by the owner-confirmed TASK-009 disposition and package metadata revision `9c79aeb1f8e7e34355ec8c4cfdfcd2fb76df2f02`; no further license-related repository work was required. | TASK-009 terminal record. |
| 8 | Per-instance validation was incomplete | Fixed with control-path, rollback, caller, missed-bond, flooring, balance-conservation, and deterministic property sequences. Unioned report coverage exercises every canonical Clarity function; test-only exclusions are explicit. | All files under `tests/`, `bun run test:report`, `lcov.info`, and `costs-reports.json`. |
| 9 | Delayed replacement raced permissionless wind-down | Accepted under DEC-006. Ordering is explicit and always preserves principal recovery; repeated binding cannot delay release. | Both transaction orderings and repeated-miss regression in `tests/task010-regressions.test.ts`; README and SECURITY. |
| 10 | Queued-principal and reward documentation was inaccurate | Fixed. Queued assets are distinguished from released claimable principal; aggregate reward remainder is distinguished from persisted member-flooring dust. | README, SECURITY, and canonical source comments. |
| 11 | Static analysis passed with warnings | Accepted residual warnings are individually justified below. No warning grants authority or weakens an asset invariant. | `bun run check` output and warning table below. |
| 12 | Completion evidence was not remotely durable | Closed only when TASK-010's validated full commit is pushed and recorded in the planning task. No lane generation precedes that pin. | Remote commit URL and TASK-010 `Implementation revisions`. |

No observation remains undispositioned. Findings 2, 5, 6, and 9 are explicit
accepted policies or residual risks rather than hidden implementation defects.

## Production signer-manager pin

TASK-010 fetched immutable `secretkeylabs/pool-contracts` revision
`2e6e418c9918af0366cc5640fb281c1419c20e04` and re-hashed the canonical source
and all three generated mainnet artifacts. The source SHA-256 remains
`f86819132e5c4e6f00d491b27f32ded4c3342c2be875ff90d1eba70fd5f0a5cf`; each
mainnet artifact remains
`c0a2cc8e83de2b1bc60e07c5e0f5da8991c6f79eb05d077bba8cb984eee226b3`.
No private source is copied into this repository.

## Static-analysis warning disposition

Clarinet warning text can repeat when one fixture source is deployed under more
than one contract name. Each distinct warning has the following narrow reason:

| Location | Warning | Disposition |
|---|---|---|
| `sbtc-bond-staker.clar:initialize` | `pool-operator` is potentially unchecked data | Accepted. The deployer deliberately selects any standard or contract principal as an operator map key. The value does not direct an asset transfer. |
| `sbtc-bond-staker.clar:claim-rewards` and `claim-principal` | caller-supplied `member` used as a map key, computed value, and payment recipient | Accepted. Both operations are permissionless pay-to-member: settlement is computed from that member's stored record and all sBTC/STX is transferred to the same principal, never the caller. Clarinet may report the key, value, and recipient expressions separately. |
| `sbtc-bond-staker.clar:settle-member` | caller-supplied `member` and computed record written | Accepted. The deterministic record is derived solely from existing maps and epochs and moves no assets. Arbitrary callers cannot supply record fields. |
| `sbtc-bond-staker.clar:get-sbtc-balance` | `unwrap-panic` | Accepted dependency invariant. The pinned sBTC token's `get-balance` read is infallible for a principal; aborting prevents accounting from proceeding on an incompatible token response. |
| `sbtc-bond-staker.clar:advance-epoch` | `unwrap-panic` on next epoch | Accepted internal invariant. `is-epoch-ended` is true only when that exact next epoch map entry exists. An abort is safer than fabricating financial state if storage were inconsistent. |
| `sbtc-bond-treasury.clar:get-balance` | `unwrap-panic` | Accepted dependency invariant identical to the staker balance read. |
| `test-signer-manager-callback.clar:set-callback-target` | target is potentially unchecked | Test-only. The target is recorded only to attempt adversarial pay-to-member callbacks and is not a production authority. |
| signer-manager trait fixtures | `validate-stake!` naming note | Required by the PoX-5 trait; the exclamation mark cannot be renamed locally. |

The accepting signer fixture narrowly suppresses `unnecessary_public` because
PoX-5's state-changing signer-manager trait requires a public function even
though that fixture's accepting implementation has no local write.

## Validation commands

```bash
bun run check
bun run test
bun run test:report
clarinet format --check
git diff --check
git status --short
```

The final pre-commit run passed 59/59 tests across four files. Coverage is
evaluated as the union of isolated Vitest cases because Clarinet emits one LCOV
record per simnet reset; the canonical treasury/staker union reached 62/62
functions. The largest observed cost fraction was 5.8133% of the read-count
limit (`update-bond-registration`). Clarinet reported nine accepted warnings
covered by the table above. Every retained public financial/control path is
exercised directly or through a public operation that invokes it.
