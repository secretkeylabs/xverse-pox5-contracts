import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Cl } from "@stacks/transactions";
import { describe, expect, it } from "vitest";
import {
  ArtifactRecord,
  CANONICAL_REVISION,
  LANES,
  NETWORK_NAMES,
  NETWORKS,
  SIGNER_MANAGER_INPUTS,
  collectFileDrift,
  renderSuite,
  sha256,
  validateArtifactRecords,
  validateGeneratedArtifact,
  validateLaneSet,
  validateNetworkSet,
} from "../scripts/generate.ts";
import {
  ALLOWANCE_SATS,
  BOND_ADMIN,
  CYCLE_LENGTH,
  MANAGER,
  MAX_SATS,
  MIN_USTX_RATIO,
  POX5,
  STX_VALUE_RATIO,
  advanceToBurnHeight,
  bondStartHeight,
  deployer,
  expectOk,
  managerPrincipal,
  plain,
  registerSignerManager,
} from "./helpers/bond-fixture";

const root = process.cwd();
const canonicalStaker = readFileSync(
  join(root, "contracts/sbtc-bond-staker.clar"),
  "utf8",
);
const canonicalTreasury = readFileSync(
  join(root, "contracts/sbtc-bond-treasury.clar"),
  "utf8",
);

const renderCanonical = () =>
  renderSuite({
    stakerSource: canonicalStaker,
    treasurySource: canonicalTreasury,
  });

interface ArtifactManifest {
  reviewedCanonicalRevision: string;
  canonicalSources: {
    staker: { path: string; sha256: string };
    treasury: { path: string; sha256: string };
  };
  artifacts: ArtifactRecord[];
}

function readManifest() {
  return JSON.parse(
    readFileSync(join(root, "generated/artifact-manifest.json"), "utf8"),
  ) as ArtifactManifest;
}

function setupBondFor(index: number, stakerName: string) {
  advanceToBurnHeight(bondStartHeight(index) - 2 * CYCLE_LENGTH);
  const result = simnet.callPublicFn(
    POX5,
    "setup-bond",
    [
      Cl.uint(index),
      Cl.uint(1000),
      Cl.uint(STX_VALUE_RATIO),
      Cl.uint(MIN_USTX_RATIO),
      Cl.bufferFromHex("00"),
      Cl.list([
        Cl.tuple({
          staker: Cl.principal(`${deployer}.${stakerName}`),
          "max-sats": Cl.uint(ALLOWANCE_SATS),
        }),
      ]),
    ],
    BOND_ADMIN,
  ).result;
  expectOk(result, `setup bond ${index} for ${stakerName}`);
}

