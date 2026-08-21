# Xverse PoX-5 Contracts

Clarity smart contracts for Xverse PoX-5 integrations.

## Prerequisites

- [Clarinet](https://docs.stacks.co/clarinet) 3.23.1 or newer
- [Bun](https://bun.sh/) 1.4.0 or newer
- Docker, only when running a local Devnet

## Setup

```sh
bun install
```

## Development

Create a contract and its test file:

```sh
clarinet contracts new <contract-name>
```

Check all contracts:

```sh
bun run check
```

Run tests:

```sh
bun run test
```

Other useful commands:

```sh
bun run test:watch       # rerun tests after contract or test changes
bun run test:report      # include Clarinet coverage and cost reports
clarinet console         # open the interactive Clarity REPL
clarinet format          # format Clarity source files
clarinet devnet start    # start a local Devnet (requires Docker)
```

Contract sources belong in `contracts/`, with TypeScript tests in `tests/`.
