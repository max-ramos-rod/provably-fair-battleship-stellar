# Provably Fair Battleship on Stellar (RISC Zero)

Hackathon project for **ZK Gaming on Stellar**.

This repository contains a full end-to-end prototype where:
- gameplay happens off-chain,
- the full match is proven in RISC Zero,
- the result is verified on-chain in Soroban,
- and the game is settled through the Stellar Game Hub lifecycle (`start_game` / `end_game`).

## Project Layout

- `Stellar-Game-Studio/`
  - game frontend (`zk-battleship-frontend`)
  - Soroban game contract (`contracts/zk-battleship`)
- `zk-battleship-risc0/`
  - RISC Zero guest + host prover
  - generates `proof-output.json` and `receipt.bin`
- `stellar-risc0-verifier/`
  - Soroban verifier contract used by `submit_result`

## Core ZK Mechanic

At match end, players submit a proof that verifies the whole game history.

The zkVM validates:
- board validity,
- turn order,
- hit/miss correctness,
- and legitimate winner from the move history.

Public output includes:
- `session_id`
- `winner`
- `board_hash_p1`
- `board_hash_p2`
- `total_moves`

## End-to-End Flow

1. **On-chain start**
   - `start_game(...)` called in game contract
   - game contract calls Game Hub `start_game(...)`

2. **Off-chain gameplay (frontend)**
   - board setup for both players (4x4, 4 ship cells each)
   - alternating shots tracked locally
   - UI exports `game-input.json`

3. **Proving (RISC Zero host)**
   - run prover with exported game input
   - produce `proof-output.json`

4. **On-chain settlement**
   - frontend submits proof payload via `submit_result(...)`
   - contract verifies through configured verifier
   - contract calls Game Hub `end_game(...)`

## Quick Demo Commands

### 1) Run frontend

```bash
cd Stellar-Game-Studio
bun run dev:game zk-battleship
```

### 2) Generate proof from exported game input

```bash
cd ../zk-battleship-risc0
cargo run -- --input ./game-input-<SESSION_ID>.json --proof ./proof-output.json --receipt ./receipt.bin
```

### 3) Submit proof in UI

- Copy full `proof-output.json`
- Paste in **Submit ZK Match Proof** screen
- Click **Submit Proof Result**

## Environment Notes

- Make sure frontend uses the intended contract ID in:
  - `Stellar-Game-Studio/.env` -> `VITE_ZK_BATTLESHIP_CONTRACT_ID`
- `proof-output.json.public_output.session_id` must match loaded game session in UI.
- If `RISC0_DEV_MODE=1` is enabled, proof seal is dev-mode (not production-grade).

## Hackathon Requirements Mapping

- **ZK-powered mechanic**: yes (proof is core to match settlement)
- **Deployed on-chain component**: yes (Soroban + Game Hub hooks)
- **Frontend**: yes (playable flow + proof submit)
- **Open-source repo**: this repository
- **Video demo**: to be included in submission

## License

Project code follows upstream licenses of included components and your own additions.
