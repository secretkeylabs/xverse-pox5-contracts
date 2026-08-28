import { Cl } from "@stacks/transactions";
import { describe, expect, it } from "vitest";
import {
  TEST_CALLER,
  advanceToBurnHeight,
  avoidPreparePhase,
  deployer,
  expectOk,
  plain,
  sbtcBalance,
  stxBalance,
  testCallerPrincipal,
  transferSbtc,
} from "./helpers/bond-fixture";
import {
  LANE_IDS,
  bindLane,
  cancelCommitmentLane,
  cancelExitLane,
  claimLanePrincipal,
  claimLaneRewards,
  commitLane,
  depositLane,
  initializeLanes,
  laneBoundBond,
  laneClaimableRewards,
  laneConfig,
  laneMember,
  laneMembership,
  lanePool,
  laneRequiredUstx,
  laneRewardBalance,
  laneSettledMember,
  laneStakerPrincipal,
  laneTreasury,
  laneTreasuryBalance,
  laneUnattributedPrincipal,
  laneUnrecognizedRewards,
  payLaneReward,
  requestExitLane,
  settleLaneMember,
  setupLaneBond,
  stakeInitialLane,
  stakeLane,
  syncLaneRewards,
  unstakeEarlyLane,
  unstakeLane,
  withdrawLane,
} from "./helpers/six-lane-fixture";

const accounts = simnet.getAccounts();
const alice = accounts.get("wallet_1")!;
const bob = accounts.get("wallet_2")!;
const carol = accounts.get("wallet_3")!;
const dave = accounts.get("wallet_4")!;
const n = (record: any, field: string) => Number(record[field]);

function assertLaneSolvent(lane: number, members: readonly string[]) {
  const pool = lanePool(lane);
  const records = members
    .map((member) => laneSettledMember(lane, member))
    .filter((record) => record !== null);
  const sum = (field: string) =>
    records.reduce((total, record) => total + n(record, field), 0);

  const principalLiability = n(pool, "queued-sats") + n(pool, "released-sats");
  expect(principalLiability).toBeLessThanOrEqual(laneTreasuryBalance(lane));
  expect(laneTreasuryBalance(lane)).toBe(
    principalLiability + laneUnattributedPrincipal(lane),
  );
  expect(sum("queued-sats")).toBe(n(pool, "queued-sats"));
  expect(sum("released-sats")).toBe(n(pool, "released-sats"));
  expect(sum("bonded-sats")).toBe(n(pool, "bonded-sats"));

  const fundedRewardReserve = n(pool, "total-credited") - n(pool, "total-paid");
  expect(fundedRewardReserve).toBe(n(pool, "unclaimed-rewards"));
  expect(fundedRewardReserve).toBeLessThanOrEqual(laneRewardBalance(lane));
  expect(fundedRewardReserve + laneUnrecognizedRewards(lane)).toBe(
    laneRewardBalance(lane),
  );

  const config = laneConfig(lane);
  if (Number(config["epoch-count"]) > 0 && !config.finished) {
    expect(n(laneMembership(lane), "amount-sats")).toBe(
      n(pool, "bonded-sats"),
    );
  }
}

const laneSnapshot = (lane: number) => ({
  config: laneConfig(lane),
  pool: lanePool(lane),
  treasury: laneTreasuryBalance(lane),
  rewards: laneRewardBalance(lane),
  membership: laneMembership(lane),
});

