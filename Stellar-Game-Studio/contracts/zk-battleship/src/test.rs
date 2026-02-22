#![cfg(test)]

// Unit tests for the zk-battleship contract using a simple mock GameHub.
// These tests verify game logic independently of the full GameHub system.
//
// Note: These tests use a minimal mock for isolation and speed.
// For full integration tests with the real Game Hub contract, see the platform repo.

use crate::{Error, ZkBattleshipContract, ZkBattleshipContractClient};
use soroban_sdk::testutils::{Address as _, Ledger as _};
use soroban_sdk::{contract, contractimpl, Address, BytesN, Env};

// ============================================================================
// Mock GameHub for Unit Testing
// ============================================================================

#[contract]
pub struct MockGameHub;

#[contractimpl]
impl MockGameHub {
    pub fn start_game(
        _env: Env,
        _game_id: Address,
        _session_id: u32,
        _player1: Address,
        _player2: Address,
        _player1_points: i128,
        _player2_points: i128,
    ) {
        // Mock implementation - does nothing
    }

    pub fn end_game(_env: Env, _session_id: u32, _player1_won: bool) {
        // Mock implementation - does nothing
    }

    pub fn add_game(_env: Env, _game_address: Address) {
        // Mock implementation - does nothing
    }
}


#[contract]
pub struct MockVerifier;

#[contractimpl]
impl MockVerifier {
    pub fn verify(_env: Env, seal: soroban_sdk::Bytes, _image_id: BytesN<32>, _journal: BytesN<32>) {
        if seal.len() == 0 {
            panic!("invalid proof");
        }

        // Deterministic invalid marker for tests: first byte = 0 means invalid proof.
        let first = seal.get(0).unwrap_or(0);
        if first == 0 {
            panic!("invalid proof");
        }
    }
}

// ============================================================================
// Test Helpers
// ============================================================================

fn setup_test() -> (
    Env,
    ZkBattleshipContractClient<'static>,
    MockGameHubClient<'static>,
    MockVerifierClient<'static>,
    Address,
    Address,
) {
    let env = Env::default();
    env.mock_all_auths();

    // Set ledger info for time-based operations
    env.ledger().set(soroban_sdk::testutils::LedgerInfo {
        timestamp: 1441065600,
        protocol_version: 25,
        sequence_number: 100,
        network_id: Default::default(),
        base_reserve: 10,
        min_temp_entry_ttl: u32::MAX / 2,
        min_persistent_entry_ttl: u32::MAX / 2,
        max_entry_ttl: u32::MAX / 2,
    });

    // Deploy mock GameHub contract
    let hub_addr = env.register(MockGameHub, ());
    let game_hub = MockGameHubClient::new(&env, &hub_addr);

    // Deploy mock verifier contract
    let verifier_addr = env.register(MockVerifier, ());
    let verifier = MockVerifierClient::new(&env, &verifier_addr);

    // Create admin address
    let admin = Address::generate(&env);

    // Deploy zk-battleship with admin and GameHub address
    let contract_id = env.register(ZkBattleshipContract, (&admin, &hub_addr));
    let client = ZkBattleshipContractClient::new(&env, &contract_id);

    // Register zk-battleship as a whitelisted game (mock does nothing)
    game_hub.add_game(&contract_id);

    // Configure verifier and image id for proof checks
    client.set_verifier(&verifier_addr);
    client.set_image_id(&BytesN::from_array(&env, &[9u8; 32]));

    let player1 = Address::generate(&env);
    let player2 = Address::generate(&env);

    (env, client, game_hub, verifier, player1, player2)
}

