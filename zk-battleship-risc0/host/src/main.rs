use methods::{METHOD_ELF, METHOD_ID};
use risc0_zkvm::{default_prover, ExecutorEnv, ProverOpts};
use serde::{Deserialize, Serialize};
use std::env;
use std::fs::{self, File};
use std::io::Write;

#[derive(Debug, Deserialize, Serialize)]
struct Move {
    player: u8,
    x: u8,
    y: u8,
}

#[derive(Debug, Deserialize, Serialize)]
struct GameInput {
    session_id: u32,
    board_p1: [u8; 16],
    board_p2: [u8; 16],
    moves: Vec<Move>,
}

#[derive(Debug, Deserialize, Serialize)]
struct PublicOutput {
    session_id: u32,
    winner: u8,
    board_hash_p1: [u8; 32],
    board_hash_p2: [u8; 32],
    total_moves: u32,
}

#[derive(Debug, Serialize)]
struct PublicOutputJson {
    session_id: u32,
    winner: u8,
    board_hash_p1: String,
    board_hash_p2: String,
    total_moves: u32,
}

#[derive(Debug, Serialize)]
struct ProofOutputFile {
    journal_hex: String,
    seal_hex: Option<String>,
    public_output: PublicOutputJson,
}

#[derive(Debug)]
struct CliOptions {
    session_id: Option<u32>,
    input_path: Option<String>,
    proof_out_path: String,
    receipt_out_path: String,
}

fn usage() -> &'static str {
    "Usage: cargo run -- [--session <u32>] [--input <game-input.json>] [--proof <proof-output.json>] [--receipt <receipt.bin>]\n\nExamples:\n  cargo run -- --session 149478304\n  cargo run -- --input ./game-input.json\n  cargo run -- --input ./game-input.json --session 149478304 --proof ./proof-output.json --receipt ./receipt.bin\n"
}

fn parse_cli_args() -> Result<CliOptions, String> {
    let mut session_id: Option<u32> = None;
    let mut input_path: Option<String> = None;
    let mut proof_out_path = String::from("proof-output.json");
    let mut receipt_out_path = String::from("receipt.bin");

    let mut args = env::args().skip(1);
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--help" | "-h" => {
                println!("{}", usage());
                std::process::exit(0);
            }
            "--session" => {
                let value = args
                    .next()
                    .ok_or_else(|| String::from("Missing value for --session"))?;
                let parsed = value
                    .parse::<u32>()
                    .map_err(|_| String::from("--session must be a valid u32"))?;
                if parsed == 0 {
                    return Err(String::from("--session must be greater than 0"));
                }
                session_id = Some(parsed);
            }
            "--input" => {
                let value = args
                    .next()
                    .ok_or_else(|| String::from("Missing value for --input"))?;
                if value.trim().is_empty() {
                    return Err(String::from("--input path cannot be empty"));
                }
                input_path = Some(value);
            }
            "--proof" => {
                proof_out_path = args
                    .next()
                    .ok_or_else(|| String::from("Missing value for --proof"))?;
                if proof_out_path.trim().is_empty() {
                    return Err(String::from("--proof path cannot be empty"));
                }
            }
            "--receipt" => {
                receipt_out_path = args
                    .next()
                    .ok_or_else(|| String::from("Missing value for --receipt"))?;
                if receipt_out_path.trim().is_empty() {
                    return Err(String::from("--receipt path cannot be empty"));
                }
            }
            other => {
                return Err(format!("Unknown argument: {other}"));
            }
        }
    }

    Ok(CliOptions {
        session_id,
        input_path,
        proof_out_path,
        receipt_out_path,
    })
}

