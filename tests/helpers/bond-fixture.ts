import {
  Cl,
  ClarityValue,
  cvToValue,
  privateKeyToPublic,
  publicKeyToAddress,
  signMessageHashRsv,
} from "@stacks/transactions";

export const POX5 = "ST000000000000000000002AMW42H.pox-5";
export const SBTC_DEPLOYER = "SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4";
export const SBTC = `${SBTC_DEPLOYER}.sbtc-token`;
export const POOL = "sbtc-bond-staker-0";
export const TREASURY = "sbtc-bond-treasury-0";
export const MANAGER = "test-signer-manager";
export const ALT_MANAGER = "test-signer-manager-alt";
export const CALLBACK_MANAGER = "test-signer-manager-callback";
export const TEST_CALLER = "test-caller";
export const BOND_ADMIN = "ST000000000000000000002AMW42H";

export const CYCLE_LENGTH = 1050;
export const BOND_INDEX = 6;
export const NEXT_BOND_INDEX = 12;
export const STX_VALUE_RATIO = 100_000;
export const MIN_USTX_RATIO = 500;
export const ALLOWANCE_SATS = 500_000_000;
export const MAX_SATS = 400_000_000;

const SIGNER_PRIVATE_KEYS: Record<string, string> = {
  [MANAGER]:
    "010101010101010101010101010101010101010101010101010101010101010101",
  [ALT_MANAGER]:
    "020202020202020202020202020202020202020202020202020202020202020201",
  [CALLBACK_MANAGER]:
    "030303030303030303030303030303030303030303030303030303030303030301",
};

const accounts = simnet.getAccounts();
export const deployer = accounts.get("deployer")!;
export const poolPrincipal = () => `${deployer}.${POOL}`;
export const treasuryPrincipal = () => `${deployer}.${TREASURY}`;
export const managerPrincipal = (name = MANAGER) => `${deployer}.${name}`;
export const testCallerPrincipal = () => `${deployer}.${TEST_CALLER}`;

export const num = (cv: ClarityValue) => Number(cvToValue(cv, true));

const unwrap = (value: any): any => {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(unwrap);
  if ("type" in value && "value" in value) return unwrap(value.value);
  return Object.fromEntries(
    Object.entries(value).map(([key, inner]) => [key, unwrap(inner)]),
  );
};

export const plain = (cv: ClarityValue) => unwrap(cvToValue(cv, true));

export function expectOk(cv: ClarityValue, label: string) {
  if (cv.type === "err") throw new Error(`${label} failed: ${Cl.prettyPrint(cv)}`);
  return cv;
}

export const readPool = (fn: string, args: ClarityValue[] = []) =>
  simnet.callReadOnlyFn(POOL, fn, args, deployer).result;

export const readPox = (fn: string, args: ClarityValue[] = []) =>
  simnet.callReadOnlyFn(POX5, fn, args, deployer).result;

export const readPoxNum = (fn: string, args: ClarityValue[] = []) =>
  num(readPox(fn, args));

export const sbtcBalance = (who: string) =>
  num(
    (
      simnet.callReadOnlyFn(SBTC, "get-balance", [Cl.principal(who)], deployer)
        .result as any
    ).value,
  );

export const stxBalance = (who: string) =>
  Number(simnet.getAssetsMap().get("STX")?.get(who) ?? 0n);

export function advanceToBurnHeight(target: number) {
  const delta = target - simnet.burnBlockHeight;
  if (delta > 0) simnet.mineEmptyBurnBlocks(delta);
  return simnet.burnBlockHeight;
}

export const bondStartHeight = (index: number) =>
  readPoxNum("bond-period-to-burn-height", [Cl.uint(index)]);

export function registerSignerManager(name = MANAGER, authId = 1) {
  const privateKey = SIGNER_PRIVATE_KEYS[name];
  const contractId = managerPrincipal(name);
  const raw = (
    simnet.callReadOnlyFn(
      POX5,
      "get-signer-grant-message-hash",
      [Cl.principal(contractId), Cl.uint(authId)],
      deployer,
    ).result as any
  ).value;
  const messageHash =
    typeof raw === "string" ? raw : Buffer.from(raw).toString("hex");
  const signature = signMessageHashRsv({
    messageHash,
    privateKey,
  });

  return simnet.callPublicFn(
    name,
    "register-self",
    [
      Cl.principal(contractId),
      Cl.bufferFromHex(
        privateKeyToPublic(privateKey) as unknown as string,
      ),
      Cl.uint(authId),
      Cl.bufferFromHex(signature),
    ],
    deployer,
  ).result;
}

