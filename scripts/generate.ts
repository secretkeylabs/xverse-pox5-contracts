import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const CANONICAL_REVISION =
  "9e146caad9953dfa28628930b04c0ea7c5911a62";
export const LANES = [0, 1, 2, 3, 4, 5] as const;
export const SIGNER_MANAGER_INPUTS = [
  "signerManagerPrincipal1",
  "signerManagerPrincipal2",
  "signerManagerPrincipal3",
] as const;
export const NETWORK_NAMES = ["simnet", "testnet", "mainnet"] as const;

export type NetworkName = (typeof NETWORK_NAMES)[number];
export type ContractKind = "treasury" | "staker";

export interface NetworkConfig {
  sbtcPrincipal: string;
  pox5Principal: string;
}

export const NETWORKS: Record<NetworkName, NetworkConfig> = {
  simnet: {
    sbtcPrincipal: "SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4",
    pox5Principal: "ST000000000000000000002AMW42H",
  },
  testnet: {
    sbtcPrincipal: "SN3VMHXEN64ZZF71JQ5VESXDWTR301XTTXGF4J8F1",
    pox5Principal: "ST000000000000000000002AMW42H",
  },
  mainnet: {
    sbtcPrincipal: "SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4",
    pox5Principal: "SP000000000000000000002Q6VF78",
  },
};

export interface ArtifactRecord {
  network: NetworkName;
  lane: number;
  kind: ContractKind;
  contractName: string;
  siblingName: string;
  relativePath: string;
  canonicalSourcePath: string;
  canonicalSourceSha256: string;
  artifactSha256: string;
}

export interface RenderInput {
  stakerSource: string;
  treasurySource: string;
  lanes?: readonly number[];
  networks?: readonly string[];
}

export interface RenderedSuite {
  files: Map<string, string>;
  artifacts: ArtifactRecord[];
  manifest: Record<string, unknown>;
}

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const STAKER_SOURCE_PATH = "contracts/sbtc-bond-staker.clar";
const TREASURY_SOURCE_PATH = "contracts/sbtc-bond-treasury.clar";
const GENERATED_CONTRACTS_DIR = "contracts/generated";
const GENERATED_METADATA_DIR = "generated";
const CLARINET_PATH = "Clarinet.toml";
const SIMNET_PLAN_PATH = "deployments/default.simnet-plan.yaml";
const BLOCK_START = "# BEGIN GENERATED LANES";
const BLOCK_END = "# END GENERATED LANES";
const SOURCE_NETWORK = NETWORKS.simnet;

const UNRESOLVED_PATTERNS = [
  /\{\{[^}\n]+\}\}/,
  /__[A-Z][A-Z0-9_]*__/,
  /@@[A-Z][A-Z0-9_]*@@/,
];

export const sha256 = (content: string) =>
  createHash("sha256").update(content).digest("hex");

const countToken = (content: string, token: string) =>
  content.split(token).length - 1;

const ensureTrailingNewline = (content: string) =>
  content.endsWith("\n") ? content : `${content}\n`;

export function validateLaneSet(lanes: readonly number[]) {
  if (lanes.length === 0) throw new Error("at least one lane is required");
  const seen = new Set<number>();
  for (const lane of lanes) {
    if (!Number.isInteger(lane) || lane < 0 || lane > 5) {
      throw new Error(`invalid lane ID ${String(lane)}; expected an integer in 0..5`);
    }
    if (seen.has(lane)) throw new Error(`duplicate lane ID ${lane}`);
    seen.add(lane);
  }
}

export function validateNetworkSet(networks: readonly string[]) {
  if (networks.length === 0) throw new Error("at least one network is required");
  const seen = new Set<string>();
  for (const network of networks) {
    if (!(NETWORK_NAMES as readonly string[]).includes(network)) {
      throw new Error(
        `invalid network ${network}; expected ${NETWORK_NAMES.join(", ")}`,
      );
    }
    if (seen.has(network)) throw new Error(`duplicate network ${network}`);
    seen.add(network);
  }
}

