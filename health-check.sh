#!/usr/bin/env bash
set -euo pipefail

ROOT="/home/max/battleship-project"
SGS="$ROOT/Stellar-Game-Studio"
FRONT="$SGS/zk-battleship-frontend"
RISC0="$ROOT/zk-battleship-risc0"

RUN_FRONT=1
RUN_CONTRACT=1
RUN_RISC0=1
RUN_ONCHAIN=1

for arg in "$@"; do
  case "$arg" in
    --skip-front) RUN_FRONT=0 ;;
    --skip-contract) RUN_CONTRACT=0 ;;
    --skip-risc0) RUN_RISC0=0 ;;
    --skip-onchain) RUN_ONCHAIN=0 ;;
    *)
      echo "Unknown arg: $arg"
      echo "Usage: $0 [--skip-front] [--skip-contract] [--skip-risc0] [--skip-onchain]"
      exit 1
      ;;
  esac
 done

ok() { printf "[OK] %s\n" "$1"; }
fail() { printf "[FAIL] %s\n" "$1"; exit 1; }
check_file() {
  local f="$1"
  [[ -f "$f" ]] && ok "file exists: $f" || fail "missing file: $f"
}

printf "\n=== ZK Battleship Health Check ===\n\n"

# 1) Critical files
check_file "$FRONT/src/games/zk-battleship/ZkBattleshipGame.tsx"
check_file "$FRONT/src/games/zk-battleship/zkBattleshipService.ts"
check_file "$FRONT/src/games/zk-battleship/bindings.ts"
check_file "$SGS/contracts/zk-battleship/src/lib.rs"
check_file "$SGS/contracts/zk-battleship/src/test.rs"
check_file "$RISC0/host/src/main.rs"
check_file "$RISC0/methods/guest/src/main.rs"
check_file "$RISC0/methods/src/lib.rs"

# 2) Local content sanity
if rg -n "Guess must be between 1 and 10|1-10|between 1 and 10" "$FRONT/src/games/zk-battleship/zkBattleshipService.ts" >/dev/null 2>&1; then
  fail "frontend service still contains 1..10 validation"
else
  ok "frontend service uses 1..16 validation"
fi

if rg -n "guess > 16|between 1 and 16|gen_range::<u64>\(1..=16\)" "$SGS/contracts/zk-battleship/src/lib.rs" >/dev/null 2>&1; then
  ok "contract source contains 1..16 checks"
else
  fail "contract source does not show expected 1..16 checks"
fi

# 3) Build checks
if [[ "$RUN_FRONT" -eq 1 ]]; then
  echo "\n[RUN] frontend build"
  (cd "$FRONT" && bun run build >/tmp/health-front.log 2>&1) || { tail -n 80 /tmp/health-front.log; fail "frontend build failed"; }
  ok "frontend build"
fi

if [[ "$RUN_CONTRACT" -eq 1 ]]; then
  echo "\n[RUN] contract tests"
  (cd "$SGS" && cargo test -p zk-battleship >/tmp/health-contract.log 2>&1) || { tail -n 120 /tmp/health-contract.log; fail "contract tests failed"; }
  ok "contract tests"
fi

if [[ "$RUN_RISC0" -eq 1 ]]; then
  echo "\n[RUN] risc0 host smoke"
  (cd "$RISC0" && cargo run -- --input ./game-input.example.json --proof ./proof-output.json --receipt ./receipt.bin >/tmp/health-risc0.log 2>&1) || { tail -n 120 /tmp/health-risc0.log; fail "risc0 run failed"; }
  ok "risc0 host run"
fi

# 4) On-chain checks
if [[ "$RUN_ONCHAIN" -eq 1 ]]; then
  check_file "$SGS/.env"
  # shellcheck disable=SC1090
  source "$SGS/.env"

  [[ -n "${VITE_ZK_BATTLESHIP_CONTRACT_ID:-}" ]] || fail "VITE_ZK_BATTLESHIP_CONTRACT_ID missing in .env"
  [[ -n "${VITE_DEV_PLAYER1_SECRET:-}" ]] || fail "VITE_DEV_PLAYER1_SECRET missing in .env"

  echo "\n[RUN] on-chain contract help"
  HELP_OUT=$(stellar contract invoke --id "$VITE_ZK_BATTLESHIP_CONTRACT_ID" --source-account "$VITE_DEV_PLAYER1_SECRET" --network testnet -- help 2>/tmp/health-onchain.err) || {
    cat /tmp/health-onchain.err
    fail "on-chain help failed"
  }

  if echo "$HELP_OUT" | rg -n "1-16|between 1 and 16" >/dev/null 2>&1; then
    ok "on-chain contract exposes 1..16 help text"
  else
    echo "$HELP_OUT" | sed -n '1,160p'
    fail "on-chain contract help does not mention 1..16 (likely old deploy)"
  fi

  VERIFIER_OUT=$(stellar contract invoke --id "$VITE_ZK_BATTLESHIP_CONTRACT_ID" --source-account "$VITE_DEV_PLAYER1_SECRET" --network testnet -- get_verifier 2>/tmp/health-onchain.err) || {
    cat /tmp/health-onchain.err
    fail "get_verifier failed"
  }
  ok "get_verifier => $VERIFIER_OUT"

  IMAGE_OUT=$(stellar contract invoke --id "$VITE_ZK_BATTLESHIP_CONTRACT_ID" --source-account "$VITE_DEV_PLAYER1_SECRET" --network testnet -- get_image_id 2>/tmp/health-onchain.err) || {
    cat /tmp/health-onchain.err
    fail "get_image_id failed"
  }
  ok "get_image_id => $IMAGE_OUT"
fi

printf "\n=== Health Check Finished Successfully ===\n"
