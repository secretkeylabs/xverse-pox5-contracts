import { Cl } from "@stacks/transactions";
import { describe, expect, it } from "vitest";
import {
  ALT_MANAGER,
  MAX_SATS,
  advanceToBurnHeight,
  avoidPreparePhase,
  bindNextBond,
  bootstrap,
  cancelExit,
  cancelRollover,
  claimPrincipal,
  claimableRewards,
  commitRollover,
  custodiedSats,
  deposit,
  earlyUnstakePreview,
  epoch,
  inPreparePhase,
  liveRolloverCommitment,
  managerPrincipal,
  member,
  payRewards,
  plain,
  poolConfig,
  poolTotals,
  rewardEpoch,
  rewardEpochSettlementHeight,
  sbtcBalance,
  settledMember,
  stake,
  stakeFirstBond,
  stxBalance,
  syncRewards,
  treasuryBalance,
  unstakeEarly,
  unstakeSbtc,
  withdraw,
} from "./helpers/bond-fixture";

const accounts = simnet.getAccounts();
const alice = accounts.get("wallet_1")!;
const bob = accounts.get("wallet_2")!;
const carol = accounts.get("wallet_3")!;
const dave = accounts.get("wallet_4")!;

const ALICE_SATS = 10_000_000;
const BOB_SATS = 30_000_000;
const POOL_SATS = ALICE_SATS + BOB_SATS;

function stakeTwoMembers() {
  const result = stakeFirstBond([
    [alice, ALICE_SATS],
    [bob, BOB_SATS],
  ]);
  avoidPreparePhase();
  return result;
}

const value = (record: any, field: string) => Number(record[field]);

function expectCreditIdentity(epochIndex: number) {
  const record = epoch(epochIndex);
  const expected =
    (BigInt(record["total-shares"]) * BigInt(record["reward-index"])) /
      1_000_000_000_000n +
    BigInt(record["credit-offset"]);
  expect(BigInt(record.credited)).toBe(expected);
}

