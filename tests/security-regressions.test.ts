import { Cl } from "@stacks/transactions";
import { describe, expect, it } from "vitest";
import {
  BOND_INDEX,
  CALLBACK_MANAGER,
  MAX_SATS,
  TEST_CALLER,
  advanceToBurnHeight,
  bindBond,
  bindNextBond,
  bondStartHeight,
  bootstrap,
  boundBond,
  cancelExit,
  cancelRollover,
  claimPrincipal,
  claimRewards,
  claimableRewards,
  commitRollover,
  deployer,
  deposit,
  distrustSignerManager,
  epoch,
  initializePool,
  managerPrincipal,
  member,
  payRewards,
  plain,
  poolConfig,
  poolPrincipal,
  poolTotals,
  readPool,
  readPoxNum,
  registerSignerManager,
  requestExit,
  requiredUstx,
  sbtcBalance,
  setupBond,
  settleMember,
  settledMember,
  signerHash,
  stake,
  stakeFirstBond,
  stxBalance,
  sweepUnattributedPrincipal,
  syncRewards,
  testCallerPrincipal,
  transferSbtc,
  treasuryBalance,
  treasuryPrincipal,
  trustSignerManager,
  unattributedPrincipal,
  unrecognizedRewards,
  unstakeSbtc,
  updateBondRegistration,
  updateOperator,
} from "./helpers/bond-fixture";

const accounts = simnet.getAccounts();
const alice = accounts.get("wallet_1")!;
const bob = accounts.get("wallet_2")!;
const carol = accounts.get("wallet_3")!;
const dave = accounts.get("wallet_4")!;

const ALICE_SATS = 10_000_000;
const ADDED_SATS = 2_000_000;

const callFixture = (fn: string, args: any[], sender = deployer) =>
  simnet.callPublicFn(TEST_CALLER, fn, args, sender).result;

function prepareDelayedReplacement(additionalSats = 0) {
  const { unlockHeight } = stakeFirstBond([[alice, ALICE_SATS]]);
  const missed = bindNextBond(undefined, MAX_SATS, 12);
  advanceToBurnHeight(missed.start + 1);
  const delayed = bindNextBond(undefined, MAX_SATS, 18);
  expect(commitRollover(alice, additionalSats).type).toBe("ok");
  expect(simnet.burnBlockHeight).toBeGreaterThanOrEqual(unlockHeight);
  advanceToBurnHeight(delayed.cutoff);
  return { delayed, unlockHeight };
}

describe("reward flooring and funded reserve", () => {
  it("permanently locks repeated half-satoshi member entitlements after settlement", () => {
    stakeFirstBond([
      [alice, 1],
      [bob, 1],
    ]);

    for (let payout = 0; payout < 2; payout += 1) {
      expect(payRewards(carol, 1).type).toBe("ok");
      expect(syncRewards(dave).type).toBe("ok");
      expect(settleMember(alice, bob).type).toBe("ok");
      expect(settleMember(bob, carol).type).toBe("ok");
      expect(claimableRewards(alice)).toBe(0);
      expect(claimableRewards(bob)).toBe(0);
    }

    expect(poolTotals()).toMatchObject({
      "total-credited": "2",
      "total-paid": "0",
      "unclaimed-rewards": "2",
    });
    expect(sbtcBalance(poolPrincipal())).toBe(2);
    expect(unrecognizedRewards()).toBe(0);
    expect(claimRewards(alice)).toBeErr(Cl.uint(114));
    expect(claimRewards(bob)).toBeErr(Cl.uint(114));
  });

  it("keeps repeated unequal-share claims within the recognized funded reserve", () => {
    stakeFirstBond([
      [alice, 3],
      [bob, 7],
    ]);

    for (const payout of [1, 2, 1, 7, 3, 11]) {
      expect(payRewards(carol, payout).type).toBe("ok");
      expect(syncRewards(dave).type).toBe("ok");
      expect(settleMember(alice).type).toBe("ok");
      expect(settleMember(bob).type).toBe("ok");
    }

    const reserve = Number(poolTotals()["unclaimed-rewards"]);
    const realizable = claimableRewards(alice) + claimableRewards(bob);
    expect(realizable).toBeLessThanOrEqual(reserve);
    expect(reserve).toBeLessThanOrEqual(sbtcBalance(poolPrincipal()));

    const paidBefore = Number(poolTotals()["total-paid"]);
    if (claimableRewards(alice) > 0) expect(claimRewards(alice).type).toBe("ok");
    if (claimableRewards(bob) > 0) expect(claimRewards(bob).type).toBe("ok");
    expect(Number(poolTotals()["total-paid"]) - paidBefore).toBe(realizable);
    expect(Number(poolTotals()["unclaimed-rewards"])).toBe(
      reserve - realizable,
    );
    expect(sbtcBalance(poolPrincipal())).toBe(reserve - realizable);
  });

  it("assigns a prior payout to current shares only after the one-cycle tail expires", () => {
    stakeFirstBond([
      [alice, 1],
      [bob, 3],
    ]);
    const { cutoff } = bindNextBond();
    expect(commitRollover(alice).type).toBe("ok");
    advanceToBurnHeight(cutoff);
    expect(stake().type).toBe("ok");

    const tailCloses = readPoxNum("reward-cycle-to-burn-height", [
      Cl.uint(Number(epoch(1)["first-reward-cycle"]) + 1),
    ]);
    advanceToBurnHeight(tailCloses);

    expect(payRewards(carol, 8).type).toBe("ok");
    const synchronization = syncRewards(dave);
    expect(synchronization.type).toBe("ok");
    expect(Number(plain(synchronization).epoch)).toBe(1);
    expect(claimableRewards(alice)).toBe(8);
    expect(claimableRewards(bob)).toBe(0);
  });
});