describe("deterministic six-lane generation", () => {
  it("renders exactly one treasury and staker per lane on every network", () => {
    const first = renderCanonical();
    const second = renderCanonical();

    expect(first.artifacts).toHaveLength(36);
    expect([...first.files]).toEqual([...second.files]);
    expect(first.artifacts).toEqual(second.artifacts);

    for (const network of NETWORK_NAMES) {
      const networkRecords = first.artifacts.filter(
        (record) => record.network === network,
      );
      expect(networkRecords).toHaveLength(12);
      expect(networkRecords.map((record) => record.contractName).sort()).toEqual(
        LANES.flatMap((lane) => [
          `sbtc-bond-staker-${lane}`,
          `sbtc-bond-treasury-${lane}`,
        ]).sort(),
      );
    }
  });

  it("pins canonical and generated hashes in the committed manifest", () => {
    const manifest = readManifest();

    expect(manifest.reviewedCanonicalRevision).toBe(CANONICAL_REVISION);
    expect(manifest.canonicalSources.staker.sha256).toBe(sha256(canonicalStaker));
    expect(manifest.canonicalSources.treasury.sha256).toBe(
      sha256(canonicalTreasury),
    );
    expect(manifest.artifacts).toHaveLength(36);

    for (const artifact of manifest.artifacts) {
      const content = readFileSync(join(root, artifact.relativePath), "utf8");
      expect(sha256(content)).toBe(artifact.artifactSha256);
      expect(artifact.contractName).not.toMatch(/bridge|dao/);
      validateGeneratedArtifact(artifact, content);
    }
  });

  it("uses only declared lane and network substitutions", () => {
    const suite = renderCanonical();
    for (const artifact of suite.artifacts) {
      const content = suite.files.get(artifact.relativePath)!;
      const network = NETWORKS[artifact.network];
      expect(content).toContain(network.sbtcPrincipal);
      if (artifact.kind === "staker") {
        expect(content).toContain(network.pox5Principal);
        expect(content).toContain(`(define-constant LANE_ID u${artifact.lane})`);
        expect(content).toContain(`.sbtc-bond-treasury-${artifact.lane}`);
      } else {
        expect(content).toContain(
          `(define-constant CONTROLLER .sbtc-bond-staker-${artifact.lane})`,
        );
      }

      let normalized = content.split("\n").slice(6).join("\n");
      normalized = normalized.replaceAll(
        network.sbtcPrincipal,
        NETWORKS.simnet.sbtcPrincipal,
      );
      normalized = normalized.replaceAll(
        network.pox5Principal,
        NETWORKS.simnet.pox5Principal,
      );
      if (artifact.kind === "staker") {
        normalized = normalized.replace(
          `(define-constant LANE_ID u${artifact.lane})`,
          "(define-constant LANE_ID u0)",
        );
        normalized = normalized.replaceAll(
          `.sbtc-bond-treasury-${artifact.lane}`,
          ".sbtc-bond-treasury-0",
        );
        expect(normalized).toBe(canonicalStaker);
      } else {
        normalized = normalized.replaceAll(
          `.sbtc-bond-staker-${artifact.lane}`,
          ".sbtc-bond-staker-0",
        );
        expect(normalized).toBe(canonicalTreasury);
      }
    }
  });

  it("emits non-broadcast inputs in treasury, staker, initialize order", () => {
    for (const network of NETWORK_NAMES) {
      const deployment = JSON.parse(
        readFileSync(join(root, `generated/deployments/${network}.json`), "utf8"),
      ) as {
        broadcast: boolean;
        requiredInputs: Record<string, string>;
        stakerPrincipalForms: string[];
        operations: Array<{
          order: number;
          lane: number;
          type: string;
          contractName: string;
          function?: string;
          arguments?: Array<{ clarityName: string; input: string }>;
        }>;
      };
      expect(deployment.broadcast).toBe(false);
      expect(
        Object.keys(deployment.requiredInputs).filter((input) =>
          input.startsWith("signerManagerPrincipal"),
        ),
      ).toEqual(SIGNER_MANAGER_INPUTS);
      expect(deployment.requiredInputs).not.toHaveProperty(
        "signerManagerPrincipal",
      );
      expect(deployment.stakerPrincipalForms).toEqual(
        LANES.map((lane) => `<Xverse>.sbtc-bond-staker-${lane}`),
      );
      expect(deployment.operations).toHaveLength(18);

      const managerAssignments = new Map(
        SIGNER_MANAGER_INPUTS.map((input) => [input, [] as number[]]),
      );
      for (const lane of LANES) {
        const laneOperations = deployment.operations.filter(
          (operation) => operation.lane === lane,
        );
        expect(laneOperations.map((operation) => operation.type)).toEqual([
          "contract-publish",
          "contract-publish",
          "contract-call-template",
        ]);
        expect(laneOperations.map((operation) => operation.contractName)).toEqual([
          `sbtc-bond-treasury-${lane}`,
          `sbtc-bond-staker-${lane}`,
          `sbtc-bond-staker-${lane}`,
        ]);
        expect(laneOperations[0]!.order).toBeLessThan(laneOperations[1]!.order);

        const initialize = laneOperations[2]!;
        expect(initialize.function).toBe("initialize");
        const managerInput = initialize.arguments?.find(
          (argument) => argument.clarityName === "manager",
        )?.input;
        const expectedManager = SIGNER_MANAGER_INPUTS[lane % 3];
        expect(managerInput).toBe(expectedManager);
        managerAssignments
          .get(managerInput as (typeof SIGNER_MANAGER_INPUTS)[number])
          ?.push(lane);
      }

      expect(Object.fromEntries(managerAssignments)).toEqual({
        signerManagerPrincipal1: [0, 3],
        signerManagerPrincipal2: [1, 4],
        signerManagerPrincipal3: [2, 5],
      });
    }
  });
});

