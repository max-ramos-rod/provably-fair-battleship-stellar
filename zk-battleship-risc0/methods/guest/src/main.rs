use risc0_zkvm::guest::env;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

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

#[derive(Debug, Serialize)]
struct PublicOutput {
    session_id: u32,
    winner: u8,
    board_hash_p1: [u8; 32],
    board_hash_p2: [u8; 32],
    total_moves: u32,
}

fn board_hash(board: &[u8; 16]) -> [u8; 32] {
    let mut hasher = Sha256::new();
    hasher.update(board);
    hasher.finalize().into()
}

fn count_ships(board: &[u8; 16]) -> u8 {
    let mut ships = 0u8;
    for &cell in board {
        if cell > 1 {
            panic!("invalid board cell value");
        }
        if cell == 1 {
            ships += 1;
        }
    }
    ships
}

fn has_two_size_two_ships(board: &[u8; 16]) -> bool {
    let mut visited = [false; 16];
    let mut components = [0u8; 4];
    let mut component_count = 0usize;

    for idx in 0..16 {
        if board[idx] != 1 || visited[idx] {
            continue;
        }

        if component_count >= components.len() {
            return false;
        }

        let mut stack = [0usize; 16];
        let mut stack_len = 0usize;
        stack[stack_len] = idx;
        stack_len += 1;
        visited[idx] = true;

        let mut size = 0u8;

        while stack_len > 0 {
            stack_len -= 1;
            let current = stack[stack_len];
            size += 1;

            let x = (current % 4) as i8;
            let y = (current / 4) as i8;
            let neighbors = [(x + 1, y), (x - 1, y), (x, y + 1), (x, y - 1)];

            for (nx, ny) in neighbors {
                if nx < 0 || ny < 0 || nx >= 4 || ny >= 4 {
                    continue;
                }

                let nidx = (ny as usize) * 4 + (nx as usize);
                if board[nidx] == 1 && !visited[nidx] {
                    visited[nidx] = true;
                    stack[stack_len] = nidx;
                    stack_len += 1;
                }
            }
        }

        components[component_count] = size;
        component_count += 1;
    }

    if component_count != 2 {
        return false;
    }

    components[0] == 2 && components[1] == 2
}

fn index(x: u8, y: u8) -> usize {
    (y as usize) * 4 + (x as usize)
}

fn main() {
    let input: GameInput = env::read();

    if count_ships(&input.board_p1) != 4 {
        panic!("invalid board P1");
    }
    if count_ships(&input.board_p2) != 4 {
        panic!("invalid board P2");
    }
    if !has_two_size_two_ships(&input.board_p1) {
        panic!("invalid board layout P1");
    }
    if !has_two_size_two_ships(&input.board_p2) {
        panic!("invalid board layout P2");
    }

    let mut hits_p1 = 0u8;
    let mut hits_p2 = 0u8;
    let mut expected_player = 1u8;
    let mut processed_moves = 0u32;

    let mut shots_by_p1 = [false; 16];
    let mut shots_by_p2 = [false; 16];
    let mut game_over = false;

    for mv in &input.moves {
        if game_over {
            panic!("moves after game over are not allowed");
        }

        if mv.player != expected_player {
            panic!("invalid turn order");
        }

        if mv.x >= 4 || mv.y >= 4 {
            panic!("invalid move position");
        }

        let idx = index(mv.x, mv.y);

        if mv.player == 1 {
            if shots_by_p1[idx] {
                panic!("duplicate shot by player 1");
            }
            shots_by_p1[idx] = true;

            if input.board_p2[idx] == 1 {
                hits_p1 += 1;
            }
            expected_player = 2;
        } else {
            if shots_by_p2[idx] {
                panic!("duplicate shot by player 2");
            }
            shots_by_p2[idx] = true;

            if input.board_p1[idx] == 1 {
                hits_p2 += 1;
            }
            expected_player = 1;
        }

        processed_moves += 1;

        if hits_p1 == 4 || hits_p2 == 4 {
            game_over = true;
        }
    }

    let winner = if hits_p1 == 4 {
        1
    } else if hits_p2 == 4 {
        2
    } else {
        0
    };

    let output = PublicOutput {
        session_id: input.session_id,
        winner,
        board_hash_p1: board_hash(&input.board_p1),
        board_hash_p2: board_hash(&input.board_p2),
        total_moves: processed_moves,
    };

    env::commit(&output);
}
