import { Cl, ClarityValue } from "@stacks/transactions";
import {
  ALLOWANCE_SATS,
  BOND_ADMIN,
  CYCLE_LENGTH,
  MANAGER,
  MAX_SATS,
  MIN_USTX_RATIO,
  POX5,
  SBTC,
  STX_VALUE_RATIO,
  advanceToBurnHeight,
  bondStartHeight,
  deployer,
  expectOk,
  managerPrincipal,
  num,
  plain,
  registerSignerManager,
  sbtcBalance,
} from "./bond-fixture";

export const LANE_IDS = [0, 1, 2, 3, 4, 5] as const;
export type LaneId = (typeof LANE_IDS)[number];

export const laneStaker = (lane: number) => `sbtc-bond-staker-${lane}`;
export const laneTreasury = (lane: number) => `sbtc-bond-treasury-${lane}`;
export const laneStakerPrincipal = (lane: number) =>
  `${deployer}.${laneStaker(lane)}`;
export const laneTreasuryPrincipal = (lane: number) =>
  `${deployer}.${laneTreasury(lane)}`;

export const callLane = (
  lane: number,
  fn: string,
  args: ClarityValue[] = [],
  sender = deployer,
) => simnet.callPublicFn(laneStaker(lane), fn, args, sender).result;

export const readLane = (
  lane: number,
  fn: string,
  args: ClarityValue[] = [],
  sender = deployer,
) => simnet.callReadOnlyFn(laneStaker(lane), fn, args, sender).result;

export const readLanePlain = (
  lane: number,
  fn: string,
  args: ClarityValue[] = [],
) => plain(readLane(lane, fn, args)) as any;

export const lanePool = (lane: number) => readLanePlain(lane, "get-pool");
export const laneConfig = (lane: number) => readLanePlain(lane, "get-config");
export const laneBoundBond = (lane: number) =>
  readLanePlain(lane, "get-bound-bond");
export const laneEpoch = (lane: number, epoch: number) =>
  readLanePlain(lane, "get-epoch", [Cl.uint(epoch)]);
export const laneMember = (lane: number, member: string) =>
  readLanePlain(lane, "get-member", [Cl.principal(member)]);
export const laneSettledMember = (lane: number, member: string) =>
  readLanePlain(lane, "get-settled-member", [Cl.principal(member)]);
export const laneClaimableRewards = (lane: number, member: string) =>
  num(readLane(lane, "get-claimable-rewards", [Cl.principal(member)]));
export const laneUnrecognizedRewards = (lane: number) =>
  num(readLane(lane, "get-unrecognized-rewards"));
export const laneUnattributedPrincipal = (lane: number) =>
  num(readLane(lane, "get-unattributed-principal"));
export const laneRequiredUstx = (lane: number, sats: number) =>
  num(readLane(lane, "get-required-ustx", [Cl.uint(sats)]));
export const laneTreasuryBalance = (lane: number) =>
  sbtcBalance(laneTreasuryPrincipal(lane));
export const laneRewardBalance = (lane: number) =>
  sbtcBalance(laneStakerPrincipal(lane));

export const laneMembership = (lane: number) =>
  plain(
    simnet.callReadOnlyFn(
      POX5,
      "get-bond-membership",
      [Cl.principal(laneStakerPrincipal(lane))],
      deployer,
    ).result,
  ) as any;

export function initializeLane(lane: number, manager = MANAGER) {
  return callLane(
    lane,
    "initialize",
    [Cl.principal(managerPrincipal(manager)), Cl.principal(deployer)],
    deployer,
  );
}

export function initializeLanes(
  lanes: readonly number[] = LANE_IDS,
  manager = MANAGER,
) {
  expectOk(registerSignerManager(manager), `register ${manager}`);
  for (const lane of lanes) {
    expectOk(initializeLane(lane, manager), `initialize lane ${lane}`);
  }
}

