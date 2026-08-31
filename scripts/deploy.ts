import { confirm, password } from "@inquirer/prompts";
import { createHash } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import {
  Cl,
  ClarityType,
  ClarityVersion,
  PostConditionMode,
  broadcastTransaction,
  fetchCallReadOnlyFunction,
  fetchFeeEstimate,
  fetchNonce,
  getAddressFromPrivateKey,
  makeContractCall,
  makeContractDeploy,
  type StacksTransactionWire,
  type TxBroadcastResult,
} from "@stacks/transactions";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const NETWORK = "mainnet" as const;
const DEFAULT_API_URL = "https://api.hiro.so";
const POX5_CONTRACT = "SP000000000000000000002Q6VF78.pox-5";
export const MAINNET_DEPLOYER_ADDRESS =
  "SP8HK160YD5GHXP69VGA0TC7AQJ1X4CDW3XVERSE";
const EXPECTED_SIGNER_MANAGER_SOURCE_SHA256 =
  "c0a2cc8e83de2b1bc60e07c5e0f5da8991c6f79eb05d077bba8cb984eee226b3";

export const LANES = [0, 1, 2, 3, 4, 5] as const;
export type Lane = (typeof LANES)[number];

export const DEFAULT_SIGNER_MANAGERS = [
  "SP8HK160YD5GHXP69VGA0TC7AQJ1X4CDW3XVERSE.xverse-signer-manager-1",
  "SP8HK160YD5GHXP69VGA0TC7AQJ1X4CDW3XVERSE.xverse-signer-manager-2",
  "SP8HK160YD5GHXP69VGA0TC7AQJ1X4CDW3XVERSE.xverse-signer-manager-3",
] as const;

interface PublishOperation {
  order: number;
  type: "contract-publish";
  lane: Lane;
  contractName: string;
  artifactPath: string;
  artifactSha256: string;
}

interface InitializeOperation {
  order: number;
  type: "contract-call-template";
  lane: Lane;
  contractName: string;
  function: "initialize";
  arguments: Array<{ clarityName: string; input: string }>;
}

type DeploymentOperation = PublishOperation | InitializeOperation;

interface DeploymentInput {
  schemaVersion: number;
  network: string;
  operations: DeploymentOperation[];
}

interface ArtifactManifest {
  artifacts: Array<{
    network: string;
    contractName: string;
    relativePath: string;
    artifactSha256: string;
  }>;
}

interface CliOptions {
  deployerPrivateKey?: string;
  broadcast: boolean;
  feeUstx?: bigint;
  apiUrl: string;
  operators: Record<Lane, string>;
  signerManagers: [string, string, string];
}

interface PreparedTransactionRecord {
  order: number;
  lane: Lane;
  type: "contract-publish" | "contract-call";
  contractId: string;
  function?: "initialize";
  arguments?: { manager: string; operator: string };
  nonce: string;
  feeUstx: string;
  feeSource: "override" | "network-medium" | "network-transfer-rate-fallback";
  txid: string;
  rawTransaction: string;
  broadcast: {
    status: "not-attempted" | "accepted" | "rejected" | "failed";
    response?: unknown;
  };
}

interface PreparedTransaction {
  transaction: StacksTransactionWire;
  record: PreparedTransactionRecord;
}

interface SavedDeployment {
  schemaVersion: 1;
  createdAt: string;
  unixTimestampSeconds: number;
  network: typeof NETWORK;
  apiUrl: string;
  pox5Contract: string;
  deployerAddress: string;
  baseNonce: string;
  balanceUstx: string;
  signerManagerSourceSha256: string;
  signerManagers: Array<{
    id: 1 | 2 | 3;
    principal: string;
    lanes: Lane[];
    registeredWithPox5: true;
  }>;
  operators: Array<{ lane: Lane; principal: string }>;
  fees: {
    mode: "override" | "network-estimated";
    overrideFeeUstx: string | null;
    totalFeeUstx: string;
  };
  broadcast: {
    selected: boolean | null;
    source: "flag" | "interactive" | "non-interactive" | null;
    status: "awaiting-selection" | "declined" | "broadcasting" | "complete" | "failed";
  };
  transactions: PreparedTransactionRecord[];
  allowlistNote: string;
}