describe("generated lane mapping", () => {
  for (const lane of LANE_IDS) {
    for (const sequence of [0, 1, 2]) {
      const index = lane + 6 * (sequence + 1);
      it(`lane ${lane} accepts ${index} and all other lanes reject it`, () => {
        initializeLanes();
        setupLaneBond(lane, index, { allowedLanes: LANE_IDS });

        for (const other of LANE_IDS.filter((other) => other !== lane)) {
          expect(bindLane(other, index)).toBeErr(Cl.uint(132));
          expect(laneBoundBond(other).bound).toBe(false);
        }

        expectOk(bindLane(lane, index), `bind lane ${lane} to ${index}`);
        expect(Number(laneBoundBond(lane)["bond-index"])).toBe(index);
      });
    }
  }

  it("rejects every cross-lane treasury controller in the 6x6 matrix", () => {
    for (const treasuryLane of LANE_IDS) {
      const controller = plain(
        simnet.callReadOnlyFn(
          laneTreasury(treasuryLane),
          "get-controller",
          [],
          deployer,
        ).result,
      );
      expect(controller).toBe(laneStakerPrincipal(treasuryLane));

      for (const callerLane of LANE_IDS) {
        expect(laneStakerPrincipal(callerLane) === controller).toBe(
          callerLane === treasuryLane,
        );
      }
      expect(
        simnet.callPublicFn(
          TEST_CALLER,
          `attempt-treasury-${treasuryLane}-payout`,
          [Cl.principal(alice)],
          deployer,
        ).result,
      ).toBeErr(Cl.uint(200));
    }
  });
});