describe("member-initiated early sBTC withdrawal", () => {
  it("partially removes exact principal and shares while retaining all STX", () => {
    stakeTwoMembers();
    const amount = ALICE_SATS / 2;
    const aliceStx = stxBalance(alice);
    const bondedUstx = value(settledMember(alice), "bonded-ustx");

    const result = unstakeEarly(alice, amount);
    expect(result.type).toBe("ok");
    expect(plain(result)).toMatchObject({
      member: alice,
      epoch: "0",
      sats: String(amount),
      "remaining-sats": String(amount),
      "shares-after": String(POOL_SATS - amount),
      "ustx-at-roll": "0",
      exiting: false,
      pox: {
        "amount-withdrawn-sats": String(amount),
        "new-amount-sats": String(POOL_SATS - amount),
      },
    });

    expect(custodiedSats()).toBe(POOL_SATS - amount);
    expect(treasuryBalance()).toBe(amount);
    expect(poolTotals()).toMatchObject({
      "bonded-sats": String(POOL_SATS - amount),
      "bonded-ustx": String(
        value(settledMember(alice), "bonded-ustx") +
          value(settledMember(bob), "bonded-ustx"),
      ),
      "released-sats": String(amount),
      "exiting-sats": "0",
      "exiting-ustx": "0",
    });
    expect(epoch(0)).toMatchObject({
      "total-shares": String(POOL_SATS - amount),
      "staked-sats": String(POOL_SATS),
      "eligible-sats": String(POOL_SATS),
    });
    expect(settledMember(alice)).toMatchObject({
      shares: String(amount),
      "bonded-sats": String(amount),
      "bonded-ustx": String(bondedUstx),
      "released-sats": String(amount),
      "exit-epoch": null,
    });
    expect(stxBalance(alice)).toBe(aliceStx);

    const aliceSbtc = sbtcBalance(alice);
    expect(claimPrincipal(alice, carol).type).toBe("ok");
    expect(sbtcBalance(alice)).toBe(aliceSbtc + amount);
    expect(treasuryBalance()).toBe(0);
  });

  it("fully removes sBTC now and releases only STX at the next roll", () => {
    stakeTwoMembers();
    const aliceUstx = value(settledMember(alice), "bonded-ustx");

    expect(unstakeEarly(alice, ALICE_SATS).type).toBe("ok");
    expect(settledMember(alice)).toMatchObject({
      shares: "0",
      "bonded-sats": "0",
      "bonded-ustx": String(aliceUstx),
      "released-sats": String(ALICE_SATS),
      "exit-epoch": "0",
    });
    expect(poolTotals()).toMatchObject({
      "bonded-sats": String(BOB_SATS),
      "exiting-sats": "0",
      "exiting-ustx": String(aliceUstx),
    });
    expect(cancelExit(alice)).toBeErr(Cl.uint(110));

    const { cutoff } = bindNextBond();
    // The zero-sats target is rejected before the exit marker is consulted;
    // either guard prevents a STX-only rollover position.
    expect(commitRollover(alice)).toBeErr(Cl.uint(116));
    expect(commitRollover(bob).type).toBe("ok");
    advanceToBurnHeight(cutoff);
    expect(stake().type).toBe("ok");

    expect(settledMember(alice)).toMatchObject({
      shares: "0",
      "bonded-sats": "0",
      "bonded-ustx": "0",
      "released-sats": String(ALICE_SATS),
      "released-ustx": String(aliceUstx),
      "exit-epoch": null,
    });
    expect(epoch(1)["total-shares"]).toBe(String(BOB_SATS));
  });

  it("blocks current and stale commitments until explicit cancellation", () => {
    stakeTwoMembers();
    const current = bindNextBond();
    expect(commitRollover(alice, 1_000_000).type).toBe("ok");
    expect(earlyUnstakePreview(alice)["blocked-by-commitment"]).toBe(true);

    const currentPool = poolTotals();
    const currentMember = member(alice);
    expect(unstakeEarly(alice, 1)).toBeErr(Cl.uint(130));
    expect(poolTotals()).toEqual(currentPool);
    expect(member(alice)).toEqual(currentMember);

    expect(cancelRollover(alice).type).toBe("ok");
    expect(earlyUnstakePreview(alice)["blocked-by-commitment"]).toBe(false);
    avoidPreparePhase();
    expect(unstakeEarly(alice, 1).type).toBe("ok");

    // A later missed-bond generation is also frozen until its stale recovery
    // path clears the marker.
    advanceToBurnHeight(current.start + 1);
    bindNextBond(undefined, MAX_SATS, 18);
    expect(commitRollover(bob).type).toBe("ok");
    const committed = poolTotals();
    expect(unstakeEarly(bob, 1)).toBeErr(Cl.uint(130));
    expect(poolTotals()).toEqual(committed);

    const replacementStart = Number(
      plain(
        simnet.callReadOnlyFn(
          "sbtc-bond-staker-0",
          "get-bound-bond",
          [],
          dave,
        ).result,
      )["start-height"],
    );
    advanceToBurnHeight(replacementStart + 1);
    bindNextBond(undefined, MAX_SATS, 24);
    expect(earlyUnstakePreview(bob)["blocked-by-commitment"]).toBe(true);
    expect(unstakeEarly(bob, 1)).toBeErr(Cl.uint(130));
    expect(cancelRollover(bob).type).toBe("ok");
    avoidPreparePhase();
    expect(unstakeEarly(bob, 1).type).toBe("ok");
  });

  it("leaves another member's frozen commitment and aggregates unchanged", () => {
    stakeTwoMembers();
    const { cutoff } = bindNextBond();
    expect(commitRollover(bob).type).toBe("ok");
    const commitment = liveRolloverCommitment(bob);
    const before = poolTotals();

    expect(unstakeEarly(alice, ALICE_SATS / 2).type).toBe("ok");
    expect(liveRolloverCommitment(bob)).toEqual(commitment);
    expect(poolTotals()).toMatchObject({
      "committed-sats": before["committed-sats"],
      "committed-ustx": before["committed-ustx"],
      "committed-old-sats": before["committed-old-sats"],
      "committed-old-ustx": before["committed-old-ustx"],
      "committed-added-sats": before["committed-added-sats"],
      "committed-added-ustx": before["committed-added-ustx"],
      "bonded-sats": String(POOL_SATS - ALICE_SATS / 2),
    });

    advanceToBurnHeight(cutoff);
    expect(stake().type).toBe("ok");
    expect(settledMember(bob)["bonded-sats"]).toBe(String(BOB_SATS));
    expect(settledMember(alice)).toMatchObject({
      "bonded-sats": "0",
      "released-sats": String(ALICE_SATS),
    });
  });

  it("allows withdrawal after a commitment is consumed by rollover", () => {
    stakeTwoMembers();
    const { cutoff } = bindNextBond();
    expect(commitRollover(alice).type).toBe("ok");
    expect(commitRollover(bob).type).toBe("ok");
    advanceToBurnHeight(cutoff);
    expect(stake().type).toBe("ok");
    avoidPreparePhase();

    expect(earlyUnstakePreview(alice)["blocked-by-commitment"]).toBe(false);
    expect(unstakeEarly(alice, 1).type).toBe("ok");
  });

  it("exposes raw live risk and avoids double-floor quote inputs", () => {
    stakeFirstBond([
      [alice, 3],
      [bob, 1],
    ]);
    avoidPreparePhase();
    expect(payRewards(carol, 2).type).toBe("ok");

    const preview = earlyUnstakePreview(alice);
    expect(preview).toMatchObject({
      member: alice,
      "live-epoch": "0",
      "reward-epoch": "0",
      "max-withdrawable-sats": "3",
      "risk-reward-pot": "2",
      "risk-total-shares": "4",
      "at-risk-rewards": "1",
      "full-exit-requires-reward-sync": false,
      "blocked-by-exit": false,
      "blocked-by-commitment": false,
    });

    const requested = 2;
    const exact = Math.floor(
      (Number(preview["risk-reward-pot"]) * requested) /
        Number(preview["risk-total-shares"]),
    );
    const doubleFloored = Math.floor(
      (Number(preview["at-risk-rewards"]) * requested) /
        Number(preview["max-withdrawable-sats"]),
    );
    expect(exact).toBe(1);
    expect(doubleFloored).toBe(0);
  });

  it("reports predecessor-tail rewards as protected during epoch overlap", () => {
    stakeTwoMembers();
    const { cutoff } = bindNextBond();
    expect(commitRollover(alice).type).toBe("ok");
    expect(commitRollover(bob).type).toBe("ok");
    expect(commitRollover(carol, ALICE_SATS).type).toBe("ok");
    advanceToBurnHeight(cutoff);
    expect(stake().type).toBe("ok");
    avoidPreparePhase();

    expect(Number(rewardEpoch())).toBe(0);
    expect(epoch(0)["total-shares"]).toBe(String(POOL_SATS));
    expect(epoch(1)["total-shares"]).toBe(String(POOL_SATS + ALICE_SATS));
    expect(payRewards(dave, 4_000_000).type).toBe("ok");

    const preview = earlyUnstakePreview(alice);
    expect(preview).toMatchObject({
      "live-epoch": "1",
      "reward-epoch": "0",
      "risk-reward-pot": "0",
      "risk-total-shares": String(POOL_SATS + ALICE_SATS),
      "at-risk-rewards": "0",
    });

    expect(unstakeEarly(alice, ALICE_SATS).type).toBe("ok");
    expect(syncRewards(carol).type).toBe("ok");
    expect(claimableRewards(alice)).toBe(1_000_000);
  });

  it("keeps cumulative epoch credit invariant through repeated sync and withdrawal", () => {
    stakeFirstBond([
      [alice, 3],
      [bob, 7],
    ]);
    avoidPreparePhase();

    expect(payRewards(carol, 5).type).toBe("ok");
    expect(syncRewards(dave).type).toBe("ok");
    expectCreditIdentity(0);
    const credited = epoch(0).credited;

    expect(unstakeEarly(alice, 1).type).toBe("ok");
    expect(epoch(0).credited).toBe(credited);
    expectCreditIdentity(0);

    expect(payRewards(carol, 9).type).toBe("ok");
    expect(syncRewards(dave).type).toBe("ok");
    expectCreditIdentity(0);

    expect(unstakeEarly(bob, 2).type).toBe("ok");
    expectCreditIdentity(0);
    expect(payRewards(carol, 7).type).toBe("ok");
    expect(syncRewards(dave).type).toBe("ok");
    expectCreditIdentity(0);
    expect(value(poolTotals(), "total-credited")).toBe(value(epoch(0), "credited"));
  });

  it("requires synchronization before removing the final live share", () => {
    stakeFirstBond([[alice, 4]]);
    avoidPreparePhase();
    expect(payRewards(carol, 4).type).toBe("ok");

    expect(earlyUnstakePreview(alice)).toMatchObject({
      "risk-reward-pot": "4",
      "risk-total-shares": "4",
      "at-risk-rewards": "4",
      "full-exit-requires-reward-sync": true,
    });
    const before = {
      pool: poolTotals(),
      member: member(alice),
      epoch: epoch(0),
      custody: custodiedSats(),
      treasury: treasuryBalance(),
    };
    expect(unstakeEarly(alice, 4)).toBeErr(Cl.uint(135));
    expect({
      pool: poolTotals(),
      member: member(alice),
      epoch: epoch(0),
      custody: custodiedSats(),
      treasury: treasuryBalance(),
    }).toEqual(before);

    expect(syncRewards(bob).type).toBe("ok");
    expect(earlyUnstakePreview(alice)["full-exit-requires-reward-sync"]).toBe(false);
    expect(unstakeEarly(alice, 4).type).toBe("ok");
    expect(claimableRewards(alice)).toBe(4);
  });

  it("rolls back local state when PoX rejects during prepare phase", () => {
    stakeTwoMembers();
    for (let guard = 0; !inPreparePhase() && guard < 400; guard += 1) {
      simnet.mineEmptyBurnBlocks(5);
    }
    expect(inPreparePhase()).toBe(true);

    const before = {
      pool: poolTotals(),
      member: member(alice),
      epoch: epoch(0),
      custody: custodiedSats(),
      treasury: treasuryBalance(),
    };
    expect(unstakeEarly(alice, 1).type).toBe("err");
    expect({
      pool: poolTotals(),
      member: member(alice),
      epoch: epoch(0),
      custody: custodiedSats(),
      treasury: treasuryBalance(),
    }).toEqual(before);

    avoidPreparePhase();
    expect(unstakeEarly(alice, 1).type).toBe("ok");
  });

  it("rejects absent, zero, excessive, wrong-manager, exiting, and finished calls", () => {
    const { bondStart } = bootstrap();
    expect(deposit(alice, ALICE_SATS).type).toBe("ok");
    expect(unstakeEarly(alice, 1)).toBeErr(Cl.uint(107));
    expect(withdraw(alice).type).toBe("ok");

    expect(deposit(alice, ALICE_SATS).type).toBe("ok");
    advanceToBurnHeight(bondStart - 288);
    expect(stake().type).toBe("ok");
    avoidPreparePhase();
    expect(unstakeEarly(bob, 1)).toBeErr(Cl.uint(110));
    expect(unstakeEarly(alice, 0)).toBeErr(Cl.uint(116));
    expect(unstakeEarly(alice, ALICE_SATS + 1)).toBeErr(Cl.uint(116));
    expect(
      simnet.callPublicFn(
        "sbtc-bond-staker-0",
        "unstake-sbtc-early",
        [
          Cl.principal(managerPrincipal()),
          Cl.uint((1n << 128n) - 1n),
        ],
        alice,
      ).result,
    ).toBeErr(Cl.uint(116));
    expect(unstakeEarly(alice, 1, ALT_MANAGER)).toBeErr(Cl.uint(111));
    expect(simnet.callPublicFn(
      "sbtc-bond-staker-0",
      "request-exit",
      [],
      alice,
    ).result.type).toBe("ok");
    expect(unstakeEarly(alice, 1)).toBeErr(Cl.uint(123));

    // A separate pool instance is supplied by each test, so finish this one
    // through ordinary wind-down after the recorded unlock.
    const unlock = value(epoch(0), "unlock-burn-height");
    advanceToBurnHeight(unlock);
    expect(unstakeSbtc(carol).type).toBe("ok");
    expect(unstakeEarly(alice, 1)).toBeErr(Cl.uint(112));
  });

  it("finishes and releases STX after every member exits without a zero token call", () => {
    const { unlockHeight } = stakeTwoMembers();
    const aliceUstx = value(settledMember(alice), "bonded-ustx");
    const bobUstx = value(settledMember(bob), "bonded-ustx");

    expect(unstakeEarly(alice, ALICE_SATS).type).toBe("ok");
    expect(unstakeEarly(bob, BOB_SATS).type).toBe("ok");
    expect(custodiedSats()).toBe(0);
    expect(poolTotals()).toMatchObject({
      "bonded-sats": "0",
      "bonded-ustx": String(aliceUstx + bobUstx),
      "exiting-sats": "0",
      "exiting-ustx": String(aliceUstx + bobUstx),
      "released-sats": String(POOL_SATS),
    });

    advanceToBurnHeight(unlockHeight);
    const finalized = unstakeSbtc(carol);
    expect(finalized.type).toBe("ok");
    expect(plain(finalized)).toMatchObject({
      "amount-withdrawn-sats": "0",
      "new-amount-sats": "0",
      "bond-index": "6",
    });
    expect(poolConfig().finished).toBe(true);
    expect(poolTotals()).toMatchObject({
      "bonded-sats": "0",
      "bonded-ustx": "0",
      "exiting-sats": "0",
      "exiting-ustx": "0",
      "released-sats": String(POOL_SATS),
      "released-ustx": String(aliceUstx + bobUstx),
    });
    expect(treasuryBalance()).toBe(POOL_SATS);
    expect(custodiedSats()).toBe(0);

    const aliceStx = stxBalance(alice);
    const bobStx = stxBalance(bob);
    expect(claimPrincipal(alice, dave).type).toBe("ok");
    expect(claimPrincipal(bob, dave).type).toBe("ok");
    expect(stxBalance(alice)).toBe(aliceStx + aliceUstx);
    expect(stxBalance(bob)).toBe(bobStx + bobUstx);
    expect(treasuryBalance()).toBe(0);
  });

  it("switches preview risk to the live epoch exactly at the half-cycle boundary", () => {
    stakeTwoMembers();
    const { cutoff } = bindNextBond();
    expect(commitRollover(alice).type).toBe("ok");
    expect(commitRollover(bob).type).toBe("ok");
    advanceToBurnHeight(cutoff);
    expect(stake().type).toBe("ok");

    const boundary = rewardEpochSettlementHeight();
    advanceToBurnHeight(boundary - 1);
    expect(payRewards(carol, 4).type).toBe("ok");
    expect(earlyUnstakePreview(alice)).toMatchObject({
      "reward-epoch": "0",
      "risk-reward-pot": "0",
      "at-risk-rewards": "0",
    });

    advanceToBurnHeight(boundary);
    expect(earlyUnstakePreview(alice)).toMatchObject({
      "reward-epoch": "1",
      "risk-reward-pot": "4",
      "risk-total-shares": String(POOL_SATS),
      "at-risk-rewards": "1",
    });
    advanceToBurnHeight(boundary + 1);
    expect(earlyUnstakePreview(alice)).toMatchObject({
      "reward-epoch": "1",
      "risk-reward-pot": "4",
      "at-risk-rewards": "1",
    });
  });
});