export function revokeSignerGrant(name = CALLBACK_MANAGER) {
  const signerKey = privateKeyToPublic(SIGNER_PRIVATE_KEYS[name]);
  const signer = publicKeyToAddress(signerKey, "testnet");
  return simnet.callPublicFn(
    POX5,
    "revoke-signer-grant",
    [
      Cl.principal(managerPrincipal(name)),
      Cl.bufferFromHex(signerKey as unknown as string),
    ],
    signer,
  ).result;
}

export function setupBond(
  index = BOND_INDEX,
  allowanceSats = ALLOWANCE_SATS,
  ratio = STX_VALUE_RATIO,
) {
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
      Cl.list([
        Cl.tuple({
          staker: Cl.principal(poolPrincipal()),
          "max-sats": Cl.uint(allowanceSats),
        }),
      ]),
    ],
    BOND_ADMIN,
  ).result;
  expectOk(result, `setup-bond ${index}`);
  return result;
}

export const initializePool = (sender = deployer, manager = MANAGER) =>
  simnet.callPublicFn(
    POOL,
    "initialize",
    [Cl.principal(managerPrincipal(manager)), Cl.principal(deployer)],
    sender,
  ).result;

export const bindBond = (
  index = BOND_INDEX,
  maxSats = MAX_SATS,
  sender = deployer,
  minSats = 0,
) =>
  simnet.callPublicFn(
    POOL,
    "bind-bond",
    [Cl.uint(index), Cl.uint(maxSats), Cl.uint(minSats)],
    sender,
  ).result;

export function bootstrap(maxSats = MAX_SATS, manager = MANAGER) {
  expectOk(registerSignerManager(manager), "register signer");
  expectOk(initializePool(deployer, manager), "initialize");
  setupBond();
  expectOk(bindBond(BOND_INDEX, maxSats), "bind first bond");
  return {
    bondStart: bondStartHeight(BOND_INDEX),
    unlockHeight: Number(boundBond()["unlock-burn-height"]),
  };
}

export const deposit = (who: string, sats: number) =>
  simnet.callPublicFn(POOL, "deposit", [Cl.uint(sats)], who).result;

export const withdraw = (who: string) =>
  simnet.callPublicFn(POOL, "withdraw", [], who).result;

export const commitRollover = (who: string, additionalSats = 0) =>
  simnet.callPublicFn(
    POOL,
    "commit-rollover",
    [Cl.uint(additionalSats)],
    who,
  ).result;

export const cancelRollover = (who: string) =>
  simnet.callPublicFn(POOL, "cancel-rollover-commitment", [], who).result;

export const requestExit = (who: string) =>
  simnet.callPublicFn(POOL, "request-exit", [], who).result;

export const cancelExit = (who: string) =>
  simnet.callPublicFn(POOL, "cancel-exit", [], who).result;

export const stake = (who = deployer, manager = MANAGER) =>
  simnet.callPublicFn(
    POOL,
    "stake",
    [Cl.principal(managerPrincipal(manager))],
    who,
  ).result;

export const unstakeSbtc = (who = deployer, manager = MANAGER) =>
  simnet.callPublicFn(
    POOL,
    "unstake-sbtc",
    [Cl.principal(managerPrincipal(manager))],
    who,
  ).result;

export const setValidationMode = (mode: number, manager = CALLBACK_MANAGER) =>
  simnet.callPublicFn(
    manager,
    "set-validation-mode",
    [Cl.uint(mode)],
    deployer,
  ).result;

export const setCallbackTarget = (
  target: string,
  manager = CALLBACK_MANAGER,
) =>
  simnet.callPublicFn(
    manager,
    "set-callback-target",
    [Cl.principal(target)],
    deployer,
  ).result;

export const validationState = (manager = CALLBACK_MANAGER) =>
  plain(
    simnet.callReadOnlyFn(manager, "get-validation-state", [], deployer).result,
  ) as any;

export const updateOperator = (
  who: string,
  enabled: boolean,
  sender = deployer,
) =>
  simnet.callPublicFn(
    POOL,
    "update-operator",
    [Cl.principal(who), Cl.bool(enabled)],
    sender,
  ).result;

export const updateBondRegistration = (
  next = ALT_MANAGER,
  previous = MANAGER,
  sender = deployer,
) =>
  simnet.callPublicFn(
    POOL,
    "update-bond-registration",
    [Cl.principal(managerPrincipal(next)), Cl.principal(managerPrincipal(previous))],
    sender,
  ).result;

