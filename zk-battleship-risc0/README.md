# zk-battleship-risc0

RISC Zero prover for the `zk-battleship` Stellar demo.

This crate generates a proof artifact (`proof-output.json`) used by the frontend to call `submit_result(...)` on-chain.

## What It Produces

Running the host writes:

- `proof-output.json`
  - `journal_hex`
  - `seal_hex` (null in `RISC0_DEV_MODE=1`)
  - `public_output` (`session_id`, `winner`, `board_hash_p1`, `board_hash_p2`, `total_moves`)
- `receipt.bin` (serialized compressed receipt)

## Input Format

Use `game-input.example.json` as template:

```json
{
  "session_id": 149478304,
  "board_p1": [1,1,0,0,1,1,0,0,0,0,0,0,0,0,0,0],
  "board_p2": [1,1,0,0,1,1,0,0,0,0,0,0,0,0,0,0],
  "moves": [
    {"player":1,"x":0,"y":0},
    {"player":2,"x":0,"y":0}
  ]
}
```

## CLI Usage

```bash
cargo run -- [--session <u32>] [--input <game-input.json>] [--proof <proof-output.json>] [--receipt <receipt.bin>]
```

Examples:

```bash
# Use built-in sample input (default session 42)
cargo run

# Use file input and keep session from file
cargo run -- --input ./game-input.example.json --proof ./proof-output.json --receipt ./receipt.bin

# Use file input and override session_id from CLI
cargo run -- --input ./game-input.example.json --session 149478304 --proof ./proof-output.json --receipt ./receipt.bin
```

## Mini Demo Flow (End-to-End)

1. In frontend (`Stellar-Game-Studio`), create/start a game and note the `Session ID`.
2. Ensure both players submit moves so game reaches reveal phase.
3. In this prover project, run:

```bash
cargo run -- --input ./game-input.example.json --session <SESSION_ID> --proof ./proof-output.json --receipt ./receipt.bin
```

4. Copy full `proof-output.json` content.
5. Paste in frontend reveal phase (`Submit ZK Match Proof`) and click `Submit Proof Result`.

## Fast Dev Mode

Use this for quick local iteration (proofs are not valid for production):

```bash
RISC0_DEV_MODE=1 cargo run -- --input ./game-input.example.json --session <SESSION_ID>
```

## Common Issues

- `Game not found` in frontend:
  - Session does not exist on-chain for the current contract deployment.
  - Create/start the game first and use that exact `session_id`.

- Session mismatch error in frontend:
  - `public_output.session_id` in `proof-output.json` does not match loaded game session.
  - Re-run host with `--session <SESSION_ID_FROM_UI>`.

- `seal_hex` is `null`:
  - You ran with `RISC0_DEV_MODE=1`.
  - Run normal mode (`cargo run ...`) to get Groth16 seal.