function assertCanonicalSources(staker: string, treasury: string) {
  const requiredStakerTokens = [
    "(define-constant LANE_ID u0)",
    ".sbtc-bond-treasury-0",
    SOURCE_NETWORK.sbtcPrincipal,
    SOURCE_NETWORK.pox5Principal,
  ];
  const requiredTreasuryTokens = [
    "(define-constant CONTROLLER .sbtc-bond-staker-0)",
    SOURCE_NETWORK.sbtcPrincipal,
  ];

  for (const token of requiredStakerTokens) {
    if (!staker.includes(token)) {
      throw new Error(`canonical staker is missing generation token: ${token}`);
    }
  }
  for (const token of requiredTreasuryTokens) {
    if (!treasury.includes(token)) {
      throw new Error(`canonical treasury is missing generation token: ${token}`);
    }
  }
  if (countToken(staker, "(define-constant LANE_ID u0)") !== 1) {
    throw new Error("canonical staker must declare lane 0 exactly once");
  }
  assertNoUnresolvedPlaceholders(staker, "canonical staker");
  assertNoUnresolvedPlaceholders(treasury, "canonical treasury");
}

function assertNoUnresolvedPlaceholders(content: string, label: string) {
  for (const pattern of UNRESOLVED_PATTERNS) {
    if (pattern.test(content)) {
      throw new Error(`${label} contains an unresolved placeholder matching ${pattern}`);
    }
  }
}

function artifactName(kind: ContractKind, lane: number) {
  return `sbtc-bond-${kind}-${lane}`;
}

function generatedHeader(
  network: NetworkName,
  lane: number,
  sourcePath: string,
  sourceHash: string,
) {
  return [
    ";; @generated by scripts/generate.ts; DO NOT EDIT.",
    `;; canonical-revision: ${CANONICAL_REVISION}`,
    `;; canonical-source: ${sourcePath}`,
    `;; canonical-source-sha256: ${sourceHash}`,
    `;; target-network: ${network}; lane: ${lane}`,
    ";; Regenerate with `bun run generate` and verify with `bun run check:generated`.",
    "",
  ].join("\n");
}

function renderContract(
  kind: ContractKind,
  canonical: string,
  network: NetworkName,
  lane: number,
  sourcePath: string,
  sourceHash: string,
) {
  const target = NETWORKS[network];
  let output = canonical;

  output = output.replaceAll(
    SOURCE_NETWORK.sbtcPrincipal,
    target.sbtcPrincipal,
  );
  output = output.replaceAll(
    SOURCE_NETWORK.pox5Principal,
    target.pox5Principal,
  );

  if (kind === "staker") {
    output = output.replace(
      "(define-constant LANE_ID u0)",
      `(define-constant LANE_ID u${lane})`,
    );
    output = output.replaceAll(
      ".sbtc-bond-treasury-0",
      `.sbtc-bond-treasury-${lane}`,
    );
  } else {
    output = output.replaceAll(
      ".sbtc-bond-staker-0",
      `.sbtc-bond-staker-${lane}`,
    );
  }

  return ensureTrailingNewline(
    `${generatedHeader(network, lane, sourcePath, sourceHash)}${output}`,
  );
}

