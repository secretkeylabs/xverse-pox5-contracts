# Six-lane deployment inputs

The deterministic generator creates non-broadcast deployment inputs from
canonical revision `31cd6e23e882d627daa7e03b0b040d5f0f473be8`.

## Exact contract and principal forms

One Xverse-controlled Stacks standard principal publishes twelve contracts:

| Lane | Treasury contract | Staker contract | PoX-5 allowlist principal |
|---:|---|---|---|
| 0 | `sbtc-bond-treasury-0` | `sbtc-bond-staker-0` | `<Xverse>.sbtc-bond-staker-0` |
| 1 | `sbtc-bond-treasury-1` | `sbtc-bond-staker-1` | `<Xverse>.sbtc-bond-staker-1` |
| 2 | `sbtc-bond-treasury-2` | `sbtc-bond-staker-2` | `<Xverse>.sbtc-bond-staker-2` |
| 3 | `sbtc-bond-treasury-3` | `sbtc-bond-staker-3` | `<Xverse>.sbtc-bond-staker-3` |
| 4 | `sbtc-bond-treasury-4` | `sbtc-bond-staker-4` | `<Xverse>.sbtc-bond-staker-4` |
| 5 | `sbtc-bond-treasury-5` | `sbtc-bond-staker-5` | `<Xverse>.sbtc-bond-staker-5` |

`<Xverse>` means the actual standard principal that publishes the contracts; it
is not a second contract or a generator input. Deployment signing credentials
are intentionally absent from this repository.

Each lane accepts only bond indexes congruent to its lane ID modulo six. Bond
setup must allowlist the exact matching staker principal and lane-specific sats
allowance. An allowance for one principal cannot be used by another lane.
Seamless sequences are `X -> X+6 -> X+12`; setup and binding are operational
transactions outside the generator.

## Generated outputs

Run:

```bash
bun run generate
bun run check:generated
```

The generator writes:

- `contracts/generated/{simnet,testnet,mainnet}/` — twelve contracts per target;
- `generated/artifact-manifest.json` — canonical hashes, target principals,
  contract names, sibling names, and artifact hashes;
- `generated/deployments/{simnet,testnet,mainnet}.json` — ordered non-broadcast
  publish and initialization templates;
- the generated lane section in `Clarinet.toml`; and
- Clarinet's simnet deployment plan.

The protocol-principal matrix is:

| Target | PoX-5 principal | sBTC deployer principal |
|---|---|---|
| simnet | `ST000000000000000000002AMW42H` | `SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4` |
| testnet | `ST000000000000000000002AMW42H` | `SN3VMHXEN64ZZF71JQ5VESXDWTR301XTTXGF4J8F1` |
| mainnet | `SP000000000000000000002Q6VF78` | `SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4` |

The checked-in generated files are build artifacts. Review and modify only the
canonical sources and generator, then regenerate. `bun run check:generated`
fails for a modified, missing, unexpected, cross-lane, unresolved-placeholder,
or wrong-network artifact.

## Ordering and required operational inputs

For every lane, generated deployment input orders:

1. publish `sbtc-bond-treasury-X`;
2. publish `sbtc-bond-staker-X`; and
3. call `sbtc-bond-staker-X.initialize` with its assigned registered signer
   manager and the initial pool operator.

The six lanes are distributed evenly across three signer-manager inputs:

| Signer-manager input | Lane contracts |
|---|---|
| `signerManagerPrincipal1` | `sbtc-bond-staker-0`, `sbtc-bond-staker-3` |
| `signerManagerPrincipal2` | `sbtc-bond-staker-1`, `sbtc-bond-staker-4` |
| `signerManagerPrincipal3` | `sbtc-bond-staker-2`, `sbtc-bond-staker-5` |

The JSON files declare, but do not resolve, these controlled deployment inputs:

- Xverse deployer standard principal;
- three distinct, deployed, and PoX-5-registered signer-manager contract
  principals; and
- initial pool-operator principal.

They contain no private key, mnemonic, fee choice, broadcast instruction, bond
index, or allowance amount. A controlled deployment system must resolve inputs,
verify that all three signer-manager values are distinct and registered with the
target PoX-5 contract, verify every artifact hash against the manifest, preserve
the encoded ordering and lane assignment, and review the resulting full contract
principals before signing.

After publication and initialization, PoX-5 bond setup must separately create
the matching allowlist entries before an operator can bind a bond. Contract
generation cannot create or alter those entries.

## Pre-deployment verification

From a clean checkout of the pinned revision:

```bash
bun install --frozen-lockfile
bun run check:generated
bun run check
bun run test
bun run check:format
git diff --exit-code -- contracts Clarinet.toml generated deployments/default.simnet-plan.yaml
```

Production deployment and allowlist transactions are explicitly outside this
repository task. Never run `clarinet deployments apply` merely to validate these
inputs.