describe("six-lane reward and liability isolation", () => {
  it("executes simultaneous early withdrawals without cross-lane mutation", () => {
    initializeLanes();
    for (const lane of LANE_IDS) {
      stakeInitialLane(lane, lane + 6, [[alice, 1_000 + lane]]);
    }
    avoidPreparePhase();

    for (const lane of LANE_IDS) {
      const amount = lane + 1;
      const unaffected = new Map(
        LANE_IDS.filter((other) => other !== lane).map((other) => [
          other,
          laneSnapshot(other),
        ]),
      );
      expectOk(
        unstakeEarlyLane(lane, alice, amount),
        `early withdraw lane ${lane}`,
      );
      expect(n(lanePool(lane), "bonded-sats")).toBe(1_000 + lane - amount);
      expect(n(laneSettledMember(lane, alice), "bonded-sats")).toBe(
        1_000 + lane - amount,
      );
      expect(laneTreasuryBalance(lane)).toBe(amount);
      expect(n(laneMembership(lane), "amount-sats")).toBe(
        1_000 + lane - amount,
      );

      for (const other of LANE_IDS.filter((other) => other !== lane)) {
        expect(laneSnapshot(other)).toEqual(unaffected.get(other));
      }
    }

    for (const lane of LANE_IDS) assertLaneSolvent(lane, [alice]);
  });

  it("retains repeated recognized flooring dust independently in every lane", () => {
    initializeLanes();
    for (const lane of LANE_IDS) {
      stakeInitialLane(lane, lane + 6, [
        [alice, 1],
        [bob, 1],
      ]);
    }

    for (let payout = 0; payout < 2; payout += 1) {
      for (const lane of LANE_IDS) {
        const unaffected = new Map(
          LANE_IDS.filter((other) => other !== lane).map((other) => [
            other,
            { pool: lanePool(other), rewards: laneRewardBalance(other) },
          ]),
        );
        expectOk(payLaneReward(lane, dave, 1), `pay lane ${lane}`);
        expectOk(syncLaneRewards(lane, carol), `sync lane ${lane}`);
        expectOk(settleLaneMember(lane, alice, dave), `settle alice lane ${lane}`);
        expectOk(settleLaneMember(lane, bob, carol), `settle bob lane ${lane}`);
        expect(laneClaimableRewards(lane, alice)).toBe(0);
        expect(laneClaimableRewards(lane, bob)).toBe(0);

        for (const other of LANE_IDS.filter((other) => other !== lane)) {
          expect(lanePool(other)).toEqual(unaffected.get(other)!.pool);
          expect(laneRewardBalance(other)).toBe(
            unaffected.get(other)!.rewards,
          );
        }
      }
    }

    for (const lane of LANE_IDS) {
      expect(n(lanePool(lane), "total-credited")).toBe(2);
      expect(n(lanePool(lane), "total-paid")).toBe(0);
      expect(n(lanePool(lane), "unclaimed-rewards")).toBe(2);
      expect(laneRewardBalance(lane)).toBe(2);
      expect(laneUnrecognizedRewards(lane)).toBe(0);
      expect(laneTreasuryBalance(lane)).toBe(0);
      assertLaneSolvent(lane, [alice, bob]);
    }
  });

  it("isolates FCFS cancellation, exits, delayed rewards, claims, and excess STX", () => {
    initializeLanes([2, 3]);
    stakeInitialLane(2, 8, [
      [alice, 1_000],
      [bob, 1_000],
    ]);
    stakeInitialLane(3, 9, [[alice, 2_000]]);

    const lane3Initial = laneSnapshot(3);
    expectOk(requestExitLane(2, alice), "request lane 2 exit");
    expect(laneMember(2, alice)["exit-epoch"]).toBe("0");
    expect(laneMember(3, alice)["exit-epoch"]).toBeNull();
    expectOk(cancelExitLane(2, alice), "cancel lane 2 exit");
    expect(laneSnapshot(3)).toEqual(lane3Initial);

    setupLaneBond(2, 14, { allowanceSats: 1_000 });
    expectOk(bindLane(2, 14, 1_000), "bind constrained lane 2");
    expectOk(commitLane(2, alice), "alice consumes lane 2 allowance");
    const lane3BeforeFailure = laneSnapshot(3);
    expect(commitLane(2, bob)).toBeErr(Cl.uint(105));
    expect(laneSnapshot(3)).toEqual(lane3BeforeFailure);
    expectOk(cancelCommitmentLane(2, alice), "alice releases allowance");
    expectOk(commitLane(2, bob), "bob consumes released allowance");
    expect(n(lanePool(2), "committed-sats")).toBe(1_000);

    advanceToBurnHeight(Number(laneBoundBond(2)["rollover-cutoff"]));
    expectOk(stakeLane(2, carol), "roll constrained lane 2");
    expect(n(laneSettledMember(2, alice), "released-sats")).toBe(1_000);
    expect(n(laneSettledMember(2, bob), "bonded-sats")).toBe(1_000);
    expect(laneSnapshot(3)).toEqual(lane3Initial);

    expectOk(payLaneReward(2, dave, 10), "pay delayed lane 2 reward");
    expectOk(syncLaneRewards(2, carol), "sync delayed lane 2 reward");
    expectOk(settleLaneMember(2, alice, bob), "settle released alice");
    expectOk(settleLaneMember(2, bob, alice), "settle continuing bob");
    expect(laneClaimableRewards(2, alice)).toBe(5);
    expect(laneClaimableRewards(2, bob)).toBe(5);
    expectOk(claimLaneRewards(2, alice, dave), "claim alice lane 2 reward");
    expectOk(claimLanePrincipal(2, alice, dave), "claim alice lane 2 principal");
    expect(laneClaimableRewards(3, alice)).toBe(0);
    expect(laneSnapshot(3)).toEqual(lane3Initial);

    setupLaneBond(3, 15, { ratio: 50_000 });
    expectOk(bindLane(3, 15), "bind lower-ratio lane 3");
    const oldUstx = n(laneSettledMember(3, alice), "bonded-ustx");
    const minimumNextUstx = laneRequiredUstx(3, 2_000);
    expect(oldUstx).toBeGreaterThan(minimumNextUstx);
    expectOk(commitLane(3, alice), "commit over-collateralized lane 3 position");
    const lane2BeforeLane3Roll = laneSnapshot(2);
    advanceToBurnHeight(Number(laneBoundBond(3)["rollover-cutoff"]));
    expectOk(stakeLane(3, dave), "roll over-collateralized lane 3");
    expect(n(laneMembership(3), "amount-ustx")).toBe(oldUstx);
    expect(n(laneSettledMember(3, alice), "bonded-ustx")).toBe(oldUstx);
    expect(laneSnapshot(2)).toEqual(lane2BeforeLane3Roll);

    assertLaneSolvent(2, [alice, bob]);
    assertLaneSolvent(3, [alice]);
  });
});