const HELP = `Deploy and initialize the six Xverse PoX-5 lanes on Stacks mainnet.

Usage:
  bun run deploy -- --deployer-private-key <hex> --op-all <principal> [options]
  bun run deploy -- --op-0 <principal> ... --op-5 <principal> [options]

Options:
  --deployer-private-key <hex>  Deployer key. Must derive ${MAINNET_DEPLOYER_ADDRESS}.
                                Prompts securely when omitted.
  --op-all <principal>          Use one initial operator for all six lanes.
  --op-0 ... --op-5 <principal>
                                Set every lane's initial operator separately.
  --signer-manager-1 <contract> Override signer manager 1 (lanes 0 and 3).
  --signer-manager-2 <contract> Override signer manager 2 (lanes 1 and 4).
  --signer-manager-3 <contract> Override signer manager 3 (lanes 2 and 5).
  --fee-ustx <integer>          Use this fee for each of the 18 transactions.
                                Otherwise the network medium fee is estimated.
  --api-url <url>               Stacks API URL (default: ${DEFAULT_API_URL}).
  --broadcast                   Broadcast immediately after printing and saving.
                                Without it, an interactive confirmation is shown.
  --help                        Show this help.

The script always writes signed raw transactions under deployment-transactions/.
That directory is git-ignored, but anyone who obtains a saved transaction can
broadcast it. Supplying a private key on the command line can expose it in shell
history and process listings; omitting the option uses a masked prompt.
`;

function fail(message: string): never {
  throw new Error(message);
}

function isLane(value: unknown): value is Lane {
  return typeof value === "number" && LANES.includes(value as Lane);
}

export function parseFeeUstx(value: string | undefined): bigint | undefined {
  if (value === undefined) return undefined;
  if (!/^[0-9]+$/.test(value)) {
    fail("--fee-ustx must be a positive integer in micro-STX (uSTX).");
  }
  const fee = BigInt(value);
  if (fee <= 0n) {
    fail("--fee-ustx must be greater than zero.");
  }
  return fee;
}

function validatePrivateKey(value: string): string {
  const key = value.trim().replace(/^0x/i, "");
  if (!/^[0-9a-fA-F]{64}(01)?$/.test(key)) {
    fail(
      "Deployer private key must be 32-byte hex, optionally followed by the 01 compression suffix.",
    );
  }
  try {
    getAddressFromPrivateKey(key, NETWORK);
  } catch {
    fail("Deployer private key is not a valid secp256k1 private key.");
  }
  return key;
}

export function assertMainnetDeployerAddress(address: string): void {
  if (address !== MAINNET_DEPLOYER_ADDRESS) {
    fail(
      `Deployer key derives ${address}; expected canonical Xverse PoX-5 deployer ${MAINNET_DEPLOYER_ADDRESS}.`,
    );
  }
}

function validateMainnetPrincipal(value: string, label: string): string {
  const principal = value.trim();
  try {
    Cl.principal(principal);
  } catch {
    fail(`${label} must be a valid Stacks principal.`);
  }
  const address = principal.split(".", 1)[0] ?? "";
  if (!address.startsWith("SP") && !address.startsWith("SM")) {
    fail(`${label} must be a mainnet Stacks principal.`);
  }
  return principal;
}

function validateManagerPrincipal(value: string, label: string): string {
  const principal = validateMainnetPrincipal(value, label);
  const parts = principal.split(".");
  if (parts.length !== 2 || parts[1] === "") {
    fail(`${label} must be a contract principal.`);
  }
  return principal;
}

