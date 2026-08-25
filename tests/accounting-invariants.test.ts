import { Cl } from "@stacks/transactions";
import { describe, expect, it } from "vitest";
import {
  POX5,
  advanceToBurnHeight,
  bindNextBond,
  bootstrap,
  cancelRollover,
  claimPrincipal,
  claimRewards,
  claimableRewards,
  commitRollover,
  deployer,
  deposit,
  epoch,
  member,
  payRewards,
  plain,
  poolConfig,
  poolPrincipal,
  poolTotals,
  requestExit,
  sbtcBalance,
  settleMember,
  settledMember,
  stake,
  sweepUnattributedPrincipal,
  syncRewards,
  treasuryBalance,
  unattributedPrincipal,
  unrecognizedRewards,
  withdraw,
} from "./helpers/bond-fixture";

const accounts = simnet.getAccounts();
const alice = accounts.get("wallet_1")!;
const bob = accounts.get("wallet_2")!;
const carol = accounts.get("wallet_3")!;
const dave = accounts.get("wallet_4")!;
const actors = [alice, bob, carol];

const value = (record: any, field: string) => Number(record[field]);

function assertAccounting(memberPrincipals: string[]) {
  const pool = poolTotals();
  const records = memberPrincipals
    .map((who) => settledMember(who))
    .filter((record) => record !== null);
  const sum = (field: string) =>
    records.reduce((total, record) => total + value(record, field), 0);

  expect(treasuryBalance()).toBe(
    value(pool, "queued-sats") +
      value(pool, "released-sats") +
      unattributedPrincipal(),
  );
  expect(sum("queued-sats")).toBe(value(pool, "queued-sats"));
  expect(sum("queued-ustx")).toBe(value(pool, "queued-ustx"));
  expect(sum("released-sats")).toBe(value(pool, "released-sats"));
  expect(sum("released-ustx")).toBe(value(pool, "released-ustx"));
  expect(sum("bonded-sats")).toBe(value(pool, "bonded-sats"));
  expect(sum("bonded-ustx")).toBe(value(pool, "bonded-ustx"));

  expect(value(pool, "committed-old-sats") + value(pool, "committed-added-sats"))
    .toBe(value(pool, "committed-sats"));
  expect(value(pool, "committed-old-ustx") + value(pool, "committed-added-ustx"))
    .toBe(value(pool, "committed-ustx"));

  const reserve = value(pool, "total-credited") - value(pool, "total-paid");
  expect(reserve).toBe(value(pool, "unclaimed-rewards"));
  expect(reserve).toBeLessThanOrEqual(sbtcBalance(poolPrincipal()));
  expect(reserve + unrecognizedRewards()).toBe(sbtcBalance(poolPrincipal()));

  const config = poolConfig();
  const epochCount = Number(config["epoch-count"]);
  if (epochCount > 0 && !config.finished) {
    expect(sum("shares")).toBe(value(epoch(epochCount - 1), "total-shares"));
    const membership = plain(
      simnet.callReadOnlyFn(
        POX5,
        "get-bond-membership",
        [Cl.principal(poolPrincipal())],
        deployer,
      ).result,
    ) as any;
    expect(Number(membership["amount-sats"])).toBe(value(pool, "bonded-sats"));
  }
}

describe("per-instance accounting properties", () => {
  it.each([
    { label: "tiny indivisible positions", amounts: [1, 1] },
    { label: "unequal prime positions", amounts: [101, 203, 509] },
    { label: "large unequal positions", amounts: [1_000_003, 2_000_033, 3_000_077] },
  ])("conserves principal, shares, commitments, and rewards for $label", ({ amounts }) => {
    const members = actors.slice(0, amounts.length);
    const { bondStart } = bootstrap();

    for (const [index, who] of members.entries()) {
      expect(deposit(who, amounts[index]).type).toBe("ok");
    }
    assertAccounting(members);

    const last = members.at(-1)!;
    expect(withdraw(last).type).toBe("ok");
    expect(deposit(last, amounts.at(-1)!).type).toBe("ok");
    assertAccounting(members);

    advanceToBurnHeight(bondStart - 288);
    expect(stake().type).toBe("ok");
    assertAccounting(members);

    for (const payout of [7, amounts.reduce((a, b) => a + b, 0) + 17, 11]) {
      expect(payRewards(dave, payout).type).toBe("ok");
      expect(syncRewards(carol).type).toBe("ok");
      for (const who of members) expect(settleMember(who, bob).type).toBe("ok");
      assertAccounting(members);
    }

    const { cutoff } = bindNextBond(120_000);
    const addition = (amounts[0] % 13) + 1;
    expect(commitRollover(members[0], addition).type).toBe("ok");
    if (members.length > 1) {
      expect(commitRollover(members[1]).type).toBe("ok");
      expect(cancelRollover(members[1]).type).toBe("ok");
      expect(requestExit(members[1]).type).toBe("ok");
    }
    assertAccounting(members);

    const beforeRejected = poolTotals();
    expect(commitRollover(members[0])).toBeErr(Cl.uint(130));
    expect(sweepUnattributedPrincipal(dave, carol)).toBeErr(Cl.uint(100));
    expect(poolTotals()).toEqual(beforeRejected);

    advanceToBurnHeight(cutoff);
    expect(stake(carol).type).toBe("ok");
    assertAccounting(members);

    for (const who of members.slice(1)) {
      if (value(settledMember(who), "released-sats") > 0) {
        expect(claimPrincipal(who, dave).type).toBe("ok");
      }
    }
    assertAccounting(members);

    expect(payRewards(dave, 23).type).toBe("ok");
    expect(syncRewards(alice).type).toBe("ok");
    for (const who of members) {
      expect(settleMember(who).type).toBe("ok");
      if (claimableRewards(who) > 0) expect(claimRewards(who, carol).type).toBe("ok");
    }
    assertAccounting(members);

    expect(value(settledMember(members[0]), "bonded-sats")).toBe(
      amounts[0] + addition,
    );
    for (const who of members.slice(1)) {
      expect(value(settledMember(who), "bonded-sats")).toBe(0);
      expect(member(who)["exit-epoch"]).toBeNull();
    }
  });
});
