#!/usr/bin/env bun

import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const canonicalFiles = {
  staker: "contracts/sbtc-bond-staker.clar",
  treasury: "contracts/sbtc-bond-treasury.clar",
} as const;
const definitionPattern =
  /\(define-(?:public|read-only|private)\s+\(([^\s()]+)/g;

const definitions = new Map<string, number>();
for (const [kind, relativePath] of Object.entries(canonicalFiles)) {
  const source = readFileSync(join(root, relativePath), "utf8");
  for (const match of source.matchAll(definitionPattern)) {
    definitions.set(`${kind}::${match[1]}`, 0);
  }
}

const lcov = readFileSync(join(root, "lcov.info"), "utf8");
let sourceFile = "";
for (const line of lcov.split("\n")) {
  if (line.startsWith("SF:")) sourceFile = line.slice(3);
  if (!line.startsWith("FNDA:")) continue;
  const staker = sourceFile.endsWith(
    "/contracts/generated/simnet/sbtc-bond-staker-0.clar",
  );
  const treasury = sourceFile.endsWith(
    "/contracts/generated/simnet/sbtc-bond-treasury-0.clar",
  );
  if (!staker && !treasury) continue;

  const comma = line.indexOf(",");
  const count = Number(line.slice(5, comma));
  const name = line.slice(comma + 1);
  const key = `${staker ? "staker" : "treasury"}::${name}`;
  if (definitions.has(key)) definitions.set(key, definitions.get(key)! + count);
}

const uncovered = [...definitions]
  .filter(([, count]) => count === 0)
  .map(([key]) => key);
if (uncovered.length > 0) {
  throw new Error(`uncovered canonical functions:\n${uncovered.join("\n")}`);
}

interface CostDimension {
  write_length: number;
  write_count: number;
  read_length: number;
  read_count: number;
  runtime: number;
}
interface CostRecord {
  contract_id: string;
  method: string;
  cost_result: {
    total: CostDimension;
    limit: CostDimension;
    memory: number;
    memory_limit: number;
  };
}
const costs = JSON.parse(
  readFileSync(join(root, "costs-reports.json"), "utf8"),
) as CostRecord[];

const publicMethods = new Set<string>();
for (const relativePath of Object.values(canonicalFiles)) {
  const source = readFileSync(join(root, relativePath), "utf8");
  for (const match of source.matchAll(/\(define-public\s+\(([^\s()]+)/g)) {
    publicMethods.add(match[1]!);
  }
}
const observedPublicMethods = new Set(
  costs
    .filter(
      (record) =>
        record.contract_id.includes(".sbtc-bond-staker-") ||
        record.contract_id.includes(".sbtc-bond-treasury-"),
    )
    .map((record) => record.method),
);
const missingPublicCosts = [...publicMethods].filter(
  (method) => !observedPublicMethods.has(method),
);
if (missingPublicCosts.length > 0) {
  throw new Error(
    `public paths missing from cost report: ${missingPublicCosts.join(", ")}`,
  );
}

const requiredEveryLane = [
  "initialize",
  "bind-bond",
  "deposit",
  "stake",
  "commit-rollover",
  "settle-member",
  "sync-rewards",
  "unstake-sbtc-early",
];
for (let lane = 0; lane < 6; lane += 1) {
  const contractSuffix = `.sbtc-bond-staker-${lane}`;
  const observed = new Set(
    costs
      .filter((record) => record.contract_id.endsWith(contractSuffix))
      .map((record) => record.method),
  );
  const missing = requiredEveryLane.filter((method) => !observed.has(method));
  if (missing.length > 0) {
    throw new Error(
      `lane ${lane} missing critical cost paths: ${missing.join(", ")}`,
    );
  }
}

const dimensions = [
  "write_length",
  "write_count",
  "read_length",
  "read_count",
  "runtime",
] as const;
let maximum = {
  ratio: 0,
  dimension: "",
  contract: "",
  method: "",
};
for (const record of costs) {
  for (const dimension of dimensions) {
    const ratio =
      record.cost_result.total[dimension] / record.cost_result.limit[dimension];
    if (ratio > maximum.ratio) {
      maximum = {
        ratio,
        dimension,
        contract: record.contract_id,
        method: record.method,
      };
    }
  }
  const memoryRatio =
    record.cost_result.memory / record.cost_result.memory_limit;
  if (memoryRatio > maximum.ratio) {
    maximum = {
      ratio: memoryRatio,
      dimension: "memory",
      contract: record.contract_id,
      method: record.method,
    };
  }
}
if (maximum.ratio >= 1) {
  throw new Error(
    `cost limit reached by ${maximum.contract}::${maximum.method} (${maximum.dimension})`,
  );
}

console.log(`canonical-equivalent function coverage: ${definitions.size}/${definitions.size}`);
console.log(`public cost paths: ${publicMethods.size}/${publicMethods.size}`);
const criticalPathCount = requiredEveryLane.length * 6;
console.log(
  `critical six-lane cost paths: ${criticalPathCount}/${criticalPathCount}`,
);
console.log(
  `maximum observed cost: ${(maximum.ratio * 100).toFixed(4)}% ${maximum.dimension} ` +
    `${maximum.contract}::${maximum.method}`,
);