export function resolveOperators(values: Record<string, string | boolean | undefined>): Record<Lane, string> {
  const all = typeof values["op-all"] === "string" ? values["op-all"] : undefined;
  const laneValues = LANES.map((lane) => {
    const value = values[`op-${lane}`];
    return typeof value === "string" ? value : undefined;
  });
  const hasLaneValue = laneValues.some((value) => value !== undefined);

  if (all !== undefined && hasLaneValue) {
    fail("Use either --op-all or --op-0 through --op-5, not both.");
  }
  if (all !== undefined) {
    const operator = validateMainnetPrincipal(all, "--op-all");
    return Object.fromEntries(LANES.map((lane) => [lane, operator])) as Record<
      Lane,
      string
    >;
  }

  const missing = LANES.filter((lane) => laneValues[lane] === undefined);
  if (missing.length > 0) {
    fail(
      `Provide --op-all or every per-lane operator flag. Missing: ${missing
        .map((lane) => `--op-${lane}`)
        .join(", ")}.`,
    );
  }

  return Object.fromEntries(
    LANES.map((lane) => [
      lane,
      validateMainnetPrincipal(laneValues[lane]!, `--op-${lane}`),
    ]),
  ) as Record<Lane, string>;
}

function parseCliOptions(): CliOptions | null {
  const options: Record<string, { type: "string" | "boolean"; default?: string | boolean }> = {
    help: { type: "boolean", default: false },
    "deployer-private-key": { type: "string" },
    broadcast: { type: "boolean", default: false },
    "fee-ustx": { type: "string" },
    "api-url": { type: "string", default: DEFAULT_API_URL },
    "op-all": { type: "string" },
    "signer-manager-1": { type: "string" },
    "signer-manager-2": { type: "string" },
    "signer-manager-3": { type: "string" },
  };
  for (const lane of LANES) options[`op-${lane}`] = { type: "string" };

  const parsed = parseArgs({ options, strict: true, allowPositionals: false });
  if (parsed.values.help === true) {
    console.log(HELP);
    return null;
  }

  const apiUrlValue = parsed.values["api-url"];
  const apiUrl = typeof apiUrlValue === "string" ? apiUrlValue.replace(/\/+$/, "") : DEFAULT_API_URL;
  try {
    new URL(apiUrl);
  } catch {
    fail("--api-url must be a valid URL.");
  }

  const managers = DEFAULT_SIGNER_MANAGERS.map((defaultPrincipal, index) => {
    const value = parsed.values[`signer-manager-${index + 1}`];
    return validateManagerPrincipal(
      typeof value === "string" ? value : defaultPrincipal,
      `--signer-manager-${index + 1}`,
    );
  }) as [string, string, string];
  if (new Set(managers).size !== managers.length) {
    fail("The three signer-manager principals must be distinct.");
  }

  const privateKeyValue = parsed.values["deployer-private-key"];
  const feeValue = parsed.values["fee-ustx"];
  return {
    deployerPrivateKey:
      typeof privateKeyValue === "string" ? privateKeyValue : undefined,
    broadcast: parsed.values.broadcast === true,
    feeUstx: parseFeeUstx(typeof feeValue === "string" ? feeValue : undefined),
    apiUrl,
    operators: resolveOperators(parsed.values),
    signerManagers: managers,
  };
}