export function setupLaneBond(
  lane: number,
  index: number,
  options: {
    allowanceSats?: number;
    ratio?: number;
    allowedLanes?: readonly number[];
  } = {},
) {
  const allowanceSats = options.allowanceSats ?? ALLOWANCE_SATS;
  const ratio = options.ratio ?? STX_VALUE_RATIO;
  const allowedLanes = options.allowedLanes ?? [lane];
  advanceToBurnHeight(bondStartHeight(index) - 2 * CYCLE_LENGTH);
  const result = simnet.callPublicFn(
    POX5,
    "setup-bond",
    [
      Cl.uint(index),
      Cl.uint(1000),
      Cl.uint(ratio),
      Cl.uint(MIN_USTX_RATIO),
      Cl.bufferFromHex("00"),
      Cl.list(
        allowedLanes.map((allowedLane) =>
          Cl.tuple({
            staker: Cl.principal(laneStakerPrincipal(allowedLane)),
            "max-sats": Cl.uint(allowanceSats),
          }),
        ),
      ),
    ],
    BOND_ADMIN,
  ).result;
  expectOk(result, `setup bond ${index}`);
  return result;
}

export function bindLane(
  lane: number,
  index: number,
  maxSats = MAX_SATS,
  minSats = 0,
  sender = deployer,
) {
  return callLane(
    lane,
    "bind-bond",
    [Cl.uint(index), Cl.uint(maxSats), Cl.uint(minSats)],
    sender,
  );
}

export const depositLane = (lane: number, who: string, sats: number) =>
  callLane(lane, "deposit", [Cl.uint(sats)], who);
export const withdrawLane = (lane: number, who: string) =>
  callLane(lane, "withdraw", [], who);
export const commitLane = (
  lane: number,
  who: string,
  additionalSats = 0,
) => callLane(lane, "commit-rollover", [Cl.uint(additionalSats)], who);
export const cancelCommitmentLane = (lane: number, who: string) =>
  callLane(lane, "cancel-rollover-commitment", [], who);
export const requestExitLane = (lane: number, who: string) =>
  callLane(lane, "request-exit", [], who);
export const cancelExitLane = (lane: number, who: string) =>
  callLane(lane, "cancel-exit", [], who);
export const settleLaneMember = (
  lane: number,
  member: string,
  sender = deployer,
) => callLane(lane, "settle-member", [Cl.principal(member)], sender);
export const claimLanePrincipal = (
  lane: number,
  member: string,
  sender = deployer,
) => callLane(lane, "claim-principal", [Cl.principal(member)], sender);
export const claimLaneRewards = (
  lane: number,
  member: string,
  sender = deployer,
) => callLane(lane, "claim-rewards", [Cl.principal(member)], sender);
export const syncLaneRewards = (lane: number, sender = deployer) =>
  callLane(lane, "sync-rewards", [], sender);
export const stakeLane = (
  lane: number,
  sender = deployer,
  manager = MANAGER,
) =>
  callLane(
    lane,
    "stake",
    [Cl.principal(managerPrincipal(manager))],
    sender,
  );
export const unstakeLane = (
  lane: number,
  sender = deployer,
  manager = MANAGER,
) =>
  callLane(
    lane,
    "unstake-sbtc",
    [Cl.principal(managerPrincipal(manager))],
    sender,
  );

export function payLaneReward(lane: number, from: string, amount: number) {
  return simnet.callPublicFn(
    SBTC,
    "transfer",
    [
      Cl.uint(amount),
      Cl.principal(from),
      Cl.principal(laneStakerPrincipal(lane)),
      Cl.none(),
    ],
    from,
  ).result;
}

export function stakeInitialLane(
  lane: number,
  index: number,
  deposits: ReadonlyArray<readonly [string, number]>,
  options: { allowanceSats?: number; ratio?: number; manager?: string } = {},
) {
  setupLaneBond(lane, index, options);
  expectOk(
    bindLane(lane, index, options.allowanceSats ?? MAX_SATS),
    `bind lane ${lane} to ${index}`,
  );
  for (const [member, sats] of deposits) {
    expectOk(depositLane(lane, member, sats), `deposit lane ${lane}`);
  }
  const start = bondStartHeight(index);
  advanceToBurnHeight(start - 288);
  expectOk(
    stakeLane(lane, deployer, options.manager ?? MANAGER),
    `stake lane ${lane}`,
  );
  return {
    start,
    unlockHeight: Number(laneEpoch(lane, 0)["unlock-burn-height"]),
  };
}