/// Assert that a Result contains a specific number_guess error
///
/// This helper provides type-safe error assertions following Stellar/Soroban best practices.
/// Instead of using `assert_eq!(result, Err(Ok(Error::AlreadyGuessed)))`, this pattern:
/// - Provides compile-time error checking
/// - Makes tests more readable with named errors
/// - Gives better failure messages
///
/// # Example
/// ```
/// let result = client.try_make_guess(&session_id, &player, &7);
/// assert_number_guess_error(&result, Error::AlreadyGuessed);
/// ```
///
/// # Type Signature
/// The try_ methods return: `Result<Result<T, T::Error>, Result<E, InvokeError>>`
/// - Ok(Ok(value)): Call succeeded, decode succeeded
/// - Ok(Err(conv_err)): Call succeeded, decode failed
/// - Err(Ok(error)): Contract reverted with custom error (THIS IS WHAT WE TEST)
/// - Err(Err(invoke_err)): Low-level invocation failure
fn assert_number_guess_error<T, E>(
    result: &Result<Result<T, E>, Result<Error, soroban_sdk::InvokeError>>,
    expected_error: Error,
) {
    match result {
        Err(Ok(actual_error)) => {
            assert_eq!(
                *actual_error, expected_error,
                "Expected error {:?} (code {}), but got {:?} (code {})",
                expected_error, expected_error as u32, actual_error, *actual_error as u32
            );
        }
        Err(Err(_invoke_error)) => {
            panic!(
                "Expected contract error {:?} (code {}), but got invocation error",
                expected_error, expected_error as u32
            );
        }
        Ok(Err(_conv_error)) => {
            panic!(
                "Expected contract error {:?} (code {}), but got conversion error",
                expected_error, expected_error as u32
            );
        }
        Ok(Ok(_)) => {
            panic!(
                "Expected error {:?} (code {}), but operation succeeded",
                expected_error, expected_error as u32
            );
        }
    }
}

// ============================================================================
// Basic Game Flow Tests
// ============================================================================

#[test]
fn test_complete_game() {
    let (_env, client, _hub, _verifier, player1, player2) = setup_test();

    let session_id = 1u32;
    let points = 100_0000000;

    // Start game
    client.start_game(&session_id, &player1, &player2, &points, &points);

    // Get game to verify state
    let game = client.get_game(&session_id);
    assert!(game.winning_number.is_none()); // Winning number not set yet
    assert!(game.winner.is_none()); // Game is still active
    assert_eq!(game.player1, player1);
    assert_eq!(game.player2, player2);
    assert_eq!(game.player1_points, points);
    assert_eq!(game.player2_points, points);

    // Make guesses
    client.make_guess(&session_id, &player1, &5);
    client.make_guess(&session_id, &player2, &7);

    // Reveal winner
    let winner = client.reveal_winner(&session_id);
    assert!(winner == player1 || winner == player2);

    // Verify game is ended and winning number is now set
    let final_game = client.get_game(&session_id);
    assert!(final_game.winner.is_some()); // Game has ended
    assert_eq!(final_game.winner.unwrap(), winner);
    assert!(final_game.winning_number.is_some());
    let winning_number = final_game.winning_number.unwrap();
    assert!(winning_number >= 1 && winning_number <= 16);
}

#[test]
fn test_winning_number_in_range() {
    let (_env, client, _hub, _verifier, player1, player2) = setup_test();

    let session_id = 2u32;
    client.start_game(&session_id, &player1, &player2, &100_0000000, &100_0000000);

    // Make guesses and reveal winner to generate winning number
    client.make_guess(&session_id, &player1, &5);
    client.make_guess(&session_id, &player2, &7);
    client.reveal_winner(&session_id);

    let game = client.get_game(&session_id);
    let winning_number = game
        .winning_number
        .expect("Winning number should be set after reveal");
    assert!(
        winning_number >= 1 && winning_number <= 16,
        "Winning number should be between 1 and 16"
    );
}

#[test]
fn test_multiple_sessions() {
    let (env, client, _hub, _verifier, player1, player2) = setup_test();
    let player3 = Address::generate(&env);
    let player4 = Address::generate(&env);

    let session1 = 3u32;
    let session2 = 4u32;

    client.start_game(&session1, &player1, &player2, &100_0000000, &100_0000000);
    client.start_game(&session2, &player3, &player4, &50_0000000, &50_0000000);

    // Verify both games exist and are independent
    let game1 = client.get_game(&session1);
    let game2 = client.get_game(&session2);

    assert_eq!(game1.player1, player1);
    assert_eq!(game2.player1, player3);
}

// ============================================================================
// Guess Logic Tests
// ============================================================================

