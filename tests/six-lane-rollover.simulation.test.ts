import { Cl } from "@stacks/transactions";
import { describe, expect, it } from "vitest";
import {
  ALT_MANAGER,
  MANAGER,
  POX5,
  advanceToBurnHeight,
  expectOk,
  managerPrincipal,
  registerSignerManager,
  sbtcBalance,
} from "./helpers/bond-fixture";
import {
  LANE_IDS,
  bindLane,
  callLane,
  commitLane,
  depositLane,
  initializeLanes,
  laneBoundBond,
  laneConfig,
  laneEpoch,
  laneMembership,
  lanePool,
  laneRequiredUstx,
  laneSettledMember,
  laneTreasuryBalance,
  setupLaneBond,
  stakeInitialLane,
  stakeLane,
} from "./helpers/six-lane-fixture";

const accounts = simnet.getAccounts();
const alice = accounts.get("wallet_1")!;
const bob = accounts.get("wallet_2")!;
const keeper = accounts.get("wallet_4")!;
const INITIAL_INDEX = 6;

const n = (record: any, field: string) => Number(record[field]);

describe("six-lane PoX-5 rollover simulation", () => {
  it("holds six overlapping memberships and rolls every principal from N to N+6", () => {
    initializeLanes();

    const initialSats = new Map<number, number>();
    for (const lane of LANE_IDS) {
      const index = INITIAL_INDEX + lane;
      const sats = 10_000 + lane * 1_000;
      initialSats.set(lane, sats);

      setupLaneBond(lane, index);
      expectOk(bindLane(lane, index), `bind initial lane ${lane}`);
      expectOk(depositLane(lane, alice, sats), `deposit initial lane ${lane}`);
      advanceToBurnHeight(Number(laneBoundBond(lane)["rollover-cutoff"]));
      expectOk(stakeLane(lane, keeper), `stake initial lane ${lane}`);

      const membership = laneMembership(lane);
      expect(n(membership, "bond-index")).toBe(index);
      expect(n(membership, "amount-sats")).toBe(sats);
      expect(n(membership, "amount-ustx")).toBe(
        laneRequiredUstx(lane, sats),
      );
      expect(laneTreasuryBalance(lane)).toBe(0);
    }

    // At bond 11's stake window, bond 6 is still live. All six principal-keyed
    // PoX-5 memberships therefore coexist rather than replacing one another.
    for (const lane of LANE_IDS) {
      expect(n(laneMembership(lane), "bond-index")).toBe(INITIAL_INDEX + lane);
      expect(n(lanePool(lane), "bonded-sats")).toBe(initialSats.get(lane));
      expect(n(laneEpoch(lane, 0), "total-shares")).toBe(
        initialSats.get(lane),
      );
    }

    // A signer change on lane 0 changes only that principal's membership.
    expectOk(registerSignerManager(ALT_MANAGER, 2), "register alternate manager");
    const otherMemberships = new Map(
      LANE_IDS.slice(1).map((lane) => [lane, laneMembership(lane)]),
    );
    expectOk(
      callLane(
        0,
        "update-bond-registration",
        [
          Cl.principal(managerPrincipal(ALT_MANAGER)),
          Cl.principal(managerPrincipal(MANAGER)),
        ],
      ),
      "rotate lane 0 signer",
    );
    expect(laneMembership(0).signer).toBe(managerPrincipal(ALT_MANAGER));
    for (const lane of LANE_IDS.slice(1)) {
      expect(laneMembership(lane)).toEqual(otherMemberships.get(lane));
      expect(laneConfig(lane)["signer-manager"]).toBe(
        managerPrincipal(MANAGER),
      );
    }

    for (const lane of LANE_IDS) {
      const nextIndex = INITIAL_INDEX + lane + 6;
      const addition = (lane + 1) * 100;
      const oldMembership = laneMembership(lane);
      const oldPool = lanePool(lane);
      const unaffected = new Map(
        LANE_IDS.filter((other) => other !== lane).map((other) => [
          other,
          { pool: lanePool(other), membership: laneMembership(other) },
        ]),
      );

      setupLaneBond(lane, nextIndex);
      expectOk(bindLane(lane, nextIndex), `bind successor lane ${lane}`);
      expectOk(commitLane(lane, alice, addition), `commit lane ${lane}`);
      expect(laneTreasuryBalance(lane)).toBe(addition);

      const beforePoxSbtc = sbtcBalance(POX5);
      const cutoff = Number(laneBoundBond(lane)["rollover-cutoff"]);
      advanceToBurnHeight(cutoff);
      const manager = lane === 0 ? ALT_MANAGER : MANAGER;
      expectOk(stakeLane(lane, keeper, manager), `roll lane ${lane}`);

      const nextSats = n(oldMembership, "amount-sats") + addition;
      const nextMembership = laneMembership(lane);
      expect(n(nextMembership, "bond-index")).toBe(nextIndex);
      expect(n(nextMembership, "amount-sats")).toBe(nextSats);
      expect(n(nextMembership, "amount-ustx")).toBe(
        laneRequiredUstx(lane, nextSats),
      );
      expect(n(nextMembership, "amount-ustx")).toBeGreaterThan(
        n(oldMembership, "amount-ustx"),
      );
      expect(n(lanePool(lane), "bonded-sats")).toBe(nextSats);
      expect(n(lanePool(lane), "bonded-ustx")).toBe(
        n(nextMembership, "amount-ustx"),
      );
      expect(n(laneEpoch(lane, 1), "total-shares")).toBe(nextSats);
      expect(n(oldPool, "bonded-sats") + addition).toBe(nextSats);
      expect(sbtcBalance(POX5) - beforePoxSbtc).toBe(addition);
      expect(laneTreasuryBalance(lane)).toBe(0);

      for (const other of LANE_IDS.filter((other) => other !== lane)) {
        expect(lanePool(other)).toEqual(unaffected.get(other)!.pool);
        expect(laneMembership(other)).toEqual(
          unaffected.get(other)!.membership,
        );
      }
    }

    for (const lane of LANE_IDS) {
      expect(laneConfig(lane)["epoch-count"]).toBe("2");
      expect(n(laneMembership(lane), "bond-index")).toBe(
        INITIAL_INDEX + lane + 6,
      );
      expect(laneMembership(lane).signer).toBe(
        managerPrincipal(lane === 0 ? ALT_MANAGER : MANAGER),
      );
    }
  });

  it("lets an incumbent join another lane as a newcomer without lane-0 drift", () => {
    initializeLanes([0, 1]);

    // alice is an incumbent only on lane 0; lane 1 has its own established epoch.
    stakeInitialLane(0, 6, [[alice, 10_000]]);
    stakeInitialLane(1, 7, [[bob, 20_000]]);

    // Roll alice's lane 0 position to its next bond first.
    setupLaneBond(0, 12);
    expectOk(bindLane(0, 12), "bind lane 0 successor");
    expectOk(commitLane(0, alice, 100), "commit incumbent lane 0");
    advanceToBurnHeight(Number(laneBoundBond(0)["rollover-cutoff"]));
    expectOk(stakeLane(0, keeper), "roll lane 0");
    expect(n(laneMembership(0), "bond-index")).toBe(12);
    expect(n(laneSettledMember(0, alice), "bonded-sats")).toBe(10_100);

    const lane0Snapshot = () => ({
      config: laneConfig(0),
      pool: lanePool(0),
      membership: laneMembership(0),
      treasury: laneTreasuryBalance(0),
    });
    const lane0Before = lane0Snapshot();
    const lane0MemberBefore = laneSettledMember(0, alice);

    // alice has no lane-1 bonded position, so this is a newcomer commitment.
    const newcomerSats = 5_000;
    const nextLane1Index = 13;
    setupLaneBond(1, nextLane1Index);
    expectOk(bindLane(1, nextLane1Index), "bind lane 1 successor");
    expectOk(commitLane(1, alice, newcomerSats), "commit newcomer lane 1");
    expect(n(lanePool(1), "queued-sats")).toBe(newcomerSats);
    expect(laneTreasuryBalance(1)).toBe(newcomerSats);
    expect(lane0Snapshot()).toEqual(lane0Before);

    advanceToBurnHeight(Number(laneBoundBond(1)["rollover-cutoff"]));
    expectOk(stakeLane(1, keeper), "roll lane 1 with newcomer");
    expect(n(laneMembership(1), "bond-index")).toBe(nextLane1Index);
    expect(n(laneSettledMember(1, alice), "bonded-sats")).toBe(newcomerSats);
    expect(n(lanePool(1), "bonded-sats")).toBe(newcomerSats);
    // The lane's previous non-committing member is released, not alice's lane 0.
    expect(n(laneSettledMember(1, bob), "released-sats")).toBe(20_000);
    expect(laneTreasuryBalance(1)).toBe(20_000);

    // Both positions remain active and lane 0 is byte-for-byte unchanged.
    expect(n(laneMembership(0), "bond-index")).toBe(12);
    expect(n(laneMembership(1), "bond-index")).toBe(nextLane1Index);
    for (const field of ["bonded-sats", "bonded-ustx", "shares"] as const) {
      expect(n(laneSettledMember(0, alice), field)).toBe(
        n(lane0MemberBefore, field),
      );
    }
    expect(lane0Snapshot()).toEqual(lane0Before);
  });
});