describe("effective sender behavior", () => {
  it("preserves a standard origin through an ordinary forwarding contract", () => {
    bootstrap();
    const aliceBefore = sbtcBalance(alice);

    expect(
      callFixture("forward-deposit", [Cl.uint(ALICE_SATS)], alice).type,
    ).toBe("ok");
    expect(Number(member(alice)["queued-sats"])).toBe(ALICE_SATS);
    expect(member(testCallerPrincipal())).toBeNull();

    expect(callFixture("forward-withdraw", [], alice).type).toBe("ok");
    expect(sbtcBalance(alice)).toBe(aliceBefore);
    expect(treasuryBalance()).toBe(0);
  });

  it("lets an ordinary forwarder exercise only the origin operator's authority", () => {
    expect(registerSignerManager().type).toBe("ok");
    expect(initializePool().type).toBe("ok");
    setupBond();

    expect(
      callFixture(
        "forward-bind-bond",
        [Cl.uint(BOND_INDEX), Cl.uint(MAX_SATS), Cl.uint(0)],
        alice,
      ),
    ).toBeErr(Cl.uint(100));
    expect(
      callFixture("forward-bind-bond", [
        Cl.uint(BOND_INDEX),
        Cl.uint(MAX_SATS),
        Cl.uint(0),
      ]).type,
    ).toBe("ok");
  });

  it("uses the contract principal as owner when a wallet invokes as-contract", () => {
    bootstrap();
    const wallet = testCallerPrincipal();
    const ustx = requiredUstx(ALICE_SATS);
    expect(transferSbtc(alice, wallet, ALICE_SATS).type).toBe("ok");
    expect(simnet.transferSTX(ustx, wallet, alice).result.type).toBe("ok");

    expect(
      callFixture(
        "wallet-deposit",
        [Cl.uint(ALICE_SATS), Cl.uint(ustx)],
        dave,
      ).type,
    ).toBe("ok");
    expect(Number(member(wallet)["queued-sats"])).toBe(ALICE_SATS);
    expect(member(dave)).toBeNull();
    expect(member(alice)).toBeNull();

    expect(callFixture("wallet-withdraw", [], carol).type).toBe("ok");
    expect(sbtcBalance(wallet)).toBe(ALICE_SATS);
    expect(stxBalance(wallet)).toBe(ustx);
  });

  it("supports explicit operator handover to a contract wallet", () => {
    bootstrap();
    const wallet = testCallerPrincipal();
    expect(updateOperator(wallet, true).type).toBe("ok");
    expect(
      callFixture(
        "wallet-update-operator",
        [Cl.principal(alice), Cl.bool(true)],
        dave,
      ).type,
    ).toBe("ok");
    expect(plain(readPool("is-operator", [Cl.principal(alice)]))).toBe(true);

    expect(updateOperator(deployer, false, alice).type).toBe("ok");
    expect(plain(readPool("is-operator", [Cl.principal(deployer)]))).toBe(
      false,
    );
    expect(
      callFixture(
        "wallet-update-operator",
        [Cl.principal(wallet), Cl.bool(false)],
        bob,
      ),
    ).toBeErr(Cl.uint(100));
  });
});