function sha256(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

function loadAndVerifyOperations(): {
  operations: DeploymentOperation[];
  sources: Map<string, string>;
} {
  const deploymentPath = join(ROOT, "generated/deployments/mainnet.json");
  const manifestPath = join(ROOT, "generated/artifact-manifest.json");
  const deployment = readJson<DeploymentInput>(deploymentPath);
  const manifest = readJson<ArtifactManifest>(manifestPath);

  if (
    deployment.schemaVersion !== 1 ||
    deployment.network !== NETWORK ||
    !Array.isArray(deployment.operations) ||
    deployment.operations.length !== 18
  ) {
    fail(`${deploymentPath} is not the expected 18-operation mainnet deployment input.`);
  }

  const sources = new Map<string, string>();
  const publishCount = deployment.operations.filter(
    (operation) => operation.type === "contract-publish",
  ).length;
  const initializeCount = deployment.operations.filter(
    (operation) => operation.type === "contract-call-template",
  ).length;
  if (publishCount !== 12 || initializeCount !== 6) {
    fail("Deployment input must contain 12 publishes and 6 initialize calls.");
  }

  for (const [index, operation] of deployment.operations.entries()) {
    if (operation.order !== index + 1 || !isLane(operation.lane)) {
      fail(`Invalid deployment operation at index ${index}.`);
    }
    if (operation.type === "contract-call-template") {
      if (operation.function !== "initialize") {
        fail(`Unexpected contract call ${operation.function} in deployment input.`);
      }
      continue;
    }

    const artifactPath = join(ROOT, operation.artifactPath);
    const source = readFileSync(artifactPath, "utf8");
    const actualHash = sha256(source);
    const manifestRecord = manifest.artifacts.find(
      (record) =>
        record.network === NETWORK &&
        record.contractName === operation.contractName &&
        record.relativePath === operation.artifactPath,
    );
    if (
      actualHash !== operation.artifactSha256 ||
      manifestRecord?.artifactSha256 !== actualHash
    ) {
      fail(
        `Generated artifact hash mismatch for ${operation.artifactPath}. Run bun run check:generated.`,
      );
    }
    sources.set(operation.contractName, source);
  }

  return { operations: deployment.operations, sources };
}

function splitContractPrincipal(principal: string): {
  address: string;
  contractName: string;
} {
  const [address, contractName, extra] = principal.split(".");
  if (!address || !contractName || extra !== undefined) {
    fail(`Invalid contract principal: ${principal}`);
  }
  return { address, contractName };
}

function createApiFetch(): typeof fetch {
  const apiKey = process.env.HIRO_API_KEY?.trim();
  return ((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    if (!apiKey) return fetch(input, init);
    const headers = new Headers(init?.headers);
    headers.set("x-api-key", apiKey);
    return fetch(input, { ...init, headers });
  }) as typeof fetch;
}

async function responseError(response: Response): Promise<string> {
  const body = await response.text().catch(() => "");
  return `${response.status} ${response.statusText}${body ? `: ${body}` : ""}`;
}

async function verifySignerManagers(
  managers: readonly string[],
  deployerAddress: string,
  apiUrl: string,
  apiFetch: typeof fetch,
): Promise<void> {
  const { address: poxAddress, contractName: poxName } = splitContractPrincipal(POX5_CONTRACT);

  await Promise.all(
    managers.map(async (manager, index) => {
      const { address, contractName } = splitContractPrincipal(manager);
      const sourceResponse = await apiFetch(
        `${apiUrl}/v2/contracts/source/${address}/${contractName}?proof=0`,
      );
      if (!sourceResponse.ok) {
        fail(
          `Signer manager ${index + 1} is not deployed or its source could not be read: ${await responseError(sourceResponse)}`,
        );
      }
      const sourceBody = (await sourceResponse.json()) as { source?: unknown };
      if (typeof sourceBody.source !== "string") {
        fail(`Signer manager ${index + 1} returned no contract source.`);
      }
      const sourceHash = sha256(sourceBody.source);
      if (sourceHash !== EXPECTED_SIGNER_MANAGER_SOURCE_SHA256) {
        fail(
          `Signer manager ${index + 1} source hash is ${sourceHash}; expected ${EXPECTED_SIGNER_MANAGER_SOURCE_SHA256}.`,
        );
      }

      const signerInfo = await fetchCallReadOnlyFunction({
        contractAddress: poxAddress,
        contractName: poxName,
        functionName: "get-signer-info",
        functionArgs: [Cl.principal(manager)],
        senderAddress: deployerAddress,
        network: NETWORK,
        client: { baseUrl: apiUrl, fetch: apiFetch },
      });
      if (signerInfo.type !== ClarityType.OptionalSome) {
        fail(`Signer manager ${index + 1} is not registered with ${POX5_CONTRACT}.`);
      }
    }),
  );
}

async function fetchBalanceUstx(
  address: string,
  apiUrl: string,
  apiFetch: typeof fetch,
): Promise<bigint> {
  const response = await apiFetch(`${apiUrl}/extended/v1/address/${address}/balances`);
  if (!response.ok) {
    fail(`Could not fetch deployer balance: ${await responseError(response)}`);
  }
  const body = (await response.json()) as { stx?: { balance?: unknown } };
  const balance = body.stx?.balance;
  if (typeof balance !== "string" || !/^[0-9]+$/.test(balance)) {
    fail("Stacks API returned an invalid deployer balance.");
  }
  return BigInt(balance);
}

function managerIdForOperation(operation: InitializeOperation): 1 | 2 | 3 {
  const managerArgument = operation.arguments.find(
    (argument) => argument.clarityName === "manager",
  );
  const match = managerArgument?.input.match(/^signerManagerPrincipal([123])$/);
  if (!match) {
    fail(`Initialize operation ${operation.order} has an invalid signer-manager input.`);
  }
  return Number(match[1]) as 1 | 2 | 3;
}

async function buildTransaction(
  operation: DeploymentOperation,
  sources: ReadonlyMap<string, string>,
  deployerAddress: string,
  privateKey: string,
  operators: Record<Lane, string>,
  signerManagers: readonly [string, string, string],
  nonce: bigint,
  fee: bigint,
  apiUrl: string,
  apiFetch: typeof fetch,
): Promise<StacksTransactionWire> {
  const common = {
    senderKey: privateKey,
    nonce,
    fee,
    network: NETWORK,
    client: { baseUrl: apiUrl, fetch: apiFetch },
    postConditionMode: PostConditionMode.Deny,
  } as const;

  if (operation.type === "contract-publish") {
    const source = sources.get(operation.contractName);
    if (source === undefined) fail(`Missing source for ${operation.contractName}.`);
    return makeContractDeploy({
      ...common,
      contractName: operation.contractName,
      codeBody: source,
      clarityVersion: ClarityVersion.Clarity6,
    });
  }

  const managerId = managerIdForOperation(operation);
  return makeContractCall({
    ...common,
    contractAddress: deployerAddress,
    contractName: operation.contractName,
    functionName: "initialize",
    functionArgs: [
      Cl.principal(signerManagers[managerId - 1]),
      Cl.principal(operators[operation.lane]),
    ],
    validateWithAbi: false,
  });
}

async function fetchTransferFeeRate(
  apiUrl: string,
  apiFetch: typeof fetch,
): Promise<bigint> {
  const response = await apiFetch(`${apiUrl}/v2/fees/transfer`, {
    headers: { Accept: "application/text" },
  });
  if (!response.ok) {
    fail(`Could not fetch fallback network fee rate: ${await responseError(response)}`);
  }
  const value = (await response.text()).trim();
  if (!/^[0-9]+$/.test(value)) {
    fail("Stacks API returned an invalid fallback fee rate.");
  }
  return BigInt(value);
}

async function prepareTransactions(args: {
  operations: DeploymentOperation[];
  sources: ReadonlyMap<string, string>;
  deployerAddress: string;
  privateKey: string;
  operators: Record<Lane, string>;
  signerManagers: [string, string, string];
  baseNonce: bigint;
  feeOverride?: bigint;
  apiUrl: string;
  apiFetch: typeof fetch;
}): Promise<PreparedTransaction[]> {
  const prepared: PreparedTransaction[] = [];
  let fallbackFeeRate: bigint | undefined;

  for (const [index, operation] of args.operations.entries()) {
    const nonce = args.baseNonce + BigInt(index);
    let fee = args.feeOverride;
    let feeSource: PreparedTransactionRecord["feeSource"] = "override";

    if (fee === undefined) {
      const estimateCandidate = await buildTransaction(
        operation,
        args.sources,
        args.deployerAddress,
        args.privateKey,
        args.operators,
        args.signerManagers,
        nonce,
        1n,
        args.apiUrl,
        args.apiFetch,
      );
      try {
        const estimate = await fetchFeeEstimate({
          transaction: estimateCandidate,
          network: NETWORK,
          client: { baseUrl: args.apiUrl, fetch: args.apiFetch },
        });
        fee =
          typeof estimate === "bigint"
            ? estimate
            : BigInt(Math.max(1, Math.ceil(estimate)));
        feeSource = "network-medium";
      } catch {
        fallbackFeeRate ??= await fetchTransferFeeRate(args.apiUrl, args.apiFetch);
        fee = fallbackFeeRate * BigInt(estimateCandidate.serializeBytes().byteLength);
        feeSource = "network-transfer-rate-fallback";
      }
    }

    const transaction = await buildTransaction(
      operation,
      args.sources,
      args.deployerAddress,
      args.privateKey,
      args.operators,
      args.signerManagers,
      nonce,
      fee,
      args.apiUrl,
      args.apiFetch,
    );
    const managerId =
      operation.type === "contract-call-template"
        ? managerIdForOperation(operation)
        : undefined;
    const contractId = `${args.deployerAddress}.${operation.contractName}`;
    prepared.push({
      transaction,
      record: {
        order: operation.order,
        lane: operation.lane,
        type:
          operation.type === "contract-publish"
            ? "contract-publish"
            : "contract-call",
        contractId,
        function:
          operation.type === "contract-call-template" ? "initialize" : undefined,
        arguments:
          managerId === undefined
            ? undefined
            : {
                manager: args.signerManagers[managerId - 1],
                operator: args.operators[operation.lane],
              },
        nonce: nonce.toString(),
        feeUstx: fee.toString(),
        feeSource,
        txid: transaction.txid(),
        rawTransaction: transaction.serialize(),
        broadcast: { status: "not-attempted" },
      },
    });
  }

  return prepared;
}

function saveDeployment(path: string, deployment: SavedDeployment): void {
  const tempPath = `${path}.tmp`;
  writeFileSync(tempPath, `${JSON.stringify(deployment, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  renameSync(tempPath, path);
  chmodSync(path, 0o600);
}

function printPlan(deployment: SavedDeployment, path: string): void {
  console.log("\nXverse PoX-5 deployment");
  console.log(`Network:           ${deployment.network}`);
  console.log(`Stacks API:        ${deployment.apiUrl}`);
  console.log(`PoX-5:             ${deployment.pox5Contract}`);
  console.log(`Deployer:          ${deployment.deployerAddress}`);
  console.log(`Starting nonce:    ${deployment.baseNonce}`);
  console.log(`Balance:           ${deployment.balanceUstx} uSTX`);
  console.log(`Total fees:        ${deployment.fees.totalFeeUstx} uSTX`);
  console.log(`Signer source:     ${deployment.signerManagerSourceSha256} (verified)`);
  console.log(
    `Fee mode:          ${deployment.fees.mode}${
      deployment.fees.overrideFeeUstx === null
        ? ""
        : ` (${deployment.fees.overrideFeeUstx} uSTX per transaction)`
    }`,
  );

  console.log("\nSigner managers:");
  for (const manager of deployment.signerManagers) {
    console.log(
      `  ${manager.id} (lanes ${manager.lanes.join(", ")}): ${manager.principal} (PoX-5 registered)`,
    );
  }
  console.log("\nOperators:");
  for (const operator of deployment.operators) {
    console.log(`  Lane ${operator.lane}: ${operator.principal}`);
  }
  console.log("\nTransactions:");
  for (const transaction of deployment.transactions) {
    const action =
      transaction.type === "contract-publish"
        ? "publish"
        : `initialize -> manager ${transaction.arguments?.manager}, operator ${transaction.arguments?.operator}`;
    console.log(
      `  ${String(transaction.order).padStart(2, "0")}. lane ${transaction.lane} | nonce ${transaction.nonce} | fee ${transaction.feeUstx} uSTX | ${action} | ${transaction.contractId}`,
    );
  }
  console.log(`\nTransactions file: ${path}`);
  console.log(
    "PoX-5 lane allowlisting is separate and is not included in these transactions.",
  );
}

function isBroadcastRejection(
  result: TxBroadcastResult,
): result is TxBroadcastResult & { error: string; reason?: string } {
  return "error" in result;
}

async function broadcastPreparedTransactions(
  prepared: PreparedTransaction[],
  deployment: SavedDeployment,
  path: string,
  apiUrl: string,
  apiFetch: typeof fetch,
): Promise<void> {
  deployment.broadcast.status = "broadcasting";
  saveDeployment(path, deployment);

  for (const [index, item] of prepared.entries()) {
    process.stdout.write(
      `Broadcasting ${index + 1}/${prepared.length}: ${item.record.contractId}${item.record.function ? `.${item.record.function}` : ""} ... `,
    );
    try {
      const result = await broadcastTransaction({
        transaction: item.transaction,
        network: NETWORK,
        client: { baseUrl: apiUrl, fetch: apiFetch },
      });
      if (isBroadcastRejection(result)) {
        item.record.broadcast = { status: "rejected", response: result };
        deployment.broadcast.status = "failed";
        saveDeployment(path, deployment);
        console.log("rejected");
        fail(
          `Transaction ${item.record.order} was rejected: ${result.reason ?? result.error}`,
        );
      }
      item.record.broadcast = { status: "accepted", response: result };
      saveDeployment(path, deployment);
      console.log(result.txid);
    } catch (error) {
      if (item.record.broadcast.status !== "rejected") {
        item.record.broadcast = {
          status: "failed",
          response: error instanceof Error ? error.message : String(error),
        };
        deployment.broadcast.status = "failed";
        saveDeployment(path, deployment);
      }
      throw error;
    }
  }

  deployment.broadcast.status = "complete";
  saveDeployment(path, deployment);
}

export async function main(): Promise<void> {
  const cli = parseCliOptions();
  if (cli === null) return;

  let privateKeyInput = cli.deployerPrivateKey;
  if (privateKeyInput === undefined) {
    if (!process.stdin.isTTY) {
      fail(
        "--deployer-private-key was omitted, but an interactive terminal is not available.",
      );
    }
    privateKeyInput = await password({
      message: "Deployer private key",
      mask: "*",
    });
  }
  const privateKey = validatePrivateKey(privateKeyInput);
  const deployerAddress = getAddressFromPrivateKey(privateKey, NETWORK);
  assertMainnetDeployerAddress(deployerAddress);
  const apiFetch = createApiFetch();

  const { operations, sources } = loadAndVerifyOperations();
  console.log("Verifying signer managers and deployment inputs...");
  await verifySignerManagers(
    cli.signerManagers,
    deployerAddress,
    cli.apiUrl,
    apiFetch,
  );

  const [baseNonce, balanceUstx] = await Promise.all([
    fetchNonce({
      address: deployerAddress,
      network: NETWORK,
      client: { baseUrl: cli.apiUrl, fetch: apiFetch },
    }),
    fetchBalanceUstx(deployerAddress, cli.apiUrl, apiFetch),
  ]);

  console.log("Building and signing 18 transactions...");
  const prepared = await prepareTransactions({
    operations,
    sources,
    deployerAddress,
    privateKey,
    operators: cli.operators,
    signerManagers: cli.signerManagers,
    baseNonce,
    feeOverride: cli.feeUstx,
    apiUrl: cli.apiUrl,
    apiFetch,
  });
  const totalFeeUstx = prepared.reduce(
    (total, item) => total + BigInt(item.record.feeUstx),
    0n,
  );
  const timestamp = Math.floor(Date.now() / 1000);
  const deploymentsDirectory = join(ROOT, "deployment-transactions");
  mkdirSync(deploymentsDirectory, { recursive: true, mode: 0o700 });
  chmodSync(deploymentsDirectory, 0o700);
  const outputDirectory = join(
    deploymentsDirectory,
    `deployment-${timestamp}`,
  );
  mkdirSync(outputDirectory, { mode: 0o700 });
  const outputPath = join(outputDirectory, "transactions.json");

  const deployment: SavedDeployment = {
    schemaVersion: 1,
    createdAt: new Date().toISOString(),
    unixTimestampSeconds: timestamp,
    network: NETWORK,
    apiUrl: cli.apiUrl,
    pox5Contract: POX5_CONTRACT,
    deployerAddress,
    baseNonce: baseNonce.toString(),
    balanceUstx: balanceUstx.toString(),
    signerManagerSourceSha256: EXPECTED_SIGNER_MANAGER_SOURCE_SHA256,
    signerManagers: [
      {
        id: 1,
        principal: cli.signerManagers[0],
        lanes: [0, 3],
        registeredWithPox5: true,
      },
      {
        id: 2,
        principal: cli.signerManagers[1],
        lanes: [1, 4],
        registeredWithPox5: true,
      },
      {
        id: 3,
        principal: cli.signerManagers[2],
        lanes: [2, 5],
        registeredWithPox5: true,
      },
    ],
    operators: LANES.map((lane) => ({
      lane,
      principal: cli.operators[lane],
    })),
    fees: {
      mode: cli.feeUstx === undefined ? "network-estimated" : "override",
      overrideFeeUstx: cli.feeUstx?.toString() ?? null,
      totalFeeUstx: totalFeeUstx.toString(),
    },
    broadcast: {
      selected: cli.broadcast ? true : null,
      source: cli.broadcast ? "flag" : null,
      status: cli.broadcast ? "broadcasting" : "awaiting-selection",
    },
    transactions: prepared.map((item) => item.record),
    allowlistNote:
      "PoX-5 setup is separate: each bond must allowlist only its matching same-lane staker principal and sats allowance.",
  };

  saveDeployment(outputPath, deployment);
  printPlan(deployment, outputPath);

  if (balanceUstx < totalFeeUstx) {
    deployment.broadcast.selected = false;
    deployment.broadcast.source = cli.broadcast ? "flag" : "interactive";
    deployment.broadcast.status = "failed";
    saveDeployment(outputPath, deployment);
    fail(
      `Deployer balance is insufficient for total fees. Transactions remain saved at ${outputPath}`,
    );
  }

  let shouldBroadcast = cli.broadcast;
  if (!cli.broadcast) {
    if (process.stdin.isTTY) {
      shouldBroadcast = await confirm({
        message: "Broadcast transactions?",
        default: false,
      });
      deployment.broadcast.source = "interactive";
    } else {
      shouldBroadcast = false;
      deployment.broadcast.source = "non-interactive";
      console.log("No interactive terminal is available; transactions will not be broadcast.");
    }
    deployment.broadcast.selected = shouldBroadcast;
    deployment.broadcast.status = shouldBroadcast ? "broadcasting" : "declined";
    saveDeployment(outputPath, deployment);
  }

  if (!shouldBroadcast) {
    console.log(`Transactions were not broadcast. Saved at: ${outputPath}`);
    return;
  }

  await broadcastPreparedTransactions(
    prepared,
    deployment,
    outputPath,
    cli.apiUrl,
    apiFetch,
  );
  console.log(`All transactions were accepted. Saved at: ${outputPath}`);
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    console.error(`Deployment failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
