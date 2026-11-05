import { Cl } from "@stacks/transactions";
import { describe, expect, it } from "vitest";
import {
  POOL, BOND_INDEX, MAX_SATS, advanceToBurnHeight, bindBond,
  bootstrap, boundBond, deposit, deployer, initializePool, poxInfo,
  readPool, registerSignerManager, setupBond, stake, stakeFirstBond,
  bindNextBond, commitRollover,
} from "./helpers/bond-fixture";

const alice = simnet.getAccounts().get("wallet_1")!;
const keeper = simnet.getAccounts().get("wallet_2")!;
const setMargin = (margin: number | bigint, sender = deployer) =>
  simnet.callPublicFn(POOL, "set-stake-safety-margin", [Cl.uint(margin)], sender).result;

const margin = () => readPool("get-stake-safety-margin");

describe("operator-configurable stake safety margin", () => {
  it("defaults to 80 blocks before the exclusive prepare-phase deadline", () => {
    bootstrap();
    expect(margin()).toBeUint(80);
    const bond = boundBond();
    expect(Number(bond["stake-safety-margin"])).toBe(80);
    expect(Number(bond["stake-opens-at"])).toBe(Number(bond["stake-closes-at"]) - 80);
    deposit(alice, 10_000_000);
    advanceToBurnHeight(Number(bond["rollover-cutoff"]) - 1);
    expect(stake(keeper)).toBeErr(Cl.uint(108));
    advanceToBurnHeight(Number(bond["rollover-cutoff"]));
    expect(stake(keeper).type).toBe("ok");
  });

  it("is operator-only, validates protocol bounds, and leaves state unchanged on rejection", () => {
    expect(setMargin(40, alice)).toBeErr(Cl.uint(100));
    registerSignerManager();
    initializePool();
    expect(setMargin(40, alice)).toBeErr(Cl.uint(100));
    const info = poxInfo();
    const maximum = Math.floor(Number(info["reward-cycle-length"]) / 2) - Number(info["prepare-cycle-length"]);
    for (const invalid of [0, maximum + 1, (1n << 128n) - 1n]) {
      expect(setMargin(invalid)).toBeErr(Cl.uint(136));
      expect(margin()).toBeUint(80);
    }
    expect(setMargin(1)).toBeOk(Cl.uint(1));
    expect(setMargin(maximum)).toBeOk(Cl.uint(maximum));
    expect(margin()).toBeUint(maximum);
  });

  it("uses an operator's configured margin on a new binding and preserves the bind notice", () => {
    registerSignerManager();
    initializePool();
    expect(setMargin(40)).toBeOk(Cl.uint(40));
    setupBond(BOND_INDEX);
    expect(bindBond(BOND_INDEX, MAX_SATS).type).toBe("ok");
    const bond = boundBond();
    expect(Number(bond["stake-opens-at"])).toBe(Number(bond["stake-closes-at"]) - 40);
    expect(Number(bond["rollover-cutoff"])).toBe(Math.max(Number(bond["stake-opens-at"]), Number(bond["notice-ends-at"])));
  });

  it("does not shift a live bond's cutoff and applies changes to the next rollover", () => {
    stakeFirstBond([[alice, 10_000_000]]);
    const first = bindNextBond();
    expect(commitRollover(alice).type).toBe("ok");
    const advertised = boundBond();
    expect(setMargin(40)).toBeOk(Cl.uint(40));
    expect(boundBond()).toEqual(advertised);
    advanceToBurnHeight(first.cutoff);
    expect(stake(keeper).type).toBe("ok");
    bindNextBond(undefined, undefined, 18);
    expect(Number(boundBond()["stake-safety-margin"])).toBe(40);
    expect(Number(boundBond()["stake-opens-at"])).toBe(Number(boundBond()["stake-closes-at"]) - 40);
  });

  it("still rejects stake at the exclusive deadline", () => {
    bootstrap();
    deposit(alice, 10_000_000);
    advanceToBurnHeight(Number(boundBond()["stake-closes-at"]));
    expect(stake(keeper)).toBeErr(Cl.uint(109));
  });
});