export function validateGeneratedArtifact(
  record: Omit<ArtifactRecord, "artifactSha256">,
  content: string,
) {
  const expected = NETWORKS[record.network];
  assertNoUnresolvedPlaceholders(content, record.relativePath);

  if (!content.includes(expected.sbtcPrincipal)) {
    throw new Error(`${record.relativePath} is missing its ${record.network} sBTC principal`);
  }
  for (const principal of new Set(
    NETWORK_NAMES.map((name) => NETWORKS[name].sbtcPrincipal),
  )) {
    if (principal !== expected.sbtcPrincipal && content.includes(principal)) {
      throw new Error(`${record.relativePath} contains a wrong-network sBTC principal`);
    }
  }

  if (record.kind === "staker") {
    if (!content.includes(expected.pox5Principal)) {
      throw new Error(`${record.relativePath} is missing its ${record.network} PoX-5 principal`);
    }
    for (const principal of new Set(
      NETWORK_NAMES.map((name) => NETWORKS[name].pox5Principal),
    )) {
      if (principal !== expected.pox5Principal && content.includes(principal)) {
        throw new Error(`${record.relativePath} contains a wrong-network PoX-5 principal`);
      }
    }

    const laneMatches = [...content.matchAll(/\(define-constant LANE_ID u(\d+)\)/g)];
    if (laneMatches.length !== 1 || Number(laneMatches[0]?.[1]) !== record.lane) {
      throw new Error(`${record.relativePath} does not declare lane ${record.lane} exactly once`);
    }
    const treasuryReferences = [
      ...content.matchAll(/\.sbtc-bond-treasury-(\d+)/g),
    ];
    if (treasuryReferences.length === 0) {
      throw new Error(`${record.relativePath} has no treasury reference`);
    }
    if (treasuryReferences.some((match) => Number(match[1]) !== record.lane)) {
      throw new Error(`${record.relativePath} contains a cross-lane treasury reference`);
    }
  } else {
    const controllerReferences = [
      ...content.matchAll(/\.sbtc-bond-staker-(\d+)/g),
    ];
    if (controllerReferences.length === 0) {
      throw new Error(`${record.relativePath} has no staker controller reference`);
    }
    if (controllerReferences.some((match) => Number(match[1]) !== record.lane)) {
      throw new Error(`${record.relativePath} contains a cross-lane staker controller`);
    }
    if (!content.includes(
      `(define-constant CONTROLLER .sbtc-bond-staker-${record.lane})`,
    )) {
      throw new Error(`${record.relativePath} does not authorize its same-lane staker`);
    }
  }
}

export function validateArtifactRecords(
  records: readonly Pick<ArtifactRecord, "network" | "lane" | "kind" | "contractName">[],
  expectedLanes: readonly number[],
  expectedNetworks: readonly string[],
) {
  const names = new Set<string>();
  for (const record of records) {
    const key = `${record.network}:${record.contractName}`;
    if (names.has(key)) throw new Error(`duplicate generated contract name ${key}`);
    names.add(key);
    if (record.contractName !== artifactName(record.kind, record.lane)) {
      throw new Error(`invalid generated contract name ${record.contractName}`);
    }
    if (record.kind !== "staker" && record.kind !== "treasury") {
      throw new Error(`unsupported generated contract kind ${String(record.kind)}`);
    }
  }

  for (const network of expectedNetworks) {
    for (const lane of expectedLanes) {
      for (const kind of ["treasury", "staker"] as const) {
        const count = records.filter(
          (record) =>
            record.network === network &&
            record.lane === lane &&
            record.kind === kind,
        ).length;
        if (count !== 1) {
          throw new Error(
            `${network} lane ${lane} must contain exactly one ${kind}; found ${count}`,
          );
        }
      }
    }
  }
}

export function signerManagerInputForLane(lane: number) {
  if (!Number.isInteger(lane) || lane < 0 || lane >= LANES.length) {
    throw new Error(`invalid lane ID ${String(lane)}; expected an integer in 0..5`);
  }
  return SIGNER_MANAGER_INPUTS[lane % SIGNER_MANAGER_INPUTS.length]!;
}