describe("generator rejection and drift checks", () => {
  it("rejects invalid and duplicate lane or network inputs", () => {
    expect(() => validateLaneSet([-1])).toThrow(/invalid lane ID/);
    expect(() => validateLaneSet([6])).toThrow(/invalid lane ID/);
    expect(() => validateLaneSet([0, 0])).toThrow(/duplicate lane ID/);
    expect(() =>
      renderSuite({
        stakerSource: canonicalStaker,
        treasurySource: canonicalTreasury,
        lanes: [0, 1, 2, 3, 4],
      }),
    ).toThrow(/complete lane set/);
    expect(() => validateNetworkSet(["devnet"])).toThrow(/invalid network/);
    expect(() => validateNetworkSet(["simnet", "simnet"])).toThrow(
      /duplicate network/,
    );
  });

  it("rejects unresolved placeholders and duplicate contract names", () => {
    expect(() =>
      renderSuite({
        stakerSource: `${canonicalStaker}\n;; {{UNRESOLVED}}\n`,
        treasurySource: canonicalTreasury,
      }),
    ).toThrow(/unresolved placeholder/);

    const records = renderCanonical().artifacts;
    expect(() =>
      validateArtifactRecords(
        [...records, records[0]!],
        LANES,
        NETWORK_NAMES,
      ),
    ).toThrow(/duplicate generated contract name/);
  });

  it("rejects cross-lane siblings and wrong-network principals", () => {
    const suite = renderCanonical();
    const staker = suite.artifacts.find(
      (record) =>
        record.network === "simnet" &&
        record.kind === "staker" &&
        record.lane === 0,
    )!;
    const content = suite.files.get(staker.relativePath)!;

    expect(() =>
      validateGeneratedArtifact(
        staker,
        content.replaceAll(".sbtc-bond-treasury-0", ".sbtc-bond-treasury-1"),
      ),
    ).toThrow(/cross-lane treasury/);
    expect(() =>
      validateGeneratedArtifact(
        staker,
        content.replaceAll(
          NETWORKS.simnet.pox5Principal,
          NETWORKS.mainnet.pox5Principal,
        ),
      ),
    ).toThrow(/wrong-network PoX-5|missing its simnet PoX-5/);
  });

  it("reports edited, missing, and unexpected generated files", () => {
    const expected = renderCanonical().files;
    const edited = new Map(expected);
    const firstPath = [...edited.keys()][0]!;
    edited.set(firstPath, `${edited.get(firstPath)};; manual edit\n`);
    edited.delete("generated/deployments/testnet.json");
    edited.set("generated/unexpected.json", "{}\n");

    expect(collectFileDrift(expected, edited)).toEqual(
      expect.arrayContaining([
        `generated file drift: ${firstPath}`,
        "missing generated file: generated/deployments/testnet.json",
        "unexpected generated file: generated/unexpected.json",
      ]),
    );
  });
});

describe("all six generated simnet lanes", () => {
  it("loads all pairs with observable lane IDs and same-lane controllers", () => {
    for (const lane of LANES) {
      const staker = `sbtc-bond-staker-${lane}`;
      const treasury = `sbtc-bond-treasury-${lane}`;
      const laneId = simnet.callReadOnlyFn(
        staker,
        "get-lane-id",
        [],
        deployer,
      ).result;
      const controller = simnet.callReadOnlyFn(
        treasury,
        "get-controller",
        [],
        deployer,
      ).result;

      expect(laneId).toBeUint(lane);
      expect(plain(controller)).toBe(`${deployer}.${staker}`);
    }

    const staker = "sbtc-bond-staker-0";
    expect(
      simnet.callReadOnlyFn(
        staker,
        "get-trusted-signer",
        [Cl.bufferFromHex("00".repeat(32))],
        deployer,
      ).result,
    ).toBeNone();
    expect(
      simnet.callReadOnlyFn(
        staker,
        "get-rollover-commitment",
        [Cl.uint(0), Cl.principal(deployer)],
        deployer,
      ).result,
    ).toBeNone();
    expect(
      simnet.callReadOnlyFn(
        staker,
        "get-sats-for-ustx",
        [Cl.uint(0)],
        deployer,
      ).result,
    ).toBeUint(0);
    expect(
      simnet.callReadOnlyFn(staker, "get-committing-sats", [], deployer).result,
    ).toBeUint(0);
  });

  for (const lane of LANES) {
    it(`lane ${lane} rejects an adjacent lane and binds bond ${lane + 6}`, () => {
      const staker = `sbtc-bond-staker-${lane}`;
      expectOk(registerSignerManager(), "register signer manager");
      expectOk(
        simnet.callPublicFn(
          staker,
          "initialize",
          [Cl.principal(managerPrincipal(MANAGER)), Cl.principal(deployer)],
          deployer,
        ).result,
        `initialize ${staker}`,
      );

      const wrongIndex = lane + 5;
      const correctIndex = lane + 6;
      setupBondFor(wrongIndex, staker);
      expect(
        simnet.callPublicFn(
          staker,
          "bind-bond",
          [Cl.uint(wrongIndex), Cl.uint(MAX_SATS), Cl.uint(0)],
          deployer,
        ).result,
      ).toBeErr(Cl.uint(132));

      setupBondFor(correctIndex, staker);
      expectOk(
        simnet.callPublicFn(
          staker,
          "bind-bond",
          [Cl.uint(correctIndex), Cl.uint(MAX_SATS), Cl.uint(0)],
          deployer,
        ).result,
        `bind ${staker} to ${correctIndex}`,
      );
    });
  }
});