fn default_game_input(session_id: u32) -> GameInput {
    GameInput {
        session_id,
        board_p1: [
            1, 1, 0, 0, // y=0 (ship size 2)
            0, 0, 0, 0, // y=1
            1, 1, 0, 0, // y=2 (ship size 2)
            0, 0, 0, 0, // y=3
        ],
        board_p2: [
            1, 1, 0, 0, // y=0 (ship size 2)
            0, 0, 0, 0, // y=1
            1, 1, 0, 0, // y=2 (ship size 2)
            0, 0, 0, 0, // y=3
        ],
        moves: vec![
            Move {
                player: 1,
                x: 0,
                y: 0,
            },
            Move {
                player: 2,
                x: 3,
                y: 3,
            },
            Move {
                player: 1,
                x: 1,
                y: 0,
            },
            Move {
                player: 2,
                x: 3,
                y: 2,
            },
            Move {
                player: 1,
                x: 0,
                y: 2,
            },
            Move {
                player: 2,
                x: 2,
                y: 2,
            },
            Move {
                player: 1,
                x: 1,
                y: 2,
            },
        ],
    }
}

fn load_game_input(path: &str) -> Result<GameInput, String> {
    let raw = fs::read_to_string(path)
        .map_err(|e| format!("Failed to read input file '{}': {e}", path))?;
    serde_json::from_str::<GameInput>(&raw)
        .map_err(|e| format!("Failed to parse JSON in '{}': {e}", path))
}

fn build_game_input(cli: &CliOptions) -> Result<GameInput, String> {
    let mut input = if let Some(path) = &cli.input_path {
        load_game_input(path)?
    } else {
        default_game_input(cli.session_id.unwrap_or(42))
    };

    if let Some(session_id) = cli.session_id {
        input.session_id = session_id;
    }

    if input.session_id == 0 {
        return Err(String::from("game input session_id must be greater than 0"));
    }

    Ok(input)
}

fn write_receipt_bin(bytes: &[u8], path: &str) {
    let mut file = File::create(path).unwrap();
    file.write_all(bytes).unwrap();
    println!("receipt saved: {}", path);
}

fn write_proof_output_json(content: &ProofOutputFile, path: &str) {
    let json = serde_json::to_string_pretty(content).unwrap();
    fs::write(path, json).unwrap();
    println!("proof output saved: {}", path);
}

fn run_proof(input: &GameInput) -> Result<(risc0_zkvm::Receipt, PublicOutputJson), String> {
    let env = ExecutorEnv::builder()
        .write(input)
        .map_err(|e| format!("failed to write executor input: {e}"))?
        .build()
        .map_err(|e| format!("failed to build executor env: {e}"))?;

    let prover = default_prover();
    let prove_info = prover
        .prove(env, METHOD_ELF)
        .map_err(|e| format!("prove failed: {e}"))?;
    let receipt = prove_info.receipt;

    receipt
        .verify(METHOD_ID)
        .map_err(|e| format!("receipt verification failed: {e}"))?;

    let output: PublicOutput = receipt
        .journal
        .decode()
        .map_err(|e| format!("journal decode failed: {e}"))?;

    let public_output_json = PublicOutputJson {
        session_id: output.session_id,
        winner: output.winner,
        board_hash_p1: hex::encode(output.board_hash_p1),
        board_hash_p2: hex::encode(output.board_hash_p2),
        total_moves: output.total_moves,
    };

    Ok((receipt, public_output_json))
}

