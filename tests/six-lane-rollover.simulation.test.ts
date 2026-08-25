import { Cl } from "@stacks/transactions";
import { describe, expect, it } from "vitest";
import {
  ALT_MANAGER,
  MANAGER,
  POX5,
  advanceToBurnHeight,
  bondStartHeight,
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
  laneTreasuryBalance,
  setupLaneBond,
  stakeLane,
} from "./helpers/six-lane-fixture";

const accounts = simnet.getAccounts();
const alice = accounts.get("wallet_1")!;
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
      advanceToBurnHeight(bondStartHeight(index) - 288);
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
});