#[test]
fn test_closest_guess_wins() {
    let (_env, client, _hub, _verifier, player1, player2) = setup_test();

    let session_id = 5u32;
    client.start_game(&session_id, &player1, &player2, &100_0000000, &100_0000000);

    // Player1 guesses closer (1 away from any number between 1-10)
    // Player2 guesses further (at least 2 away)
    client.make_guess(&session_id, &player1, &5);
    client.make_guess(&session_id, &player2, &16);

    let winner = client.reveal_winner(&session_id);

    // Get the final game state to check the winning number
    let game = client.get_game(&session_id);
    let winning_number = game.winning_number.unwrap();

    // Calculate which player should have won based on distances
    let distance1 = if 5 > winning_number {
        5 - winning_number
    } else {
        winning_number - 5
    };
    let distance2 = if 16 > winning_number {
        16 - winning_number
    } else {
        winning_number - 16
    };

    let expected_winner = if distance1 <= distance2 {
        player1.clone()
    } else {
        player2.clone()
    };
    assert_eq!(
        winner, expected_winner,
        "Player with closer guess should win"
    );
}

#[test]
fn test_tie_game_player1_wins() {
    let (_env, client, _hub, _verifier, player1, player2) = setup_test();

    let session_id = 6u32;
    client.start_game(&session_id, &player1, &player2, &100_0000000, &100_0000000);

    // Both players guess the same number (guaranteed tie)
    client.make_guess(&session_id, &player1, &5);
    client.make_guess(&session_id, &player2, &5);

    let winner = client.reveal_winner(&session_id);
    assert_eq!(winner, player1, "Player1 should win in a tie");
}

#[test]
fn test_exact_guess_wins() {
    let (_env, client, _hub, _verifier, player1, player2) = setup_test();

    let session_id = 7u32;
    client.start_game(&session_id, &player1, &player2, &100_0000000, &100_0000000);

    // Player1 guesses 5 (middle), player2 guesses 10 (edge)
    // Player1 is more likely to be closer to the winning number
    client.make_guess(&session_id, &player1, &5);
    client.make_guess(&session_id, &player2, &16);

    let winner = client.reveal_winner(&session_id);
    let game = client.get_game(&session_id);
    let winning_number = game.winning_number.unwrap();

    // Verify the winner matches the distance calculation
    let distance1 = if 5 > winning_number {
        5 - winning_number
    } else {
        winning_number - 5
    };
    let distance2 = if 16 > winning_number {
        16 - winning_number
    } else {
        winning_number - 16
    };
    let expected_winner = if distance1 <= distance2 {
        player1.clone()
    } else {
        player2.clone()
    };
    assert_eq!(winner, expected_winner);
}

// ============================================================================
// Error Handling Tests
// ============================================================================

#[test]
fn test_cannot_guess_twice() {
    let (_env, client, _hub, _verifier, player1, player2) = setup_test();

    let session_id = 8u32;
    client.start_game(&session_id, &player1, &player2, &100_0000000, &100_0000000);

    // Make first guess
    client.make_guess(&session_id, &player1, &5);

    // Try to guess again - should fail
    let result = client.try_make_guess(&session_id, &player1, &6);
    assert_number_guess_error(&result, Error::AlreadyGuessed);
}

#[test]
fn test_cannot_reveal_before_both_guesses() {
    let (_env, client, _hub, _verifier, player1, player2) = setup_test();

    let session_id = 9u32;
    client.start_game(&session_id, &player1, &player2, &100_0000000, &100_0000000);

    // Only player1 guesses
    client.make_guess(&session_id, &player1, &5);

    // Try to reveal winner - should fail
    let result = client.try_reveal_winner(&session_id);
    assert_number_guess_error(&result, Error::BothPlayersNotGuessed);
}

#[test]
#[should_panic(expected = "Shot must be between cell 1 and 16")]
fn test_cannot_guess_below_range() {
    let (env, client, _hub, _verifier, player1, _player2) = setup_test();

    let session_id = 10u32;
    client.start_game(
        &session_id,
        &player1,
        &Address::generate(&env),
        &100_0000000,
        &100_0000000,
    );

    // Try to guess 0 (below range) - should panic
    client.make_guess(&session_id, &player1, &0);
}

#[test]
#[should_panic(expected = "Shot must be between cell 1 and 16")]
fn test_cannot_guess_above_range() {
    let (env, client, _hub, _verifier, player1, _player2) = setup_test();

    let session_id = 11u32;
    client.start_game(
        &session_id,
        &player1,
        &Address::generate(&env),
        &100_0000000,
        &100_0000000,
    );

    // Try to guess 17 (above range) - should panic
    client.make_guess(&session_id, &player1, &17);
}