export const signerHash = (manager: string) =>
  plain(
    readPool("get-signer-manager-hash", [
      Cl.principal(managerPrincipal(manager)),
    ]),
  ) as string;

export const trustSignerManager = (manager: string, sender = deployer) =>
  simnet.callPublicFn(
    POOL,
    "trust-signer-manager",
    [Cl.bufferFromHex(signerHash(manager).replace(/^0x/, ""))],
    sender,
  ).result;

export const distrustSignerManager = (manager: string, sender = deployer) =>
  simnet.callPublicFn(
    POOL,
    "distrust-signer-manager",
    [Cl.bufferFromHex(signerHash(manager).replace(/^0x/, ""))],
    sender,
  ).result;

export const sweepUnattributedPrincipal = (
  recipient: string,
  sender = deployer,
) =>
  simnet.callPublicFn(
    POOL,
    "sweep-unattributed-principal",
    [Cl.principal(recipient)],
    sender,
  ).result;

export const settleMember = (who: string, sender = deployer) =>
  simnet.callPublicFn(POOL, "settle-member", [Cl.principal(who)], sender).result;

export const claimPrincipal = (member: string, sender = deployer) =>
  simnet.callPublicFn(POOL, "claim-principal", [Cl.principal(member)], sender)
    .result;

export const syncRewards = (sender = deployer) =>
  simnet.callPublicFn(POOL, "sync-rewards", [], sender).result;

export const claimRewards = (member: string, sender = deployer) =>
  simnet.callPublicFn(POOL, "claim-rewards", [Cl.principal(member)], sender)
    .result;

export const transferSbtc = (from: string, to: string, amount: number) =>
  simnet.callPublicFn(
    SBTC,
    "transfer",
    [
      Cl.uint(amount),
      Cl.principal(from),
      Cl.principal(to),
      Cl.none(),
    ],
    from,
  ).result;

export const payRewards = (from: string, amount: number) =>
  transferSbtc(from, poolPrincipal(), amount);

export const requiredUstx = (sats: number) =>
  num(readPool("get-required-ustx", [Cl.uint(sats)]));

export const poxInfo = () => plain(readPox("get-pox-info")) as any;
export const poolConfig = () => plain(readPool("get-config")) as any;
export const boundBond = () => plain(readPool("get-bound-bond")) as any;
export const rolloverPreview = (who: string, additionalSats = 0) =>
  plain(
    readPool("get-member-rollover-preview", [
      Cl.principal(who),
      Cl.uint(additionalSats),
    ]),
  ) as any;
export const stakePreview = () => plain(readPool("get-stake-preview")) as any;
export const poolTotals = () => plain(readPool("get-pool")) as any;
export const epoch = (index: number) =>
  plain(readPool("get-epoch", [Cl.uint(index)])) as any;
export const member = (who: string) =>
  plain(readPool("get-member", [Cl.principal(who)])) as any;
export const settledMember = (who: string) =>
  plain(readPool("get-settled-member", [Cl.principal(who)])) as any;
export const claimableRewards = (who: string) =>
  num(readPool("get-claimable-rewards", [Cl.principal(who)]));
export const claimablePrincipal = (who: string) =>
  plain(readPool("get-claimable-principal", [Cl.principal(who)])) as any;
export const rewardEpoch = () => plain(readPool("get-reward-epoch"));
export const unattributedPrincipal = () =>
  num(readPool("get-unattributed-principal"));
export const unrecognizedRewards = () =>
  num(readPool("get-unrecognized-rewards"));
export const treasuryBalance = () => sbtcBalance(treasuryPrincipal());

export function stakeFirstBond(
  deposits: ReadonlyArray<readonly [string, number]>,
  manager = MANAGER,
) {
  const { bondStart, unlockHeight } = bootstrap(MAX_SATS, manager);
  for (const [who, sats] of deposits) expectOk(deposit(who, sats), "deposit");
  advanceToBurnHeight(bondStart - 288);
  expectOk(stake(deployer, manager), "stake first bond");
  return { bondStart, unlockHeight };
}

export function bindNextBond(
  ratio = STX_VALUE_RATIO,
  maxSats = MAX_SATS,
  index = NEXT_BOND_INDEX,
) {
  setupBond(index, ALLOWANCE_SATS, ratio);
  expectOk(bindBond(index, maxSats), "bind next bond");
  return {
    index,
    start: bondStartHeight(index),
    cutoff: Number(boundBond()["rollover-cutoff"]),
  };
}