function renderDeploymentInput(
  network: NetworkName,
  records: readonly ArtifactRecord[],
) {
  const networkRecords = records.filter((record) => record.network === network);
  const operations: Record<string, unknown>[] = [];
  let order = 1;

  for (const lane of LANES) {
    const treasury = networkRecords.find(
      (record) => record.lane === lane && record.kind === "treasury",
    );
    const staker = networkRecords.find(
      (record) => record.lane === lane && record.kind === "staker",
    );
    if (!treasury || !staker) {
      throw new Error(`${network} deployment input is missing lane ${lane}`);
    }

    operations.push({
      order: order++,
      type: "contract-publish",
      lane,
      contractName: treasury.contractName,
      artifactPath: treasury.relativePath,
      artifactSha256: treasury.artifactSha256,
      publisherInput: "xverseDeployerPrincipal",
      dependsOn: [],
    });
    operations.push({
      order: order++,
      type: "contract-publish",
      lane,
      contractName: staker.contractName,
      artifactPath: staker.relativePath,
      artifactSha256: staker.artifactSha256,
      publisherInput: "xverseDeployerPrincipal",
      dependsOn: [treasury.contractName],
    });
    operations.push({
      order: order++,
      type: "contract-call-template",
      lane,
      contractName: staker.contractName,
      function: "initialize",
      senderInput: "xverseDeployerPrincipal",
      arguments: [
        { clarityName: "manager", input: signerManagerInputForLane(lane) },
        { clarityName: "pool-operator", input: "poolOperatorPrincipal" },
      ],
      dependsOn: [staker.contractName],
    });
  }

  return `${JSON.stringify(
    {
      schemaVersion: 1,
      network,
      broadcast: false,
      description:
        "Non-broadcast deployment input. Resolve declared inputs in controlled deployment tooling.",
      requiredInputs: {
        xverseDeployerPrincipal: "Stacks standard principal that publishes all 12 contracts",
        signerManagerPrincipal1:
          "distinct deployed and PoX-5-registered signer-manager contract principal for lanes 0 and 3",
        signerManagerPrincipal2:
          "distinct deployed and PoX-5-registered signer-manager contract principal for lanes 1 and 4",
        signerManagerPrincipal3:
          "distinct deployed and PoX-5-registered signer-manager contract principal for lanes 2 and 5",
        poolOperatorPrincipal: "initial keyed operator principal",
      },
      stakerPrincipalForms: LANES.map(
        (lane) => `<Xverse>.sbtc-bond-staker-${lane}`,
      ),
      operations,
      allowlistNote:
        "PoX-5 setup is separate: each bond must allowlist only its matching same-lane staker principal and sats allowance.",
    },
    null,
    2,
  )}\n`;
}

