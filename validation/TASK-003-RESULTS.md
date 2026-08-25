# TASK-003 six-lane validation results

## Validated revision

`a9dc1178ca8f079464cbb3b71e86e3b92afb6a6a`

This revision retained the canonical production source, generator, manifest,
and all generated artifacts byte-for-byte from TASK-002. It added validation
code and test-only caller probes. The worktree was clean when the candidate
validation completed.

## Commands and results

Run from the repository root:

| Command | Result |
|---|---|
| `bun run generate` | Regenerated 36 artifacts; no worktree difference |
| `bun run check:generated` | Verified 36 artifacts |
| `bun run check` | 17 contracts checked; type checking passed |
| `bun run test` | 7 files, 98/98 tests passed |
| `bun run test:report` | 7 files, 98/98 tests; all report gates passed |
| `bun run test:lanes` | 3 files, 39/39 lane tests passed |
| `bun run simulate:rollover` | 1/1 six-lane real-simnet rollover simulation passed |
| `bun run check:format` | All Clarity files properly formatted |
| `git diff --check` | Passed |

`bun run validate` executes that complete non-broadcast sequence. The observed
Clarinet warnings belonged only to the two previously dispositioned classes:
unchecked-input taint at intended public/map boundaries and deliberate
`unwrap-panic` invariant/SIP-010 boundaries. Loading generated copies repeats
those accepted classes and introduced no new warning class.

## Coverage and cost gates

`bun scripts/check-validation-reports.ts` consumes Clarinet's generated
`lcov.info` and `costs-reports.json` and fails unless the report satisfies all
of the following:

- canonical-equivalent treasury/staker functions: **67/67**;
- public production cost paths: **20/20**;
- critical paths observed independently in all six lanes: **42/42**; and
- every observed execution-cost dimension remains below its protocol limit.

The maximum observed fraction was **5.8133%** of the read-count limit in
`sbtc-bond-staker-0.update-bond-registration`. The raw Clarinet reports are
reproducible generated files and intentionally ignored; this result, the report
checker, and the exact candidate revision are committed durable output.

## Six-lane findings

The tests established:

- Six distinct staker principals simultaneously held bonds 6 through 11. Bond
  6 remained live when bond 11 registered, proving actual overlapping PoX-5
  memberships rather than sequential replacement.
- Every lane dynamically accepted valid representatives `X+6`, `X+12`, and
  `X+18`; for each target, all five non-congruent generated stakers returned
  `ERR_WRONG_LANE` (`u132`). This is the executable future-window equivalent of
  the lane sequence `X`, `X+6`, `X+12`; historical simnet bonds 0 through 5 are
  already outside setup windows.
- Every lane rolled its same contract principal from `N` to `N+6`. Membership
  sats, PoX-5 net sBTC transfer, STX amount, epoch shares, and treasury balance
  matched the expected resized position.
- The six generated treasury controllers formed a one-to-one matrix. Every
  off-controller dynamic probe returned `ERR_UNAUTHORIZED` (`u200`), and
  generated-reference checks proved no staker contains a cross-lane treasury
  path.
- One wallet held independent positions in all six lanes. Additional sats,
  commitments, shares, signer state, and membership updates remained local.
- Per-lane queued/released principal stayed within that lane's treasury;
  bonded sats matched that lane's PoX-5 membership; and funded reward reserve
  stayed within that lane's staker reward balance.
- Two repeated half-sat settlements in each of all six lanes produced two sats
  of lane-local recognized locked dust, zero claims, and no redistribution or
  cross-lane sweep.
- FCFS capacity exhaustion, failed commitment rollback, cancellation and reuse,
  exit cancellation, delayed prior-epoch rewards, principal/reward claims, and
  over-collateralized STX carry remained isolated between generated lanes.
- Rotating lane 0 to a second registered signer manager did not alter the other
  five memberships or configurations.
- Permissionless wind-down preempted lane 0's delayed replacement while lane 1
  remained live and byte-for-byte state-equivalent across the transaction;
  old principal and commitment additions remained recoverable.
- Direct origin, ordinary forwarded-origin, and `as-contract?` ownership on
  generated lane 3 matched the accepted effective-sender model while lane 0
  remained untouched.

## Interpretation and limitations

These results validate the exact generated candidate against Clarinet's real
simnet PoX-5 and sBTC protocol contracts. They are not a production deployment,
allowlist transaction, live-chain fork, formal proof, or independent security
review. TASK-004 remains the independent review gate. See `AUDIT-SCOPE.md` for
the exact files, hashes, dependencies, accepted residuals, and exclusions.