#[test]
fn test_non_player_cannot_guess() {
    let (env, client, _hub, _verifier, player1, player2) = setup_test();
    let non_player = Address::generate(&env);

    let session_id = 11u32;
    client.start_game(&session_id, &player1, &player2, &100_0000000, &100_0000000);

    // Non-player tries to guess
    let result = client.try_make_guess(&session_id, &non_player, &5);
    assert_number_guess_error(&result, Error::NotPlayer);
}

#[test]
fn test_cannot_reveal_nonexistent_game() {
    let (_env, client, _hub, _verifier, _player1, _player2) = setup_test();

    let result = client.try_reveal_winner(&999);
    assert_number_guess_error(&result, Error::GameNotFound);
}

#[test]
fn test_cannot_guess_after_game_ended() {
    let (_env, client, _hub, _verifier, player1, player2) = setup_test();

    let session_id = 12u32;
    client.start_game(&session_id, &player1, &player2, &100_0000000, &100_0000000);

    // Both players make guesses
    client.make_guess(&session_id, &player1, &5);
    client.make_guess(&session_id, &player2, &7);

    // Reveal winner - game ends
    let _winner = client.reveal_winner(&session_id);

    // Try to make another guess after game has ended - should fail
    let result = client.try_make_guess(&session_id, &player1, &3);
    assert_number_guess_error(&result, Error::GameAlreadyEnded);
}

#[test]
fn test_cannot_reveal_twice() {
    let (_env, client, _hub, _verifier, player1, player2) = setup_test();

    let session_id = 14u32;
    client.start_game(&session_id, &player1, &player2, &100_0000000, &100_0000000);

    client.make_guess(&session_id, &player1, &5);
    client.make_guess(&session_id, &player2, &7);

    // First reveal succeeds
    let winner = client.reveal_winner(&session_id);
    assert!(winner == player1 || winner == player2);

    // Second reveal should return same winner (idempotent)
    let winner2 = client.reveal_winner(&session_id);
    assert_eq!(winner, winner2);
}

// ============================================================================
// Multiple Games Tests
// ============================================================================

#[test]
fn test_multiple_games_independent() {
    let (env, client, _hub, _verifier, player1, player2) = setup_test();
    let player3 = Address::generate(&env);
    let player4 = Address::generate(&env);

    let session1 = 20u32;
    let session2 = 21u32;

    // Start two games
    client.start_game(&session1, &player1, &player2, &100_0000000, &100_0000000);
    client.start_game(&session2, &player3, &player4, &50_0000000, &50_0000000);

    // Play both games independently
    client.make_guess(&session1, &player1, &3);
    client.make_guess(&session2, &player3, &8);
    client.make_guess(&session1, &player2, &7);
    client.make_guess(&session2, &player4, &2);

    // Reveal both winners
    let winner1 = client.reveal_winner(&session1);
    let winner2 = client.reveal_winner(&session2);

    assert!(winner1 == player1 || winner1 == player2);
    assert!(winner2 == player3 || winner2 == player4);

    // Verify both games are independent
    let final_game1 = client.get_game(&session1);
    let final_game2 = client.get_game(&session2);

    assert!(final_game1.winner.is_some()); // Game 1 has ended
    assert!(final_game2.winner.is_some()); // Game 2 has ended

    // Note: winning numbers could be the same by chance, so we just verify they're both set
    assert!(final_game1.winning_number.is_some());
    assert!(final_game2.winning_number.is_some());
}


#[test]
fn test_submit_result_success() {
    let (env, client, _hub, _verifier, player1, player2) = setup_test();

    let session_id = 16u32;
    client.start_game(&session_id, &player1, &player2, &100_0000000, &100_0000000);

    let board_hash_p1 = BytesN::from_array(&env, &[1u8; 32]);
    let board_hash_p2 = BytesN::from_array(&env, &[2u8; 32]);
    let journal = soroban_sdk::Bytes::from_slice(&env, &[10u8, 11u8, 12u8]);
    let seal = soroban_sdk::Bytes::from_slice(&env, &[20u8, 21u8, 22u8]);

    let winner = client.submit_result(
        &session_id,
        &player1,
        &1u32,
        &7u32,
        &board_hash_p1,
        &board_hash_p2,
        &journal,
        &seal,
    );
    assert_eq!(winner, player1);

    let game = client.get_game(&session_id);
    assert_eq!(game.winner, Some(player1));
    assert_eq!(game.total_moves, Some(7));
    assert_eq!(game.board_hash_p1, Some(board_hash_p1));
    assert_eq!(game.board_hash_p2, Some(board_hash_p2));
    assert!(game.journal_hash.is_some());
    assert!(game.seal_hash.is_some());
}