describe("lane-local liveness and caller contexts", () => {
  it("winds down a missed lane without changing another live lane", () => {
    initializeLanes([0, 1]);
    stakeInitialLane(0, 6, [[alice, 1_000]]);
    stakeInitialLane(1, 13, [[alice, 2_000]]);

    setupLaneBond(0, 18);
    expectOk(bindLane(0, 18), "bind delayed lane 0 replacement");
    expectOk(commitLane(0, alice, 100), "commit delayed lane 0 replacement");
    advanceToBurnHeight(Number(laneBoundBond(0)["rollover-cutoff"]));

    const lane1Before = laneSnapshot(1);
    expectOk(unstakeLane(0, bob), "permissionless lane 0 wind-down");
    expect(laneConfig(0).finished).toBe(true);
    expect(laneBoundBond(0).bound).toBe(false);
    expect(stakeLane(0, carol)).toBeErr(Cl.uint(118));
    expect(laneSnapshot(1)).toEqual(lane1Before);

    expectOk(claimLanePrincipal(0, alice, dave), "claim old lane 0 principal");
    expectOk(cancelCommitmentLane(0, alice), "recover delayed addition");
    expect(n(laneSettledMember(1, alice), "bonded-sats")).toBe(2_000);
    expect(laneSnapshot(1)).toEqual(lane1Before);
    assertLaneSolvent(0, [alice]);
    assertLaneSolvent(1, [alice]);
  });

  it("preserves direct, forwarded-origin, and as-contract ownership on lane 3", () => {
    initializeLanes([3]);
    setupLaneBond(3, 9);
    expectOk(bindLane(3, 9), "bind lane 3 caller fixture");
    const lane0Before = { config: laneConfig(0), pool: lanePool(0) };

    expectOk(depositLane(3, bob, 10), "direct lane 3 deposit");
    expect(n(laneMember(3, bob), "queued-sats")).toBe(10);
    expectOk(withdrawLane(3, bob), "direct lane 3 withdrawal");

    expectOk(
      simnet.callPublicFn(
        TEST_CALLER,
        "forward-deposit-lane-3",
        [Cl.uint(11)],
        alice,
      ).result,
      "forwarded lane 3 deposit",
    );
    expect(n(laneMember(3, alice), "queued-sats")).toBe(11);
    expect(laneMember(3, testCallerPrincipal())).toBeNull();
    expectOk(
      simnet.callPublicFn(
        TEST_CALLER,
        "forward-withdraw-lane-3",
        [],
        alice,
      ).result,
      "forwarded lane 3 withdrawal",
    );

    const wallet = testCallerPrincipal();
    const sats = 12;
    const ustx = laneRequiredUstx(3, sats);
    expectOk(transferSbtc(alice, wallet, sats), "fund lane 3 contract wallet");
    expectOk(simnet.transferSTX(ustx, wallet, alice).result, "fund wallet STX");
    expectOk(
      simnet.callPublicFn(
        TEST_CALLER,
        "wallet-deposit-lane-3",
        [Cl.uint(sats), Cl.uint(ustx)],
        dave,
      ).result,
      "as-contract lane 3 deposit",
    );
    expect(n(laneMember(3, wallet), "queued-sats")).toBe(sats);
    expect(laneMember(3, dave)).toBeNull();
    expectOk(
      simnet.callPublicFn(
        TEST_CALLER,
        "wallet-withdraw-lane-3",
        [],
        carol,
      ).result,
      "as-contract lane 3 withdrawal",
    );
    expect(sbtcBalance(wallet)).toBe(sats);
    expect(stxBalance(wallet)).toBe(ustx);

    expect({ config: laneConfig(0), pool: lanePool(0) }).toEqual(lane0Before);
    expect(laneTreasuryBalance(0)).toBe(0);
    expect(laneTreasuryBalance(3)).toBe(0);
  });
});