describe("best-effort delayed replacement and bounded release", () => {
  it("continues into the delayed bond when stake wins transaction ordering", () => {
    const { delayed } = prepareDelayedReplacement();
    expect(stake().type).toBe("ok");
    expect(Number(epoch(1)["bond-index"])).toBe(delayed.index);
    expect(poolConfig().finished).toBe(false);
    expect(unstakeSbtc(carol)).toBeErr(Cl.uint(108));
  });

  it("winds down safely when permissionless release wins transaction ordering", () => {
    const aliceSbtc = sbtcBalance(alice);
    const aliceStx = stxBalance(alice);
    prepareDelayedReplacement(ADDED_SATS);

    expect(unstakeSbtc(carol).type).toBe("ok");
    expect(poolConfig().finished).toBe(true);
    expect(boundBond().bound).toBe(false);
    expect(stake()).toBeErr(Cl.uint(118));
    expect(treasuryBalance()).toBe(ALICE_SATS + ADDED_SATS);

    expect(claimPrincipal(alice, dave).type).toBe("ok");
    expect(cancelRollover(alice).type).toBe("ok");
    expect(sbtcBalance(alice)).toBe(aliceSbtc);
    expect(stxBalance(alice)).toBe(aliceStx);
    expect(treasuryBalance()).toBe(0);
  });

  it("does not let repeated missed bindings postpone old principal release", () => {
    const { unlockHeight } = stakeFirstBond([[alice, ALICE_SATS]]);
    for (const index of [12, 18]) {
      const pending = bindNextBond(undefined, MAX_SATS, index);
      advanceToBurnHeight(pending.start + 1);
    }
    const latest = bindNextBond(undefined, MAX_SATS, 24);
    expect(simnet.burnBlockHeight).toBeGreaterThanOrEqual(unlockHeight);
    expect(latest.index).toBe(24);

    expect(unstakeSbtc(bob).type).toBe("ok");
    expect(poolConfig().finished).toBe(true);
    expect(Number(settledMember(alice)["released-sats"])).toBe(ALICE_SATS);
  });
});

