import { Cl } from "@stacks/transactions";
import { describe, expect, it } from "vitest";
import {
  BOND_INDEX,
  CALLBACK_MANAGER,
  advanceToBurnHeight,
  bindNextBond,
  bootstrap,
  claimRewards,
  commitRollover,
  deployer,
  deposit,
  epoch,
  managerPrincipal,
  payRewards,
  plain,
  poolConfig,
  poolPrincipal,
  poolTotals,
  readPox,
  registerSignerManager,
  sbtcBalance,
  setCallbackTarget,
  setValidationMode,
  settledMember,
  stake,
  stakeFirstBond,
  syncRewards,
  treasuryBalance,
  trustSignerManager,
  updateBondRegistration,
  validationState,
} from "./helpers/bond-fixture";

const accounts = simnet.getAccounts();
const alice = accounts.get("wallet_1")!;
const rewardPayer = accounts.get("wallet_4")!;

const INITIAL_SATS = 10_000_000;
const ADDED_SATS = 2_000_000;
const TARGET_SATS = INITIAL_SATS + ADDED_SATS;
const TRANSITION_ERROR = 134;

function prepareGrowingRollover() {
  stakeFirstBond([[alice, INITIAL_SATS]], CALLBACK_MANAGER);
  const { cutoff } = bindNextBond();
  expect(commitRollover(alice, ADDED_SATS).type).toBe("ok");
  return { cutoff };
}

function poxMembership() {
  return plain(
    readPox("get-bond-membership", [Cl.principal(poolPrincipal())]),
  ) as any;
}

describe("PoX signer callback transition guard", () => {
  it("prevents a nested reward sync from crediting in-flight principal", () => {
    const { cutoff } = prepareGrowingRollover();
    expect(setValidationMode(1).type).toBe("ok");

    advanceToBurnHeight(cutoff);
    expect(stake(deployer, CALLBACK_MANAGER).type).toBe("ok");

    expect(Number(validationState().errors["sync-rewards"])).toBe(
      TRANSITION_ERROR,
    );
    expect(Number(epoch(1)["staked-sats"])).toBe(TARGET_SATS);
    expect(Number(settledMember(alice).shares)).toBe(TARGET_SATS);
    expect(Number(poolTotals()["total-credited"])).toBe(0);
    expect(Number(poolTotals()["unclaimed-rewards"])).toBe(0);
    expect(sbtcBalance(poolPrincipal())).toBe(0);

    const reward = 1_200_000;
    expect(payRewards(rewardPayer, reward).type).toBe("ok");
    expect(syncRewards().type).toBe("ok");
    expect(Number(poolTotals()["total-credited"])).toBe(reward);
    expect(claimRewards(alice).type).toBe("ok");
  });

  it("rejects reward, claim, settlement, and nested protocol callbacks", () => {
    const { cutoff } = prepareGrowingRollover();
    expect(setCallbackTarget(alice).type).toBe("ok");
    expect(setValidationMode(4).type).toBe("ok");

    advanceToBurnHeight(cutoff);
    expect(stake(deployer, CALLBACK_MANAGER).type).toBe("ok");

    expect(validationState().errors).toEqual({
      "sync-rewards": String(TRANSITION_ERROR),
      "claim-rewards": String(TRANSITION_ERROR),
      "claim-principal": String(TRANSITION_ERROR),
      "settle-member": String(TRANSITION_ERROR),
      "nested-unstake": String(TRANSITION_ERROR),
    });
    expect(Number(poolTotals()["total-credited"])).toBe(0);
    expect(Number(poolTotals()["unclaimed-rewards"])).toBe(0);
    expect(Number(epoch(1)["staked-sats"])).toBe(TARGET_SATS);
    expect(Number(settledMember(alice).shares)).toBe(TARGET_SATS);
    expect(treasuryBalance()).toBe(0);
    expect(Number(poxMembership()["amount-sats"])).toBe(TARGET_SATS);
  });

  it("protects signer registration updates without breaking rotation", () => {
    const { bondStart } = bootstrap();
    expect(registerSignerManager(CALLBACK_MANAGER, 3).type).toBe("ok");
    expect(trustSignerManager(CALLBACK_MANAGER).type).toBe("ok");
    expect(deposit(alice, INITIAL_SATS).type).toBe("ok");
    advanceToBurnHeight(bondStart - 288);
    expect(stake().type).toBe("ok");

    expect(setValidationMode(1).type).toBe("ok");
    expect(updateBondRegistration(CALLBACK_MANAGER).type).toBe("ok");
    expect(poolConfig()["signer-manager"]).toBe(
      managerPrincipal(CALLBACK_MANAGER),
    );
    expect(Number(validationState().errors["sync-rewards"])).toBe(
      TRANSITION_ERROR,
    );
    expect(Number(poolTotals()["total-credited"])).toBe(0);

    // The transition guard is cleared after the update.
    expect(payRewards(rewardPayer, 100_000).type).toBe("ok");
    expect(syncRewards().type).toBe("ok");
  });

  it.each([
    { mode: 2, error: TRANSITION_ERROR, label: "propagated callback" },
    { mode: 3, error: 9001, label: "manager rejection" },
  ])("rolls back a $label failure and clears the guard", ({ mode, error }) => {
    const { cutoff } = prepareGrowingRollover();
    expect(setValidationMode(mode).type).toBe("ok");
    expect(treasuryBalance()).toBe(ADDED_SATS);

    advanceToBurnHeight(cutoff);
    expect(stake(deployer, CALLBACK_MANAGER)).toBeErr(Cl.uint(error));

    expect(Number(poolConfig()["epoch-count"])).toBe(1);
    expect(Number(poolTotals()["committed-sats"])).toBe(TARGET_SATS);
    expect(Number(poolTotals()["queued-sats"])).toBe(ADDED_SATS);
    expect(treasuryBalance()).toBe(ADDED_SATS);
    expect(sbtcBalance(poolPrincipal())).toBe(0);
    expect(Number(poxMembership()["bond-index"])).toBe(BOND_INDEX);
    expect(Number(poxMembership()["amount-sats"])).toBe(INITIAL_SATS);

    // A successful retry proves the failed transaction did not leave the
    // transition flag set. The commitment and treasury payout are still live.
    expect(setValidationMode(0).type).toBe("ok");
    expect(stake(deployer, CALLBACK_MANAGER).type).toBe("ok");
    expect(Number(epoch(1)["staked-sats"])).toBe(TARGET_SATS);
    expect(treasuryBalance()).toBe(0);
    expect(Number(poolTotals()["total-credited"])).toBe(0);
  });
});