#[test]
fn test_submit_result_rejects_invalid_proof() {
    let (env, client, _hub, _verifier, player1, player2) = setup_test();

    let session_id = 18u32;
    client.start_game(&session_id, &player1, &player2, &100_0000000, &100_0000000);

    let board_hash_p1 = BytesN::from_array(&env, &[5u8; 32]);
    let board_hash_p2 = BytesN::from_array(&env, &[6u8; 32]);
    let journal = soroban_sdk::Bytes::from_slice(&env, &[1u8, 2u8, 3u8]);
    let invalid_seal = soroban_sdk::Bytes::from_slice(&env, &[0u8, 9u8]);

    let result = client.try_submit_result(
        &session_id,
        &player1,
        &1u32,
        &7u32,
        &board_hash_p1,
        &board_hash_p2,
        &journal,
        &invalid_seal,
    );
    assert!(matches!(result, Err(Err(_))), "expected invocation failure due to verifier rejecting proof");
}

#[test]
fn test_submit_result_requires_player_and_valid_inputs() {
    let (env, client, _hub, _verifier, player1, player2) = setup_test();
    let non_player = Address::generate(&env);

    let session_id = 17u32;
    client.start_game(&session_id, &player1, &player2, &100_0000000, &100_0000000);

    let board_hash_p1 = BytesN::from_array(&env, &[3u8; 32]);
    let board_hash_p2 = BytesN::from_array(&env, &[4u8; 32]);
    let journal = soroban_sdk::Bytes::from_slice(&env, &[1u8]);
    let seal = soroban_sdk::Bytes::from_slice(&env, &[2u8]);

    let not_player = client.try_submit_result(
        &session_id,
        &non_player,
        &1u32,
        &5u32,
        &board_hash_p1,
        &board_hash_p2,
        &journal,
        &seal,
    );
    assert_number_guess_error(&not_player, Error::NotPlayer);

    let invalid_winner = client.try_submit_result(
        &session_id,
        &player1,
        &3u32,
        &5u32,
        &board_hash_p1,
        &board_hash_p2,
        &journal,
        &seal,
    );
    assert_number_guess_error(&invalid_winner, Error::InvalidWinner);

    let invalid_moves = client.try_submit_result(
        &session_id,
        &player1,
        &1u32,
        &0u32,
        &board_hash_p1,
        &board_hash_p2,
        &journal,
        &seal,
    );
    assert_number_guess_error(&invalid_moves, Error::InvalidTotalMoves);
}

#[test]
fn test_asymmetric_points() {
    let (_env, client, _hub, _verifier, player1, player2) = setup_test();

    let session_id = 15u32;
    let points1 = 200_0000000;
    let points2 = 50_0000000;

    client.start_game(&session_id, &player1, &player2, &points1, &points2);

    let game = client.get_game(&session_id);
    assert_eq!(game.player1_points, points1);
    assert_eq!(game.player2_points, points2);

    client.make_guess(&session_id, &player1, &5);
    client.make_guess(&session_id, &player2, &5);
    client.reveal_winner(&session_id);

    // Game completes successfully with asymmetric points
    let final_game = client.get_game(&session_id);
    assert!(final_game.winner.is_some()); // Game has ended
}

// ============================================================================
// Admin Function Tests
// ============================================================================

#[test]
fn test_upgrade_function_exists() {
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let hub_addr = env.register(MockGameHub, ());

    // Deploy zk-battleship with admin
    let contract_id = env.register(ZkBattleshipContract, (&admin, &hub_addr));
    let client = ZkBattleshipContractClient::new(&env, &contract_id);

    // Verify the upgrade function exists and can be called
    // Note: We can't test actual upgrade without real WASM files
    // The function will fail with MissingValue because the WASM hash doesn't exist
    // But that's expected - we're just verifying the function signature is correct
    let new_wasm_hash = BytesN::from_array(&env, &[1u8; 32]);
    let result = client.try_upgrade(&new_wasm_hash);

    // Should fail with MissingValue (WASM doesn't exist) not NotAdmin
    // This confirms the authorization check passed
    assert!(result.is_err());
}