fn main() {
    tracing_subscriber::fmt()
        .with_env_filter(tracing_subscriber::filter::EnvFilter::from_default_env())
        .init();

    let cli = match parse_cli_args() {
        Ok(options) => options,
        Err(err) => {
            eprintln!("Error: {}\n\n{}", err, usage());
            std::process::exit(2);
        }
    };

    let input = match build_game_input(&cli) {
        Ok(input) => input,
        Err(err) => {
            eprintln!("Error: {}\n\n{}", err, usage());
            std::process::exit(2);
        }
    };

    println!("session_id: {}", input.session_id);
    println!("input path: {}", cli.input_path.as_deref().unwrap_or("<built-in sample>"));
    println!("proof output path: {}", cli.proof_out_path);
    println!("receipt output path: {}", cli.receipt_out_path);

    let prover = default_prover();

    let (receipt, public_output_json) = match run_proof(&input) {
        Ok(data) => data,
        Err(err) => {
            eprintln!("Error: {}", err);
            std::process::exit(1);
        }
    };

    println!("winner: {}", public_output_json.winner);
    println!("total_moves: {}", public_output_json.total_moves);
    println!("board_hash_p1: {}", public_output_json.board_hash_p1);
    println!("board_hash_p2: {}", public_output_json.board_hash_p2);

    match prover.compress(&ProverOpts::groth16(), &receipt) {
        Ok(compressed_receipt) => {
            let receipt_bytes = bincode::serialize(&compressed_receipt).unwrap();
            write_receipt_bin(&receipt_bytes, &cli.receipt_out_path);

            let journal_hex = hex::encode(&compressed_receipt.journal.bytes);
            println!("Journal HEX: {}", journal_hex);

            let seal_hex = match compressed_receipt.inner.groth16() {
                Ok(groth16) => {
                    let seal = hex::encode(&groth16.seal);
                    println!("Seal HEX: {}", seal);
                    Some(seal)
                }
                Err(_) => {
                    println!(
                        "Groth16 seal is unavailable in this mode (expected in RISC0_DEV_MODE=1)."
                    );
                    None
                }
            };

            let artifact = ProofOutputFile {
                journal_hex,
                seal_hex,
                public_output: public_output_json,
            };
            write_proof_output_json(&artifact, &cli.proof_out_path);
        }
        Err(err) => {
            println!("Skipping Groth16 compression: {err}");

            let artifact = ProofOutputFile {
                journal_hex: hex::encode(&receipt.journal.bytes),
                seal_hex: None,
                public_output: public_output_json,
            };
            write_proof_output_json(&artifact, &cli.proof_out_path);
        }
    }
}


#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn valid_input_proves_successfully() {
        let input = default_game_input(777);
        let result = run_proof(&input);
        assert!(result.is_ok(), "expected valid input to prove, got: {:?}", result.err());

        let (_, out) = result.unwrap();
        assert_eq!(out.session_id, 777);
        assert_eq!(out.total_moves, 7);
    }

    #[test]
    fn duplicate_shot_is_rejected_by_guest() {
        let mut input = default_game_input(778);
        // Duplicate shot for player 1 at (0,0)
        input.moves = vec![
            Move { player: 1, x: 0, y: 0 },
            Move { player: 2, x: 1, y: 0 },
            Move { player: 1, x: 0, y: 0 },
            Move { player: 2, x: 2, y: 0 },
        ];

        let err = run_proof(&input).expect_err("expected duplicate shot to fail");
        assert!(
            err.contains("duplicate shot by player 1"),
            "unexpected error message: {err}"
        );
    }


    #[test]
    fn invalid_board_layout_is_rejected() {
        let mut input = default_game_input(7781);
        // 2x2 contiguous block is one ship of size 4, which is invalid for the new rule.
        input.board_p1 = [
            1, 1, 0, 0,
            1, 1, 0, 0,
            0, 0, 0, 0,
            0, 0, 0, 0,
        ];

        let err = run_proof(&input).expect_err("expected invalid board layout to fail");
        assert!(
            err.contains("invalid board layout P1"),
            "unexpected error message: {err}"
        );
    }


    #[test]
    fn moves_after_game_over_are_rejected() {
        let mut input = default_game_input(779);
        // P1 wins in 7 moves in default sample; add an extra move after game over.
        input.moves.push(Move { player: 2, x: 2, y: 2 });

        let err = run_proof(&input).expect_err("expected moves-after-game-over to fail");
        assert!(
            err.contains("moves after game over are not allowed"),
            "unexpected error message: {err}"
        );
    }

    #[test]
    fn invalid_turn_order_is_rejected() {
        let mut input = default_game_input(780);
        input.moves = vec![
            Move { player: 1, x: 0, y: 0 },
            Move { player: 1, x: 1, y: 0 }, // invalid: player 1 twice
        ];

        let err = run_proof(&input).expect_err("expected invalid turn order to fail");
        assert!(
            err.contains("invalid turn order"),
            "unexpected error message: {err}"
        );
    }
}