export function renderSuite(input: RenderInput): RenderedSuite {
  const lanes = [...(input.lanes ?? LANES)];
  const requestedNetworks = [...(input.networks ?? NETWORK_NAMES)];
  validateLaneSet(lanes);
  validateNetworkSet(requestedNetworks);
  if (
    lanes.length !== LANES.length ||
    [...lanes].sort((a, b) => a - b).some((lane, index) => lane !== LANES[index])
  ) {
    throw new Error("generation requires the complete lane set 0..5");
  }
  if (
    requestedNetworks.length !== NETWORK_NAMES.length ||
    NETWORK_NAMES.some((network) => !requestedNetworks.includes(network))
  ) {
    throw new Error(
      `generation requires every supported network: ${NETWORK_NAMES.join(", ")}`,
    );
  }
  assertCanonicalSources(input.stakerSource, input.treasurySource);

  const networks = requestedNetworks as NetworkName[];
  const sourceHashes = {
    staker: sha256(input.stakerSource),
    treasury: sha256(input.treasurySource),
  };
  const files = new Map<string, string>();
  const artifacts: ArtifactRecord[] = [];

  for (const network of networks) {
    for (const lane of lanes) {
      for (const kind of ["treasury", "staker"] as const) {
        const canonicalSourcePath =
          kind === "staker" ? STAKER_SOURCE_PATH : TREASURY_SOURCE_PATH;
        const canonical =
          kind === "staker" ? input.stakerSource : input.treasurySource;
        const canonicalSourceSha256 = sourceHashes[kind];
        const contractName = artifactName(kind, lane);
        const siblingName = artifactName(
          kind === "staker" ? "treasury" : "staker",
          lane,
        );
        const relativePath = `${GENERATED_CONTRACTS_DIR}/${network}/${contractName}.clar`;
        const content = renderContract(
          kind,
          canonical,
          network,
          lane,
          canonicalSourcePath,
          canonicalSourceSha256,
        );
        const partialRecord = {
          network,
          lane,
          kind,
          contractName,
          siblingName,
          relativePath,
          canonicalSourcePath,
          canonicalSourceSha256,
        };
        validateGeneratedArtifact(partialRecord, content);
        const record: ArtifactRecord = {
          ...partialRecord,
          artifactSha256: sha256(content),
        };
        artifacts.push(record);
        files.set(relativePath, content);
      }
    }
  }

  validateArtifactRecords(artifacts, lanes, networks);
  const manifest = {
    schemaVersion: 1,
    generator: "scripts/generate.ts",
    command: "bun run generate",
    reviewedCanonicalRevision: CANONICAL_REVISION,
    canonicalSources: {
      staker: {
        path: STAKER_SOURCE_PATH,
        sha256: sourceHashes.staker,
      },
      treasury: {
        path: TREASURY_SOURCE_PATH,
        sha256: sourceHashes.treasury,
      },
    },
    networks: Object.fromEntries(
      networks.map((network) => [network, NETWORKS[network]]),
    ),
    artifacts,
  };
  files.set(
    `${GENERATED_METADATA_DIR}/artifact-manifest.json`,
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  for (const network of networks) {
    files.set(
      `${GENERATED_METADATA_DIR}/deployments/${network}.json`,
      renderDeploymentInput(network, artifacts),
    );
  }

  return { files, artifacts, manifest };
}

export function generatedClarinetBlock(artifacts: readonly ArtifactRecord[]) {
  const lines = [
    BLOCK_START,
    "# Generated from the reviewed canonical sources by `bun run generate`.",
    "# Do not edit lane entries directly; `bun run check:generated` rejects drift.",
  ];
  for (const lane of LANES) {
    for (const kind of ["treasury", "staker"] as const) {
      const artifact = artifacts.find(
        (record) =>
          record.network === "simnet" &&
          record.lane === lane &&
          record.kind === kind,
      );
      if (!artifact) throw new Error(`missing simnet ${kind} for lane ${lane}`);
      lines.push(
        "",
        `[contracts.${artifact.contractName}]`,
        `path = "${artifact.relativePath}"`,
        "clarity_version = 6",
        'epoch = "4.0"',
      );
    }
  }
  lines.push(BLOCK_END);
  return lines.join("\n");
}

export function applyClarinetBlock(
  clarinet: string,
  artifacts: readonly ArtifactRecord[],
) {
  const start = clarinet.indexOf(BLOCK_START);
  const end = clarinet.indexOf(BLOCK_END);
  if (start < 0 || end < 0 || end < start) {
    throw new Error(
      `Clarinet.toml must contain one ${BLOCK_START}/${BLOCK_END} marker pair`,
    );
  }
  if (
    clarinet.indexOf(BLOCK_START, start + BLOCK_START.length) >= 0 ||
    clarinet.indexOf(BLOCK_END, end + BLOCK_END.length) >= 0
  ) {
    throw new Error("Clarinet.toml contains duplicate generated-lane markers");
  }
  const afterEnd = end + BLOCK_END.length;
  return `${clarinet.slice(0, start)}${generatedClarinetBlock(artifacts)}${clarinet.slice(afterEnd)}`;
}

function listFilesRecursively(root: string, relativeDir: string): string[] {
  const absolute = join(root, relativeDir);
  if (!existsSync(absolute)) return [];
  return readdirSync(absolute).flatMap((name) => {
    const child = join(absolute, name);
    const childRelative = join(relativeDir, name).replaceAll("\\", "/");
    return statSync(child).isDirectory()
      ? listFilesRecursively(root, childRelative)
      : [childRelative];
  });
}

export function collectFileDrift(
  expected: ReadonlyMap<string, string>,
  actual: ReadonlyMap<string, string>,
) {
  const errors: string[] = [];
  for (const [path, content] of expected) {
    if (!actual.has(path)) errors.push(`missing generated file: ${path}`);
    else if (actual.get(path) !== content) errors.push(`generated file drift: ${path}`);
  }
  for (const path of actual.keys()) {
    if (!expected.has(path)) errors.push(`unexpected generated file: ${path}`);
  }
  return errors;
}

function readCanonicalSources(root: string) {
  return {
    stakerSource: readFileSync(join(root, STAKER_SOURCE_PATH), "utf8"),
    treasurySource: readFileSync(join(root, TREASURY_SOURCE_PATH), "utf8"),
  };
}

function expectedSuite(root: string) {
  return renderSuite(readCanonicalSources(root));
}

function validateSimnetPlan(root: string, artifacts: readonly ArtifactRecord[]) {
  const planPath = join(root, SIMNET_PLAN_PATH);
  if (!existsSync(planPath)) return [`missing simnet deployment plan: ${SIMNET_PLAN_PATH}`];
  const plan = readFileSync(planPath, "utf8");
  const errors: string[] = [];
  const simnetArtifacts = artifacts.filter((record) => record.network === "simnet");

  for (const artifact of simnetArtifacts) {
    const nameToken = `contract-name: ${artifact.contractName}`;
    if (countToken(plan, nameToken) !== 1) {
      errors.push(`${SIMNET_PLAN_PATH} must publish ${artifact.contractName} exactly once`);
      continue;
    }
    const nameIndex = plan.indexOf(nameToken);
    const nextTransaction = plan.indexOf("transaction-type:", nameIndex + nameToken.length);
    const transactionBlock = plan.slice(
      nameIndex,
      nextTransaction < 0 ? undefined : nextTransaction,
    );
    if (!transactionBlock.includes(`path: ${artifact.relativePath}`)) {
      errors.push(
        `${SIMNET_PLAN_PATH} maps ${artifact.contractName} to the wrong path`,
      );
    }
  }

  const generatedNames = [
    ...plan.matchAll(/contract-name: (sbtc-bond-(?:treasury|staker)-\d+)/g),
  ].map((match) => match[1]);
  if (generatedNames.length !== 12 || new Set(generatedNames).size !== 12) {
    errors.push(`${SIMNET_PLAN_PATH} must contain exactly 12 unique lane contracts`);
  }

  for (const lane of LANES) {
    const treasuryIndex = plan.indexOf(`contract-name: sbtc-bond-treasury-${lane}`);
    const stakerIndex = plan.indexOf(`contract-name: sbtc-bond-staker-${lane}`);
    if (treasuryIndex < 0 || stakerIndex < 0 || treasuryIndex > stakerIndex) {
      errors.push(
        `${SIMNET_PLAN_PATH} must publish lane ${lane} treasury before staker`,
      );
    }
  }
  return errors;
}

export function writeGenerated(root = ROOT) {
  const suite = expectedSuite(root);
  rmSync(join(root, GENERATED_CONTRACTS_DIR), { recursive: true, force: true });
  rmSync(join(root, GENERATED_METADATA_DIR), { recursive: true, force: true });
  for (const [path, content] of suite.files) {
    const absolute = join(root, path);
    mkdirSync(dirname(absolute), { recursive: true });
    writeFileSync(absolute, content);
  }

  const clarinetPath = join(root, CLARINET_PATH);
  const clarinet = readFileSync(clarinetPath, "utf8");
  writeFileSync(clarinetPath, applyClarinetBlock(clarinet, suite.artifacts));
  return suite;
}

export function checkGenerated(root = ROOT) {
  const suite = expectedSuite(root);
  const actualPaths = [
    ...listFilesRecursively(root, GENERATED_CONTRACTS_DIR),
    ...listFilesRecursively(root, GENERATED_METADATA_DIR),
  ];
  const actual = new Map(
    actualPaths.map((path) => [path, readFileSync(join(root, path), "utf8")]),
  );
  const errors = collectFileDrift(suite.files, actual);

  const clarinetPath = join(root, CLARINET_PATH);
  const clarinet = readFileSync(clarinetPath, "utf8");
  const expectedClarinet = applyClarinetBlock(clarinet, suite.artifacts);
  if (clarinet !== expectedClarinet) errors.push("generated lane block drift: Clarinet.toml");
  errors.push(...validateSimnetPlan(root, suite.artifacts));

  if (errors.length > 0) {
    throw new Error(errors.join("\n"));
  }
  return suite;
}

function main() {
  const args = process.argv.slice(2);
  if (args.length > 1 || (args.length === 1 && args[0] !== "--check")) {
    throw new Error("usage: bun scripts/generate.ts [--check]");
  }
  if (args[0] === "--check") {
    const suite = checkGenerated();
    console.log(`verified ${suite.artifacts.length} generated contract artifacts`);
  } else {
    const suite = writeGenerated();
    console.log(`generated ${suite.artifacts.length} contract artifacts`);
  }
}

if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