describe("retained financial and control paths", () => {
  it("cancels and restores an exit before rollover", () => {
    stakeFirstBond([[alice, ALICE_SATS]]);
    expect(requestExit(alice).type).toBe("ok");
    expect(Number(poolTotals()["exiting-sats"])).toBe(ALICE_SATS);
    expect(cancelExit(alice).type).toBe("ok");
    expect(Number(poolTotals()["exiting-sats"])).toBe(0);
    expect(member(alice)["exit-epoch"]).toBeNull();
    expect(cancelExit(alice)).toBeErr(Cl.uint(122));
  });

  it("delays trusted manager adoption until rollover and distrusts immediately", () => {
    stakeFirstBond([[alice, ALICE_SATS]]);
    expect(registerSignerManager(CALLBACK_MANAGER, 3).type).toBe("ok");
    const hash = signerHash(CALLBACK_MANAGER);
    expect(hash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(trustSignerManager(CALLBACK_MANAGER, alice)).toBeErr(Cl.uint(100));
    expect(trustSignerManager(CALLBACK_MANAGER).type).toBe("ok");
    expect(plain(readPool("can-use-signer-manager", [
      Cl.principal(managerPrincipal(CALLBACK_MANAGER)),
    ]))).toBe(false);
    expect(updateBondRegistration(CALLBACK_MANAGER)).toBeErr(Cl.uint(126));
    expect(trustSignerManager(CALLBACK_MANAGER)).toBeErr(Cl.uint(127));

    const { cutoff } = bindNextBond();
    expect(commitRollover(alice).type).toBe("ok");
    advanceToBurnHeight(cutoff);
    expect(stake().type).toBe("ok");
    expect(plain(readPool("can-use-signer-manager", [
      Cl.principal(managerPrincipal(CALLBACK_MANAGER)),
    ]))).toBe(true);

    expect(distrustSignerManager(CALLBACK_MANAGER, alice)).toBeErr(Cl.uint(100));
    expect(distrustSignerManager(CALLBACK_MANAGER).type).toBe("ok");
    expect(updateBondRegistration(CALLBACK_MANAGER)).toBeErr(Cl.uint(126));
    expect(distrustSignerManager(CALLBACK_MANAGER)).toBeErr(Cl.uint(126));
  });

  it("sweeps only unaccounted treasury transfers without touching principal", () => {
    bootstrap();
    expect(deposit(alice, ALICE_SATS).type).toBe("ok");
    const extra = 750_000;
    expect(transferSbtc(carol, treasuryPrincipal(), extra).type).toBe("ok");
    expect(unattributedPrincipal()).toBe(extra);
    expect(treasuryBalance()).toBe(ALICE_SATS + extra);
    expect(sweepUnattributedPrincipal(dave, alice)).toBeErr(Cl.uint(100));

    const daveBefore = sbtcBalance(dave);
    expect(sweepUnattributedPrincipal(dave).type).toBe("ok");
    expect(sbtcBalance(dave)).toBe(daveBefore + extra);
    expect(treasuryBalance()).toBe(ALICE_SATS);
    expect(unattributedPrincipal()).toBe(0);
  });

  it("rolls back an initial deposit when the member lacks sBTC", () => {
    bootstrap();
    const aliceInitial = sbtcBalance(alice);
    expect(transferSbtc(alice, bob, aliceInitial - 1).type).toBe("ok");
    const before = poolTotals();
    expect(deposit(alice, ALICE_SATS).type).toBe("err");
    expect(poolTotals()).toEqual(before);
    expect(member(alice)).toBeNull();
    expect(treasuryBalance()).toBe(0);
    expect(sbtcBalance(alice)).toBe(1);
  });

  it("rolls back the sBTC leg when the member lacks required STX", () => {
    bootstrap();
    const required = requiredUstx(ALICE_SATS);
    const balance = stxBalance(alice);
    expect(
      simnet.transferSTX(balance - required + 1, bob, alice).result.type,
    ).toBe("ok");
    const aliceSbtc = sbtcBalance(alice);

    expect(deposit(alice, ALICE_SATS).type).toBe("err");
    expect(member(alice)).toBeNull();
    expect(treasuryBalance()).toBe(0);
    expect(sbtcBalance(alice)).toBe(aliceSbtc);
    expect(stxBalance(alice)).toBe(required - 1);
  });

  it("preserves commitments when PoX prepare closes the stake interval", () => {
    stakeFirstBond([[alice, ALICE_SATS]]);
    bindNextBond();
    expect(commitRollover(alice, ADDED_SATS).type).toBe("ok");
    const before = poolTotals();
    const treasuryBefore = treasuryBalance();

    advanceToBurnHeight(Number(boundBond()["stake-closes-at"]));
    expect(stake()).toBeErr(Cl.uint(109));
    expect(poolTotals()).toEqual(before);
    expect(treasuryBalance()).toBe(treasuryBefore);
    expect(cancelRollover(alice).type).toBe("ok");
  });

  it("enforces launch-floor restrictions and starts a zero-floor pool", () => {
    expect(registerSignerManager().type).toBe("ok");
    expect(initializePool().type).toBe("ok");
    setupBond();
    expect(bindBond(BOND_INDEX, MAX_SATS, deployer, 1)).toBeErr(Cl.uint(116));
    expect(bindBond(BOND_INDEX, MAX_SATS, deployer, MAX_SATS + 1)).toBeErr(
      Cl.uint(116),
    );
    expect(bindBond().type).toBe("ok");
    expect(deposit(alice, 1).type).toBe("ok");
    advanceToBurnHeight(bondStartHeight(BOND_INDEX) - 288);
    expect(stake().type).toBe("ok");
  });

  it("allows permissionless pay-to-member principal claims exactly once", () => {
    const { unlockHeight } = stakeFirstBond([[alice, ALICE_SATS]]);
    advanceToBurnHeight(unlockHeight);
    expect(unstakeSbtc(carol).type).toBe("ok");
    const before = sbtcBalance(alice);
    expect(claimPrincipal(alice, dave).type).toBe("ok");
    expect(sbtcBalance(alice)).toBe(before + ALICE_SATS);
    expect(claimPrincipal(alice, bob)).toBeErr(Cl.uint(114));
  });

  it("keeps the pool reward balance free of principal through wind-down", () => {
    const { unlockHeight } = stakeFirstBond([[alice, ALICE_SATS]]);
    expect(payRewards(carol, 123_456).type).toBe("ok");
    expect(unrecognizedRewards()).toBe(123_456);
    advanceToBurnHeight(unlockHeight);
    expect(unstakeSbtc(dave).type).toBe("ok");
    expect(unrecognizedRewards()).toBe(123_456);
    expect(treasuryBalance()).toBe(ALICE_SATS);
    expect(sbtcBalance(poolPrincipal())).toBe(123_456);
  });
});
