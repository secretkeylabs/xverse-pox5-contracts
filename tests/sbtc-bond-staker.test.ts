import { Cl } from "@stacks/transactions";
import { describe, expect, it } from "vitest";
import {
  ALT_MANAGER,
  BOND_INDEX,
  MAX_SATS,
  POX5,
  TREASURY,
  advanceToBurnHeight,
  bindBond,
  bindNextBond,
  bondStartHeight,
  bootstrap,
  boundBond,
  cancelRollover,
  claimPrincipal,
  claimRewards,
  claimablePrincipal,
  claimableRewards,
  commitRollover,
  deployer,
  deposit,
  epoch,
  initializePool,
  managerPrincipal,
  member,
  payRewards,
  plain,
  poolConfig,
  poolPrincipal,
  poxInfo,
  poolTotals,
  registerSignerManager,
  requestExit,
  requiredUstx,
  rolloverPreview,
  sbtcBalance,
  setupBond,
  settledMember,
  stake,
  stakeFirstBond,
  stakePreview,
  stxBalance,
  syncRewards,
  treasuryBalance,
  treasuryPrincipal,
  unstakeSbtc,
  updateBondRegistration,
  updateOperator,
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
const BIND_NOTICE = 576;

const stakeInitialPool = () =>
  stakeFirstBond([
    [alice, ALICE_SATS],
    [bob, BOB_SATS],
  ]);

describe("Xverse lane-0 initialization and launch", () => {
  it("initializes once, exposes lane configuration, and binds lane 0", () => {
    expect(registerSignerManager().type).toBe("ok");
    expect(initializePool(alice)).toBeErr(Cl.uint(100));
    expect(initializePool().type).toBe("ok");
    expect(initializePool()).toBeErr(Cl.uint(101));

    setupBond(BOND_INDEX);
    expect(bindBond().type).toBe("ok");
    expect(poolConfig()["lane-id"]).toBe("0");
    expect(poolConfig().treasury).toBe(treasuryPrincipal());
    expect(Number(boundBond()["bond-index"])).toBe(BOND_INDEX);
  });

  it("rejects a bond from another modulo-six lane", () => {
    registerSignerManager();
    initializePool();
    setupBond(BOND_INDEX + 1);
    expect(bindBond(BOND_INDEX + 1)).toBeErr(Cl.uint(132));
  });

  it("keeps initial deposits withdrawable until stake", () => {
    bootstrap();
    const sbtcBefore = sbtcBalance(alice);
    const stxBefore = stxBalance(alice);
    expect(deposit(alice, ALICE_SATS).type).toBe("ok");
    expect(treasuryBalance()).toBe(ALICE_SATS);
    expect(withdraw(alice).type).toBe("ok");
    expect(sbtcBalance(alice)).toBe(sbtcBefore);
    expect(stxBalance(alice)).toBe(stxBefore);
  });

  it("closes initial deposits at the executable stake deadline without blocking withdrawal", () => {
    bootstrap();
    const deadline = Number(boundBond()["stake-closes-at"]);
    const aliceSbtc = sbtcBalance(alice);
    const aliceStx = stxBalance(alice);

    advanceToBurnHeight(deadline - 1);
    expect(deposit(alice, ALICE_SATS).type).toBe("ok");
    expect(Number(poolTotals()["queued-sats"])).toBe(ALICE_SATS);

    advanceToBurnHeight(deadline);
    const atDeadlinePool = poolTotals();
    const bobSbtc = sbtcBalance(bob);
    const bobStx = stxBalance(bob);
    expect(deposit(bob, BOB_SATS)).toBeErr(Cl.uint(109));
    expect(poolTotals()).toEqual(atDeadlinePool);
    expect(treasuryBalance()).toBe(ALICE_SATS);
    expect(member(bob)).toBeNull();
    expect(sbtcBalance(bob)).toBe(bobSbtc);
    expect(stxBalance(bob)).toBe(bobStx);

    advanceToBurnHeight(deadline + 1);
    const afterDeadlinePool = poolTotals();
    const carolSbtc = sbtcBalance(carol);
    const carolStx = stxBalance(carol);
    expect(deposit(carol, ALICE_SATS)).toBeErr(Cl.uint(109));
    expect(poolTotals()).toEqual(afterDeadlinePool);
    expect(treasuryBalance()).toBe(ALICE_SATS);
    expect(member(carol)).toBeNull();
    expect(sbtcBalance(carol)).toBe(carolSbtc);
    expect(stxBalance(carol)).toBe(carolStx);

    expect(withdraw(alice).type).toBe("ok");
    expect(poolTotals()).toMatchObject({
      "queued-sats": "0",
      "queued-ustx": "0",
    });
    expect(treasuryBalance()).toBe(0);
    expect(sbtcBalance(alice)).toBe(aliceSbtc);
    expect(stxBalance(alice)).toBe(aliceStx);
  });

  it("enforces the bound allowance on initial deposits", () => {
    bootstrap(ALICE_SATS);
    expect(deposit(alice, ALICE_SATS).type).toBe("ok");
    expect(deposit(bob, 1)).toBeErr(Cl.uint(105));
  });

  it("opens epoch zero with one share per deposited sat", () => {
    const { bondStart } = bootstrap();
    deposit(alice, ALICE_SATS);
    deposit(bob, BOB_SATS);

    expect(stake()).toBeErr(Cl.uint(108));
    advanceToBurnHeight(bondStart - 288);
    expect(stake(carol).type).toBe("ok");

    expect(Number(epoch(0)["total-shares"])).toBe(POOL_SATS);
    expect(Number(settledMember(alice).shares)).toBe(ALICE_SATS);
    expect(Number(settledMember(bob).shares)).toBe(BOB_SATS);
    expect(treasuryBalance()).toBe(0);
    expect(sbtcBalance(POX5)).toBe(POOL_SATS);
    expect(deposit(carol, 1)).toBeErr(Cl.uint(113));
  });
});

describe("explicit full-position rollover", () => {
  it("carries a committed member in full and releases a passive member in full", () => {
    stakeInitialPool();
    const aliceOldUstx = Number(settledMember(alice)["bonded-ustx"]);
    const bobOldUstx = Number(settledMember(bob)["bonded-ustx"]);
    const { cutoff } = bindNextBond(200_000);
    const aliceNewRequired = requiredUstx(ALICE_SATS);
    const stxBefore = stxBalance(alice);

    expect(commitRollover(alice).type).toBe("ok");
    expect(stxBalance(alice)).toBe(stxBefore - (aliceNewRequired - aliceOldUstx));
    expect(Number(stakePreview()["committed-sats"])).toBe(ALICE_SATS);
    expect(Number(stakePreview()["uncommitted-sats"])).toBe(BOB_SATS);

    advanceToBurnHeight(cutoff);
    expect(stake().type).toBe("ok");

    const aliceRecord = settledMember(alice);
    const bobRecord = settledMember(bob);
    expect(Number(aliceRecord.shares)).toBe(ALICE_SATS);
    expect(Number(aliceRecord["bonded-sats"])).toBe(ALICE_SATS);
    expect(Number(aliceRecord["bonded-ustx"])).toBe(aliceNewRequired);
    expect(Number(bobRecord.shares)).toBe(0);
    expect(Number(bobRecord["bonded-sats"])).toBe(0);
    expect(Number(bobRecord["released-sats"])).toBe(BOB_SATS);
    expect(Number(bobRecord["released-ustx"])).toBe(bobOldUstx);
    expect(treasuryBalance()).toBe(BOB_SATS);

    const bobSbtc = sbtcBalance(bob);
    const bobStx = stxBalance(bob);
    expect(claimPrincipal(bob).type).toBe("ok");
    expect(sbtcBalance(bob)).toBe(bobSbtc + BOB_SATS);
    expect(stxBalance(bob)).toBe(bobStx + bobOldUstx);
  });

  it("atomically adds sBTC and any STX shortfall to an incumbent commitment", () => {
    stakeInitialPool();
    const additional = 2_000_000;
    const target = ALICE_SATS + additional;
    const { cutoff } = bindNextBond(200_000);
    const required = requiredUstx(target);

    expect(commitRollover(alice, additional).type).toBe("ok");
    expect(Number(poolTotals()["committed-sats"])).toBe(target);
    advanceToBurnHeight(cutoff);
    expect(stake().type).toBe("ok");
    expect(Number(settledMember(alice).shares)).toBe(target);
    expect(Number(settledMember(alice)["bonded-ustx"])).toBe(required);
  });

  it("allows a new member to join through the same commitment path", () => {
    stakeInitialPool();
    const { cutoff } = bindNextBond();
    expect(commitRollover(carol, ALICE_SATS).type).toBe("ok");
    advanceToBurnHeight(cutoff);
    expect(stake().type).toBe("ok");

    expect(Number(settledMember(carol).shares)).toBe(ALICE_SATS);
    expect(Number(settledMember(alice).shares)).toBe(0);
    expect(Number(settledMember(bob).shares)).toBe(0);
    expect(Number(epoch(1)["total-shares"])).toBe(ALICE_SATS);
  });

  it("uses first-come reservations and lets a whale consume all capacity", () => {
    stakeInitialPool();
    const nextMax = BOB_SATS;
    const { cutoff } = bindNextBond(100_000, nextMax);

    expect(commitRollover(carol, nextMax).type).toBe("ok");
    expect(commitRollover(alice)).toBeErr(Cl.uint(105));
    expect(commitRollover(bob)).toBeErr(Cl.uint(105));
    expect(Number(stakePreview()["remaining-allocation"])).toBe(0);

    advanceToBurnHeight(cutoff);
    expect(stake().type).toBe("ok");
    expect(Number(settledMember(carol).shares)).toBe(nextMax);
  });

  it("rejects a complete position that does not fit instead of partially reserving it", () => {
    stakeInitialPool();
    bindNextBond(100_000, ALICE_SATS - 1);
    expect(commitRollover(alice)).toBeErr(Cl.uint(105));
    expect(Number(poolTotals()["committed-sats"])).toBe(0);
  });

  it("rejects duplicate commitments without changing reservations", () => {
    stakeInitialPool();
    bindNextBond();
    expect(commitRollover(alice).type).toBe("ok");
    const committed = Number(poolTotals()["committed-sats"]);
    expect(commitRollover(alice)).toBeErr(Cl.uint(130));
    expect(Number(poolTotals()["committed-sats"])).toBe(committed);
  });

  it("carries all member STX when the next ratio is lower", () => {
    stakeInitialPool();
    const oldUstx = Number(settledMember(alice)["bonded-ustx"]);
    const { cutoff } = bindNextBond(50_000);
    expect(requiredUstx(ALICE_SATS)).toBeLessThan(oldUstx);

    const before = stxBalance(alice);
    expect(commitRollover(alice).type).toBe("ok");
    expect(stxBalance(alice)).toBe(before);
    advanceToBurnHeight(cutoff);
    stake();

    expect(Number(settledMember(alice)["bonded-ustx"])).toBe(oldUstx);
    expect(Number(epoch(1)["staked-ustx"])).toBe(oldUstx);
  });

  it("fails rollover when nobody commits", () => {
    stakeInitialPool();
    const { cutoff } = bindNextBond();
    advanceToBurnHeight(cutoff);
    expect(stake()).toBeErr(Cl.uint(110));
    expect(Number(poolTotals()["bonded-sats"])).toBe(POOL_SATS);
  });
});

describe("commitment cancellation and exits", () => {
  it("cancels a commitment and refunds only its added assets", () => {
    stakeInitialPool();
    bindNextBond(200_000);
    const additional = 2_000_000;
    const sbtcBefore = sbtcBalance(alice);
    const stxBefore = stxBalance(alice);

    expect(commitRollover(alice, additional).type).toBe("ok");
    expect(Number(poolTotals()["committed-sats"])).toBe(ALICE_SATS + additional);
    expect(cancelRollover(alice).type).toBe("ok");

    expect(sbtcBalance(alice)).toBe(sbtcBefore);
    expect(stxBalance(alice)).toBe(stxBefore);
    expect(Number(poolTotals()["committed-sats"])).toBe(0);
    expect(Number(poolTotals()["queued-sats"])).toBe(0);
    expect(member(alice)["exit-epoch"]).toBeNull();
  });

  it("request-exit atomically cancels a commitment", () => {
    stakeInitialPool();
    const { cutoff } = bindNextBond(200_000);
    const additional = 2_000_000;
    const sbtcBefore = sbtcBalance(alice);
    const stxBefore = stxBalance(alice);

    commitRollover(alice, additional);
    expect(requestExit(alice).type).toBe("ok");
    expect(sbtcBalance(alice)).toBe(sbtcBefore);
    expect(stxBalance(alice)).toBe(stxBefore);
    expect(Number(poolTotals()["committed-sats"])).toBe(0);

    expect(commitRollover(bob).type).toBe("ok");
    advanceToBurnHeight(cutoff);
    stake();
    expect(Number(settledMember(alice)["released-sats"])).toBe(ALICE_SATS);
    expect(Number(settledMember(bob).shares)).toBe(BOB_SATS);
  });

  it("lets an incumbent request-exit after direct cancellation closes", () => {
    stakeInitialPool();
    const { cutoff } = bindNextBond(200_000);
    const additional = 2_000_000;
    const sbtcBefore = sbtcBalance(alice);
    const stxBefore = stxBalance(alice);
    expect(commitRollover(alice, additional).type).toBe("ok");

    advanceToBurnHeight(cutoff);
    expect(boundBond().stakeable).toBe(true);
    const committedBefore = Number(poolTotals()["committed-sats"]);
    const queuedBefore = Number(poolTotals()["queued-sats"]);
    const treasuryBefore = treasuryBalance();
    expect(cancelRollover(alice)).toBeErr(Cl.uint(133));
    expect(Number(poolTotals()["committed-sats"])).toBe(committedBefore);
    expect(Number(poolTotals()["queued-sats"])).toBe(queuedBefore);
    expect(treasuryBalance()).toBe(treasuryBefore);

    const result = requestExit(alice);
    expect(result.type).toBe("ok");
    expect(Number(plain(result)["exit-epoch"])).toBe(0);
    expect(sbtcBalance(alice)).toBe(sbtcBefore);
    expect(stxBalance(alice)).toBe(stxBefore);
    expect(Number(poolTotals()["committed-sats"])).toBe(0);
    expect(Number(poolTotals()["queued-sats"])).toBe(0);
    expect(Number(poolTotals()["exiting-sats"])).toBe(ALICE_SATS);
    expect(Number(member(alice)["exit-epoch"])).toBe(0);

    const failedState = poolTotals();
    const failedMember = member(alice);
    const failedSbtc = sbtcBalance(alice);
    const failedStx = stxBalance(alice);
    expect(requestExit(alice)).toBeErr(Cl.uint(123));
    expect(poolTotals()).toEqual(failedState);
    expect(member(alice)).toEqual(failedMember);
    expect(sbtcBalance(alice)).toBe(failedSbtc);
    expect(stxBalance(alice)).toBe(failedStx);
  });

  it("refunds a new member through request-exit at the cutoff without an exit liability", () => {
    stakeInitialPool();
    const { cutoff } = bindNextBond(200_000);
    const additional = 2_000_000;
    const sbtcBefore = sbtcBalance(carol);
    const stxBefore = stxBalance(carol);
    expect(commitRollover(carol, additional).type).toBe("ok");
    expect(claimablePrincipal(carol)).toMatchObject({
      "released-sats": "0",
      "released-ustx": "0",
      "queued-sats": String(additional),
    });
    expect(claimPrincipal(carol)).toBeErr(Cl.uint(114));

    advanceToBurnHeight(cutoff);
    const committedBefore = poolTotals();
    expect(cancelRollover(carol)).toBeErr(Cl.uint(133));
    expect(poolTotals()).toEqual(committedBefore);

    const result = requestExit(carol);
    expect(result.type).toBe("ok");
    expect(plain(result)["exit-epoch"]).toBeNull();
    expect(sbtcBalance(carol)).toBe(sbtcBefore);
    expect(stxBalance(carol)).toBe(stxBefore);
    expect(treasuryBalance()).toBe(0);
    expect(Number(poolTotals()["committed-sats"])).toBe(0);
    expect(Number(poolTotals()["queued-sats"])).toBe(0);
    expect(Number(poolTotals()["exiting-sats"])).toBe(0);
    expect(member(carol)["exit-epoch"]).toBeNull();
    expect(claimablePrincipal(carol)).toMatchObject({
      "released-sats": "0",
      "released-ustx": "0",
      "queued-sats": "0",
      "queued-ustx": "0",
    });
  });

  it("reopens direct cancellation when PoX prepare makes the bond unstakeable", () => {
    stakeInitialPool();
    bindNextBond(200_000);
    const additional = 2_000_000;
    const sbtcBefore = sbtcBalance(carol);
    const stxBefore = stxBalance(carol);
    expect(commitRollover(carol, additional).type).toBe("ok");

    advanceToBurnHeight(Number(boundBond()["stake-closes-at"]));
    expect(boundBond().stakeable).toBe(false);
    expect(cancelRollover(carol).type).toBe("ok");
    expect(sbtcBalance(carol)).toBe(sbtcBefore);
    expect(stxBalance(carol)).toBe(stxBefore);
    expect(Number(poolTotals()["committed-sats"])).toBe(0);
    expect(Number(poolTotals()["queued-sats"])).toBe(0);
  });

  it("keeps commitment and preview boundaries strictly before bond start", () => {
    stakeInitialPool();
    const { cutoff, start } = bindNextBond();

    expect(commitRollover(carol, ALICE_SATS).type).toBe("ok");
    advanceToBurnHeight(cutoff - 1);
    expect(cancelRollover(carol).type).toBe("ok");
    expect(rolloverPreview(carol, ALICE_SATS)["can-commit"]).toBe(true);

    advanceToBurnHeight(cutoff);
    expect(rolloverPreview(carol, ALICE_SATS)["can-commit"]).toBe(false);
    expect(commitRollover(carol, ALICE_SATS)).toBeErr(Cl.uint(133));

    advanceToBurnHeight(cutoff + 1);
    expect(rolloverPreview(carol, ALICE_SATS)["can-commit"]).toBe(false);
    expect(commitRollover(carol, ALICE_SATS)).toBeErr(Cl.uint(133));

    advanceToBurnHeight(start - 1);
    expect(rolloverPreview(carol, ALICE_SATS)["can-commit"]).toBe(false);
    expect(commitRollover(carol, ALICE_SATS)).toBeErr(Cl.uint(133));

    advanceToBurnHeight(start);
    expect(rolloverPreview(carol, ALICE_SATS)["can-commit"]).toBe(false);
    expect(commitRollover(carol, ALICE_SATS)).toBeErr(Cl.uint(109));

    advanceToBurnHeight(start + 1);
    expect(rolloverPreview(carol, ALICE_SATS)["can-commit"]).toBe(false);
    expect(commitRollover(carol, ALICE_SATS)).toBeErr(Cl.uint(109));
  });

  it("rejects a late bind with no executable stake block", () => {
    stakeInitialPool();
    setupBond(12);
    const start = bondStartHeight(12);
    const prepareLength = Number(poxInfo()["prepare-cycle-length"]);
    advanceToBurnHeight(start - prepareLength - BIND_NOTICE);

    expect(bindBond(12)).toBeErr(Cl.uint(109));
    expect(boundBond().bound).toBe(false);
    expect(Number(poolTotals()["committed-sats"])).toBe(0);
    expect(Number(poolTotals()["queued-sats"])).toBe(0);
    expect(treasuryBalance()).toBe(0);
  });

  it("accepts the latest bind that leaves one executable stake block", () => {
    stakeInitialPool();
    setupBond(12);
    const start = bondStartHeight(12);
    const stakeDeadline = start - Number(poxInfo()["prepare-cycle-length"]);
    advanceToBurnHeight(stakeDeadline - BIND_NOTICE - 1);

    expect(bindBond(12).type).toBe("ok");
    expect(Number(boundBond()["notice-ends-at"])).toBe(stakeDeadline - 1);
    expect(Number(boundBond()["rollover-cutoff"])).toBe(stakeDeadline - 1);
    expect(Number(boundBond()["stake-closes-at"])).toBe(stakeDeadline);
    expect(commitRollover(alice).type).toBe("ok");
    advanceToBurnHeight(stakeDeadline - 1);
    expect(stake().type).toBe("ok");
  });

  it("replaces a missed bond without carrying stale reservations", () => {
    stakeInitialPool();
    const { start } = bindNextBond(200_000);
    commitRollover(alice, 2_000_000);
    advanceToBurnHeight(start + 1);

    const replacement = bindNextBond(100_000, MAX_SATS, 18);
    expect(Number(poolTotals()["committed-sats"])).toBe(0);
    expect(commitRollover(bob).type).toBe("ok");
    expect(Number(poolTotals()["committed-sats"])).toBe(BOB_SATS);
    expect(commitRollover(alice)).toBeErr(Cl.uint(130));
    expect(cancelRollover(alice).type).toBe("ok");
    expect(Number(poolTotals()["committed-sats"])).toBe(BOB_SATS);
    expect(commitRollover(alice).type).toBe("ok");
    expect(replacement.index).toBe(18);
  });

  it("lets a stale missed-bond commitment recover its additions", () => {
    stakeInitialPool();
    const { start } = bindNextBond(200_000);
    const additional = 2_000_000;
    const sbtcBefore = sbtcBalance(alice);
    const stxBefore = stxBalance(alice);
    commitRollover(alice, additional);

    advanceToBurnHeight(start + 1);
    expect(cancelRollover(alice).type).toBe("ok");
    expect(sbtcBalance(alice)).toBe(sbtcBefore);
    expect(stxBalance(alice)).toBe(stxBefore);
    expect(Number(poolTotals()["bonded-sats"])).toBe(POOL_SATS);
    expect(Number(poolTotals()["committed-sats"])).toBe(0);
    expect(Number(poolTotals()["queued-sats"])).toBe(0);
    expect(treasuryBalance()).toBe(0);
  });
});

describe("rewards, wind-down, authority, and treasury isolation", () => {
  it("permissionlessly preserves timely prior-bond rewards for a member not rolled", () => {
    stakeInitialPool();
    const firstReward = 4_000_000;
    payRewards(carol, firstReward);
    expect(syncRewards(dave).type).toBe("ok");
    expect(claimRewards(bob).type).toBe("ok");

    const { cutoff } = bindNextBond();
    commitRollover(alice);
    advanceToBurnHeight(cutoff);
    stake();

    const tail = 1_200_000;
    payRewards(dave, tail);
    expect(syncRewards(carol).type).toBe("ok");
    expect(claimableRewards(bob)).toBe((tail * BOB_SATS) / POOL_SATS);
    expect(Number(settledMember(bob).shares)).toBe(0);
    expect(claimRewards(bob).type).toBe("ok");
  });

  it("winds down permissionlessly and releases all principal", () => {
    const { unlockHeight } = stakeInitialPool();
    advanceToBurnHeight(unlockHeight);
    expect(unstakeSbtc(carol).type).toBe("ok");
    expect(poolConfig().finished).toBe(true);
    expect(treasuryBalance()).toBe(POOL_SATS);
    expect(claimPrincipal(alice).type).toBe("ok");
    expect(claimPrincipal(bob).type).toBe("ok");
    expect(treasuryBalance()).toBe(0);
  });

  it("keeps binding operator-only and staking permissionless", () => {
    const { bondStart } = bootstrap();
    expect(bindBond(BOND_INDEX, MAX_SATS, alice)).toBeErr(Cl.uint(100));
    deposit(alice, ALICE_SATS);
    advanceToBurnHeight(bondStart - 288);
    expect(stake(carol).type).toBe("ok");
  });

  it("rotates the keyed operator without granting principal access", () => {
    bootstrap();
    expect(updateOperator(alice, true).type).toBe("ok");
    expect(updateOperator(deployer, false, alice).type).toBe("ok");
    expect(bindBond(BOND_INDEX, MAX_SATS, deployer)).toBeErr(Cl.uint(100));
    expect(bindBond(BOND_INDEX, MAX_SATS, alice)).toBeErr(Cl.uint(119));
  });

  it("moves a live position only to a registered trusted signer manager", () => {
    stakeInitialPool();
    expect(registerSignerManager(ALT_MANAGER, 2).type).toBe("ok");
    expect(updateBondRegistration(ALT_MANAGER, undefined, alice)).toBeErr(
      Cl.uint(100),
    );
    expect(updateBondRegistration().type).toBe("ok");
    expect(poolConfig()["signer-manager"]).toBe(managerPrincipal(ALT_MANAGER));
  });

  it("treasury accepts payout instructions only from its paired staker", () => {
    bootstrap();
    deposit(alice, ALICE_SATS);
    expect(
      simnet.callPublicFn(
        TREASURY,
        "payout",
        [Cl.uint(1), Cl.principal(alice)],
        deployer,
      ).result,
    ).toBeErr(Cl.uint(200));
    expect(
      plain(
        simnet.callReadOnlyFn(TREASURY, "get-controller", [], deployer).result,
      ),
    ).toBe(poolPrincipal());
  });

  it("retains signer-manager registration in the PoX position", () => {
    stakeInitialPool();
    const membership = plain(
      simnet.callReadOnlyFn(
        POX5,
        "get-bond-membership",
        [Cl.principal(poolPrincipal())],
        deployer,
      ).result,
    ) as any;
    expect(membership.signer).toBe(managerPrincipal());
    expect(Number(membership["amount-sats"])).toBe(POOL_SATS);
  });
});
