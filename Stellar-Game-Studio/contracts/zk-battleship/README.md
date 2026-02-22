# zk-battleship Soroban Contract

`zk-battleship` is the on-chain settlement contract for the Provably Fair Battleship demo.

It integrates with:
- **Game Hub** (required lifecycle): `start_game` / `end_game`
- **RISC0 verifier contract**: proof verification inside `submit_result`

## Contract Responsibilities

- Start game sessions and lock points via Game Hub
- Accept player shots (`make_guess`) in range `1..16` (compatibility endpoint name)
- Reveal winner for compatibility mode (`reveal_winner`)
- Settle with zk-proof (`submit_result`) as the canonical hackathon path

## Main Methods

- `start_game(session_id, player1, player2, player1_points, player2_points)`
- `make_guess(session_id, player, guess)`
- `reveal_winner(session_id)`
- `submit_result(session_id, submitter, winner, total_moves, board_hash_p1, board_hash_p2, journal, seal)`
- `set_verifier(verifier)`
- `set_image_id(image_id)`
- `get_verifier()`
- `get_image_id()`

## ZK Settlement Path

`submit_result(...)` performs:
1. input sanity checks,
2. verifier call (`verify(seal, image_id, journal_digest)`),
3. winner/session consistency checks,
4. Game Hub settlement through `end_game(...)`.

## Build

```bash
cargo test
cargo rustc --target wasm32v1-none --release
```

or from repo root:

```bash
bun run build zk-battleship
```

## Notes

- Function names keep compatibility with Game Studio templates (`make_guess` fields), while frontend labels use Battleship terms (`shot/cell`).
- Required Game Hub contract on testnet:
  - `CB4VZAT2U3UC6XFK3N23SKRF2NDCMP3QHJYMCHHFMZO7MRQO6DQ2EMYG`
