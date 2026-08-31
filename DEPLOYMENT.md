# Six-lane deployment inputs

The deterministic generator creates non-broadcast deployment inputs from
canonical revision `fa91d19053202b262d792485d4e13db179672eaa`.

## Exact contract and principal forms

One Xverse-controlled Stacks standard principal publishes twelve contracts. On
mainnet, the canonical publisher is
`SP8HK160YD5GHXP69VGA0TC7AQJ1X4CDW3XVERSE`:

| Lane | Treasury contract | Staker contract | Mainnet PoX-5 allowlist principal |
|---:|---|---|---|
| 0 | `sbtc-bond-treasury-v1-0` | `sbtc-bond-staker-v1-0` | `SP8HK160YD5GHXP69VGA0TC7AQJ1X4CDW3XVERSE.sbtc-bond-staker-v1-0` |
| 1 | `sbtc-bond-treasury-v1-1` | `sbtc-bond-staker-v1-1` | `SP8HK160YD5GHXP69VGA0TC7AQJ1X4CDW3XVERSE.sbtc-bond-staker-v1-1` |
| 2 | `sbtc-bond-treasury-v1-2` | `sbtc-bond-staker-v1-2` | `SP8HK160YD5GHXP69VGA0TC7AQJ1X4CDW3XVERSE.sbtc-bond-staker-v1-2` |
| 3 | `sbtc-bond-treasury-v1-3` | `sbtc-bond-staker-v1-3` | `SP8HK160YD5GHXP69VGA0TC7AQJ1X4CDW3XVERSE.sbtc-bond-staker-v1-3` |
| 4 | `sbtc-bond-treasury-v1-4` | `sbtc-bond-staker-v1-4` | `SP8HK160YD5GHXP69VGA0TC7AQJ1X4CDW3XVERSE.sbtc-bond-staker-v1-4` |
| 5 | `sbtc-bond-treasury-v1-5` | `sbtc-bond-staker-v1-5` | `SP8HK160YD5GHXP69VGA0TC7AQJ1X4CDW3XVERSE.sbtc-bond-staker-v1-5` |

`<Xverse>` in network-neutral generated metadata means the actual standard
principal that publishes the contracts; for mainnet it resolves to the address
above. It is not a second contract or a generator input. Deployment signing
credentials are intentionally absent from this repository. The retired PoX-4
pool address is not an input to this deployment and is not referenced by the
PoX-5 artifacts.

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

1. publish `sbtc-bond-treasury-v1-X`;
2. publish `sbtc-bond-staker-v1-X`; and
3. call `sbtc-bond-staker-v1-X.initialize` with its assigned registered signer
   manager and the initial pool operator.

The six lanes are distributed evenly across three signer-manager inputs:

| Signer-manager input | Lane contracts |
|---|---|
| `signerManagerPrincipal1` | `sbtc-bond-staker-v1-0`, `sbtc-bond-staker-v1-3` |
| `signerManagerPrincipal2` | `sbtc-bond-staker-v1-1`, `sbtc-bond-staker-v1-4` |
| `signerManagerPrincipal3` | `sbtc-bond-staker-v1-2`, `sbtc-bond-staker-v1-5` |

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

## Mainnet deployment script

The Bun deployment script verifies the generated artifact hashes, the three
signer-manager source hashes and PoX-5 registrations, the deployer nonce, and
the deployer's STX balance. It refuses a private key that does not derive the
canonical mainnet publisher
`SP8HK160YD5GHXP69VGA0TC7AQJ1X4CDW3XVERSE`, then signs twelve contract
publications and six `initialize` calls in the generated order:

```bash
# Securely prompt for "Deployer private key", then ask before broadcasting.
bun run deploy -- --op-all SP...OPERATOR

# Supply the key non-interactively and broadcast without the confirmation menu.
bun run deploy -- \
  --deployer-private-key "$DEPLOYER_PRIVATE_KEY" \
  --op-0 SP...OPERATOR0 \
  --op-1 SP...OPERATOR1 \
  --op-2 SP...OPERATOR2 \
  --op-3 SP...OPERATOR3 \
  --op-4 SP...OPERATOR4 \
  --op-5 SP...OPERATOR5 \
  --broadcast
```

The mainnet defaults are:

- `SP8HK160YD5GHXP69VGA0TC7AQJ1X4CDW3XVERSE.xverse-signer-manager-1`
  for lanes 0 and 3;
- `SP8HK160YD5GHXP69VGA0TC7AQJ1X4CDW3XVERSE.xverse-signer-manager-2`
  for lanes 1 and 4; and
- `SP8HK160YD5GHXP69VGA0TC7AQJ1X4CDW3XVERSE.xverse-signer-manager-3`
  for lanes 2 and 5.

Override them with `--signer-manager-1`, `--signer-manager-2`, and
`--signer-manager-3`. Every selected manager must have the reviewed mainnet
source hash and already be registered with PoX-5. `--fee-ustx` sets one explicit
fee, in micro-STX, on each transaction; otherwise the script requests the
network's medium estimate and falls back to its transfer fee rate.

Before any broadcast choice, all signed raw transactions are written with mode
`0600` to the git-ignored path
`deployment-transactions/deployment-<UNIX-TIMESTAMP-SECONDS>/transactions.json`.
Anyone with that file can broadcast its transactions. Supplying the private key
on the command line may also expose it in shell history and process listings;
omit the option to use the masked prompt.

The script broadcasts in order and records each node response, but does not
wait for confirmation, retry, resume, skip existing deployments, or alter
nonces after signing. Handle partial execution manually. PoX-5 bond allowlisting
remains a separate operation.

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

Do not run `clarinet deployments apply` merely to validate these inputs. Use the
Bun script only after reviewing its printed mainnet principals, operators,
nonces, and fees; allowlist transactions remain outside the script.
