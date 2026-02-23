import { useState, useEffect, useRef } from 'react';
import { ZkBattleshipService, type ZkProofPayload } from './zkBattleshipService';
import { requestCache, createCacheKey } from '@/utils/requestCache';
import { useWallet } from '@/hooks/useWallet';
import { ZK_BATTLESHIP_CONTRACT } from '@/utils/constants';
import { getFundedSimulationSourceAddress } from '@/utils/simulationUtils';
import { devWalletService, DevWalletService } from '@/services/devWalletService';
import type { Game } from './bindings';

const createRandomSessionId = (): number => {
  if (typeof crypto !== 'undefined' && crypto.getRandomValues) {
    let value = 0;
    const buffer = new Uint32Array(1);
    while (value === 0) {
      crypto.getRandomValues(buffer);
      value = buffer[0];
    }
    return value;
  }

  return (Math.floor(Math.random() * 0xffffffff) >>> 0) || 1;
};

const toHex = (value: unknown): string | null => {
  if (value === null || value === undefined) return null;

  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase().replace(/^0x/, '');
    return /^[0-9a-f]+$/.test(normalized) ? normalized : null;
  }

  const maybeToString = value as { toString?: (encoding?: string) => string };
  if (typeof maybeToString.toString === 'function') {
    const text = maybeToString.toString('hex').trim().toLowerCase();
    if (/^[0-9a-f]+$/.test(text)) return text;
  }

  let bytes: Uint8Array | null = null;
  if (value instanceof Uint8Array) {
    bytes = value;
  } else if (Array.isArray(value) && value.every((item) => Number.isInteger(item) && item >= 0 && item <= 255)) {
    bytes = Uint8Array.from(value as number[]);
  }

  if (!bytes) return null;
  return Array.from(bytes).map((byte) => byte.toString(16).padStart(2, '0')).join('');
};

const shortText = (value: string | null | undefined, keep = 8): string => {
  if (!value) return '—';
  if (value.length <= keep * 2) return value;
  return `${value.slice(0, keep)}...${value.slice(-keep)}`;
};

// Create service instance with the contract ID
const zkBattleshipService = new ZkBattleshipService(ZK_BATTLESHIP_CONTRACT);

type LocalMove = {
  player: 1 | 2;
  cell: number;
  x: number;
  y: number;
};

interface ZkBattleshipGameProps {
  userAddress: string;
  currentEpoch: number;
  availablePoints: bigint;
  initialXDR?: string | null;
  initialSessionId?: number | null;
  onStandingsRefresh: () => void;
  onGameComplete: () => void;
}

export function ZkBattleshipGame({
  userAddress,
  availablePoints,
  initialXDR,
  initialSessionId,
  onStandingsRefresh,
  onGameComplete
}: ZkBattleshipGameProps) {
  const DEFAULT_POINTS = '0.1';
  const { getContractSigner, walletType } = useWallet();
  // Use a random session ID that fits in u32 (avoid 0 because UI validation treats <=0 as invalid)
  const [sessionId, setSessionId] = useState<number>(() => createRandomSessionId());
  const [player1Address, setPlayer1Address] = useState(userAddress);
  const [player1Points, setPlayer1Points] = useState(DEFAULT_POINTS);
  const [shotCell, setShotCell] = useState<number | null>(null);
  const [gameState, setGameState] = useState<Game | null>(null);
  const [loading, setLoading] = useState(false);
  const [quickstartLoading, setQuickstartLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [gamePhase, setGamePhase] = useState<'create' | 'shot' | 'reveal' | 'complete'>('create');
  const [createMode, setCreateMode] = useState<'create' | 'import' | 'load'>('create');
  const [exportedAuthEntryXDR, setExportedAuthEntryXDR] = useState<string | null>(null);
  const [importAuthEntryXDR, setImportAuthEntryXDR] = useState('');
  const [importSessionId, setImportSessionId] = useState('');
  const [importPlayer1, setImportPlayer1] = useState('');
  const [importPlayer1Points, setImportPlayer1Points] = useState('');
  const [importPlayer2Points, setImportPlayer2Points] = useState(DEFAULT_POINTS);
  const [loadSessionId, setLoadSessionId] = useState('');
  const [authEntryCopied, setAuthEntryCopied] = useState(false);
  const [shareUrlCopied, setShareUrlCopied] = useState(false);
  const [xdrParsing, setXdrParsing] = useState(false);
  const [xdrParseError, setXdrParseError] = useState<string | null>(null);
  const [xdrParseSuccess, setXdrParseSuccess] = useState(false);
  const [proofOutputJson, setProofOutputJson] = useState('');
  const [gameInputJson, setGameInputJson] = useState('');
  const [moves, setMoves] = useState<LocalMove[]>([]);
  const [currentTurn, setCurrentTurn] = useState<1 | 2>(1);
  const [hitsP1, setHitsP1] = useState(0);
  const [hitsP2, setHitsP2] = useState(0);
  const [localWinner, setLocalWinner] = useState<0 | 1 | 2>(0);
  const [boardP1Cells, setBoardP1Cells] = useState<number[]>([]);
  const [boardP2Cells, setBoardP2Cells] = useState<number[]>([]);
  const [boardP1Locked, setBoardP1Locked] = useState(false);
  const [boardP2Locked, setBoardP2Locked] = useState(false);
  const [submittedProof, setSubmittedProof] = useState<ZkProofPayload | null>(null);
  const [settlementTxHash, setSettlementTxHash] = useState<string | null>(null);
  const [verifierContract, setVerifierContract] = useState<string | null>(null);
  const [imageIdHex, setImageIdHex] = useState<string | null>(null);

  useEffect(() => {
    setPlayer1Address(userAddress);
  }, [userAddress]);

  useEffect(() => {
    if (createMode === 'import' && !importPlayer2Points.trim()) {
      setImportPlayer2Points(DEFAULT_POINTS);
    }
  }, [createMode, importPlayer2Points]);

  useEffect(() => {
    setMoves([]);
    setCurrentTurn(1);
    setHitsP1(0);
    setHitsP2(0);
    setLocalWinner(0);
    setBoardP1Cells([]);
    setBoardP2Cells([]);
    setBoardP1Locked(false);
    setBoardP2Locked(false);
    setShotCell(null);
    setSubmittedProof(null);
    setSettlementTxHash(null);
    setVerifierContract(null);
    setImageIdHex(null);
  }, [sessionId]);


  const POINTS_DECIMALS = 7;
  const isBusy = loading || quickstartLoading;
  const actionLock = useRef(false);
  const quickstartAvailable = walletType === 'dev'
    && DevWalletService.isDevModeAvailable()
    && DevWalletService.isPlayerAvailable(1)
    && DevWalletService.isPlayerAvailable(2);

  const runAction = async (action: () => Promise<void>) => {
    if (actionLock.current || isBusy) {
      return;
    }
    actionLock.current = true;
    try {
      await action();
    } finally {
      actionLock.current = false;
    }
  };

  const handleStartNewGame = () => {
    if (gameState?.winner) {
      onGameComplete();
    }

    actionLock.current = false;
    setGamePhase('create');
    setSessionId(createRandomSessionId());
    setGameState(null);
    setShotCell(null);
    setLoading(false);
    setQuickstartLoading(false);
    setError(null);
    setSuccess(null);
    setCreateMode('create');
    setExportedAuthEntryXDR(null);
    setImportAuthEntryXDR('');
    setImportSessionId('');
    setImportPlayer1('');
    setImportPlayer1Points('');
    setImportPlayer2Points(DEFAULT_POINTS);
    setLoadSessionId('');
    setAuthEntryCopied(false);
    setShareUrlCopied(false);
    setXdrParsing(false);
    setXdrParseError(null);
    setXdrParseSuccess(false);
    setProofOutputJson('');
    setGameInputJson('');
    setMoves([]);
    setCurrentTurn(1);
    setHitsP1(0);
    setHitsP2(0);
    setLocalWinner(0);
    setBoardP1Cells([]);
    setBoardP2Cells([]);
    setBoardP1Locked(false);
    setBoardP2Locked(false);
    setSubmittedProof(null);
    setSettlementTxHash(null);
    setVerifierContract(null);
    setImageIdHex(null);
    setPlayer1Address(userAddress);
    setPlayer1Points(DEFAULT_POINTS);
  };

  const parsePoints = (value: string): bigint | null => {
    try {
      const cleaned = value.replace(/[^\d.]/g, '');
      if (!cleaned || cleaned === '.') return null;

      const [whole = '0', fraction = ''] = cleaned.split('.');
      const paddedFraction = fraction.padEnd(POINTS_DECIMALS, '0').slice(0, POINTS_DECIMALS);
      return BigInt(whole + paddedFraction);
    } catch {
      return null;
    }
  };

  const parseProofPayload = (input: string): ZkProofPayload => {
    let parsed: any;

    try {
      parsed = JSON.parse(input);
    } catch {
      throw new Error('Invalid JSON format in proof-output payload');
    }

    const publicOutput = parsed.public_output ?? parsed.publicOutput ?? parsed;

    const winnerValue = publicOutput.winner;
    const totalMovesValue = publicOutput.total_moves ?? publicOutput.totalMoves;
    const proofSessionId = publicOutput.session_id ?? publicOutput.sessionId;
    const boardHashP1 = publicOutput.board_hash_p1 ?? publicOutput.boardHashP1Hex;
    const boardHashP2 = publicOutput.board_hash_p2 ?? publicOutput.boardHashP2Hex;
    const journalHex = parsed.journal_hex ?? parsed.journalHex;
    const sealHex = parsed.seal_hex ?? parsed.sealHex;

    if (proofSessionId !== undefined && Number(proofSessionId) !== sessionId) {
      throw new Error(`Proof session_id (${proofSessionId}) does not match current session (${sessionId})`);
    }

    if (winnerValue !== 1 && winnerValue !== 2) {
      throw new Error('Proof winner must be 1 or 2');
    }

    const totalMoves = Number(totalMovesValue);
    if (!Number.isFinite(totalMoves) || totalMoves <= 0) {
      throw new Error('Proof total_moves must be a positive number');
    }

    if (typeof boardHashP1 !== 'string' || typeof boardHashP2 !== 'string' || typeof journalHex !== 'string' || typeof sealHex !== 'string') {
      throw new Error('Missing required proof fields (board hashes, journal, or seal)');
    }

    return {
      winner: winnerValue,
      totalMoves,
      boardHashP1Hex: boardHashP1,
      boardHashP2Hex: boardHashP2,
      journalHex,
      sealHex,
    };
  };

  const loadGameState = async () => {
    try {
      // Always fetch latest game state to avoid stale cached results after transactions.
      const game = await zkBattleshipService.getGame(sessionId);
      setGameState(game);

      // Determine game phase based on state
      if (game && game.winner !== null && game.winner !== undefined) {
        setGamePhase('complete');
      } else if (localWinner !== 0) {
        setGamePhase('reveal');
      } else {
        setGamePhase('shot');
      }
    } catch (err) {
      // Game doesn't exist yet
      setGameState(null);
    }
  };

  useEffect(() => {
    if (gamePhase !== 'create') {
      loadGameState();
      const interval = setInterval(loadGameState, 5000); // Poll every 5 seconds
      return () => clearInterval(interval);
    }
  }, [sessionId, gamePhase, localWinner]);

  useEffect(() => {
    if (gamePhase !== 'complete') return;

    let active = true;
    (async () => {
      const [verifier, imageId] = await Promise.all([
        zkBattleshipService.getVerifier(),
        zkBattleshipService.getImageId(),
      ]);
      if (!active) return;
      setVerifierContract(verifier);
      setImageIdHex(imageId);
    })();

    return () => {
      active = false;
    };
  }, [gamePhase, sessionId]);

  // Auto-refresh standings when game completes (for passive player who didn't call reveal_winner)
  useEffect(() => {
    if (gamePhase === 'complete' && gameState?.winner) {
      console.log('Game completed! Refreshing standings and dashboard data...');
      onStandingsRefresh(); // Refresh standings and available points; don't call onGameComplete() here or it will close the game!
    }
  }, [gamePhase, gameState?.winner]);

  // Handle initial values from URL deep linking or props
  // Expected URL formats:
  //   - With auth entry: ?game=zk-battleship&auth=AAAA... (Session ID, P1 address, P1 points parsed from auth entry)
  //   - With session ID: ?game=zk-battleship&session-id=123 (Load existing game)
  // Note: GamesCatalog cleans URL params, so we prioritize props over URL
  useEffect(() => {
    // Priority 1: Check initialXDR prop (from GamesCatalog after URL cleanup)
    if (initialXDR) {
      console.log('[Deep Link] Using initialXDR prop from GamesCatalog');

      try {
        const parsed = zkBattleshipService.parseAuthEntry(initialXDR);
        const sessionId = parsed.sessionId;

        console.log('[Deep Link] Parsed session ID from initialXDR:', sessionId);

        // Check if game already exists (both players have signed)
        zkBattleshipService.getGame(sessionId)
          .then((game) => {
            if (game) {
              // Game exists! Load it directly instead of going to import mode
              console.log('[Deep Link] Game already exists, loading directly to shot phase');
              console.log('[Deep Link] Game data:', game);

              // Auto-load the game - bypass create phase entirely
              setGameState(game);
              setGamePhase('shot');
              setSessionId(sessionId); // Set session ID for the game
            } else {
              // Game doesn't exist yet, go to import mode
              console.log('[Deep Link] Game not found, entering import mode');
              setCreateMode('import');
              setImportAuthEntryXDR(initialXDR);
              setImportSessionId(sessionId.toString());
              setImportPlayer1(parsed.player1);
              setImportPlayer1Points((Number(parsed.player1Points) / 10_000_000).toString());
              setImportPlayer2Points('0.1');
            }
          })
          .catch((err) => {
            console.error('[Deep Link] Error checking game existence:', err);
            console.error('[Deep Link] Error details:', {
              message: err?.message,
              stack: err?.stack,
              sessionId: sessionId,
            });
            // If we can't check, default to import mode
            setCreateMode('import');
            setImportAuthEntryXDR(initialXDR);
            setImportSessionId(parsed.sessionId.toString());
            setImportPlayer1(parsed.player1);
            setImportPlayer1Points((Number(parsed.player1Points) / 10_000_000).toString());
            setImportPlayer2Points('0.1');
          });
      } catch (err) {
        console.log('[Deep Link] Failed to parse initialXDR, will retry on import');
        setCreateMode('import');
        setImportAuthEntryXDR(initialXDR);
        setImportPlayer2Points('0.1');
      }
      return; // Exit early - we processed initialXDR
    }

    // Priority 2: Check URL parameters (for direct navigation without GamesCatalog)
    const urlParams = new URLSearchParams(window.location.search);
    const authEntry = urlParams.get('auth');
    const urlSessionId = urlParams.get('session-id');

    if (authEntry) {
      // Simplified URL format - only auth entry is needed
      // Session ID, Player 1 address, and points are parsed from auth entry
      console.log('[Deep Link] Auto-populating game from URL with auth entry');

      // Try to parse auth entry to get session ID
      try {
        const parsed = zkBattleshipService.parseAuthEntry(authEntry);
        const sessionId = parsed.sessionId;

        console.log('[Deep Link] Parsed session ID from URL auth entry:', sessionId);

        // Check if game already exists (both players have signed)
        zkBattleshipService.getGame(sessionId)
          .then((game) => {
            if (game) {
              // Game exists! Load it directly instead of going to import mode
              console.log('[Deep Link] Game already exists (URL), loading directly to shot phase');
              console.log('[Deep Link] Game data:', game);

              // Auto-load the game - bypass create phase entirely
              setGameState(game);
              setGamePhase('shot');
              setSessionId(sessionId); // Set session ID for the game
            } else {
              // Game doesn't exist yet, go to import mode
              console.log('[Deep Link] Game not found (URL), entering import mode');
              setCreateMode('import');
              setImportAuthEntryXDR(authEntry);
              setImportSessionId(sessionId.toString());
              setImportPlayer1(parsed.player1);
              setImportPlayer1Points((Number(parsed.player1Points) / 10_000_000).toString());
              setImportPlayer2Points('0.1');
            }
          })
          .catch((err) => {
            console.error('[Deep Link] Error checking game existence (URL):', err);
            console.error('[Deep Link] Error details:', {
              message: err?.message,
              stack: err?.stack,
              sessionId: sessionId,
            });
            // If we can't check, default to import mode
            setCreateMode('import');
            setImportAuthEntryXDR(authEntry);
            setImportSessionId(parsed.sessionId.toString());
            setImportPlayer1(parsed.player1);
            setImportPlayer1Points((Number(parsed.player1Points) / 10_000_000).toString());
            setImportPlayer2Points('0.1');
          });
      } catch (err) {
        console.log('[Deep Link] Failed to parse auth entry from URL, will retry on import');
        setCreateMode('import');
        setImportAuthEntryXDR(authEntry);
        setImportPlayer2Points('0.1');
      }
    } else if (urlSessionId) {
      // Load existing game by session ID
      console.log('[Deep Link] Auto-populating game from URL with session ID');
      setCreateMode('load');
      setLoadSessionId(urlSessionId);
    } else if (initialSessionId !== null && initialSessionId !== undefined) {
      console.log('[Deep Link] Auto-populating session ID from prop:', initialSessionId);
      setCreateMode('load');
      setLoadSessionId(initialSessionId.toString());
    }
  }, [initialXDR, initialSessionId]);

  // Auto-parse Auth Entry XDR when pasted
  useEffect(() => {
    // Only parse if in import mode and XDR is not empty
    if (createMode !== 'import' || !importAuthEntryXDR.trim()) {
      // Reset parse states when XDR is cleared
      if (!importAuthEntryXDR.trim()) {
        setXdrParsing(false);
        setXdrParseError(null);
        setXdrParseSuccess(false);
        setImportSessionId('');
        setImportPlayer1('');
        setImportPlayer1Points('');
      }
      return;
    }

    // Auto-parse the XDR
    const parseXDR = async () => {
      setXdrParsing(true);
      setXdrParseError(null);
      setXdrParseSuccess(false);

      try {
        console.log('[Auto-Parse] Parsing auth entry XDR...');
        const gameParams = zkBattleshipService.parseAuthEntry(importAuthEntryXDR.trim());

        // Check if user is trying to import their own auth entry (self-play prevention)
        if (gameParams.player1 === userAddress) {
          throw new Error('You cannot play against yourself. This auth entry was created by you (Player 1).');
        }

        // Successfully parsed - auto-fill fields
        setImportSessionId(gameParams.sessionId.toString());
        setImportPlayer1(gameParams.player1);
        setImportPlayer1Points((Number(gameParams.player1Points) / 10_000_000).toString());
        setXdrParseSuccess(true);
        console.log('[Auto-Parse] Successfully parsed auth entry:', {
          sessionId: gameParams.sessionId,
          player1: gameParams.player1,
          player1Points: (Number(gameParams.player1Points) / 10_000_000).toString(),
        });
      } catch (err) {
        console.error('[Auto-Parse] Failed to parse auth entry:', err);
        const errorMsg = err instanceof Error ? err.message : 'Invalid auth entry XDR';
        setXdrParseError(errorMsg);
        // Clear auto-filled fields on error
        setImportSessionId('');
        setImportPlayer1('');
        setImportPlayer1Points('');
      } finally {
        setXdrParsing(false);
      }
    };

    // Debounce parsing to avoid parsing on every keystroke
    const timeoutId = setTimeout(parseXDR, 500);
    return () => clearTimeout(timeoutId);
  }, [importAuthEntryXDR, createMode, userAddress]);

  const handlePrepareTransaction = async () => {
    await runAction(async () => {
      try {
        setLoading(true);
        setError(null);
        setSuccess(null);

        const p1Points = parsePoints(player1Points);

        if (!p1Points || p1Points <= 0n) {
          throw new Error('Enter a valid points amount');
        }

        const signer = getContractSigner();

        // Use placeholder values for Player 2 (they'll rebuild with their own values).
        // We still need a real, funded account as the transaction source for build/simulation.
        const placeholderPlayer2Address = await getFundedSimulationSourceAddress([player1Address, userAddress]);
        const placeholderP2Points = p1Points; // Same as P1 for simulation

        console.log('Preparing transaction for Player 1 to sign...');
        console.log('Using placeholder Player 2 values for simulation only');
        const authEntryXDR = await zkBattleshipService.prepareStartGame(
          sessionId,
          player1Address,
          placeholderPlayer2Address,
          p1Points,
          placeholderP2Points,
          signer
        );

        console.log('Transaction prepared successfully! Player 1 has signed their auth entry.');
        setExportedAuthEntryXDR(authEntryXDR);
        setSuccess('Auth entry signed! Copy the auth entry XDR or share URL below and send it to Player 2. Waiting for them to sign...');

        // Start polling for the game to be created by Player 2
        const pollInterval = setInterval(async () => {
          try {
            // Try to load the game
            const game = await zkBattleshipService.getGame(sessionId);
            if (game) {
              console.log('Game found! Player 2 has finalized the transaction. Transitioning to shot phase...');
              clearInterval(pollInterval);

              // Update game state
              setGameState(game);
              setExportedAuthEntryXDR(null);
              setSuccess('Game created! Player 2 has signed and submitted.');
              setGamePhase('shot');

              // Refresh dashboard to show updated available points (locked in game)
              onStandingsRefresh();

              // Clear success message after 2 seconds
              setTimeout(() => setSuccess(null), 2000);
            } else {
              console.log('Game not found yet, continuing to poll...');
            }
          } catch (err) {
            // Game doesn't exist yet, keep polling
            console.log('Polling for game creation...', err instanceof Error ? err.message : 'checking');
          }
        }, 3000); // Poll every 3 seconds

        // Stop polling after 5 minutes
        setTimeout(() => {
          clearInterval(pollInterval);
          console.log('Stopped polling after 5 minutes');
        }, 300000);
      } catch (err) {
        console.error('Prepare transaction error:', err);
        // Extract detailed error message
        let errorMessage = 'Failed to prepare transaction';
        if (err instanceof Error) {
          errorMessage = err.message;

          // Check for common errors
          if (err.message.includes('insufficient')) {
            errorMessage = `Insufficient points: ${err.message}. Make sure you have enough points for this game.`;
          } else if (err.message.includes('auth')) {
            errorMessage = `Authorization failed: ${err.message}. Check your wallet connection.`;
          }
        }

        setError(errorMessage);

        // Keep the component in 'create' phase so user can see the error and retry
      } finally {
        setLoading(false);
      }
    });
  };

  const handleQuickStart = async () => {
    await runAction(async () => {
      try {
        setQuickstartLoading(true);
        setError(null);
        setSuccess(null);
        if (walletType !== 'dev') {
          throw new Error('Quickstart only works with dev wallets in the Games Library.');
        }

        if (!DevWalletService.isDevModeAvailable() || !DevWalletService.isPlayerAvailable(1) || !DevWalletService.isPlayerAvailable(2)) {
          throw new Error('Quickstart requires both dev wallets. Run "bun run setup" and connect a dev wallet.');
        }

        const p1Points = parsePoints(player1Points);
        if (!p1Points || p1Points <= 0n) {
          throw new Error('Enter a valid points amount');
        }

        const originalPlayer = devWalletService.getCurrentPlayer();
        let player1AddressQuickstart = '';
        let player2AddressQuickstart = '';
        let player1Signer: ReturnType<typeof devWalletService.getSigner> | null = null;
        let player2Signer: ReturnType<typeof devWalletService.getSigner> | null = null;

        try {
          await devWalletService.initPlayer(1);
          player1AddressQuickstart = devWalletService.getPublicKey();
          player1Signer = devWalletService.getSigner();

          await devWalletService.initPlayer(2);
          player2AddressQuickstart = devWalletService.getPublicKey();
          player2Signer = devWalletService.getSigner();
        } finally {
          if (originalPlayer) {
            await devWalletService.initPlayer(originalPlayer);
          }
        }

        if (!player1Signer || !player2Signer) {
          throw new Error('Quickstart failed to initialize dev wallet signers.');
        }

        if (player1AddressQuickstart === player2AddressQuickstart) {
          throw new Error('Quickstart requires two different dev wallets.');
        }

        const quickstartSessionId = createRandomSessionId();
        setSessionId(quickstartSessionId);
        setPlayer1Address(player1AddressQuickstart);
        setCreateMode('create');
        setExportedAuthEntryXDR(null);
        setImportAuthEntryXDR('');
        setImportSessionId('');
        setImportPlayer1('');
        setImportPlayer1Points('');
        setImportPlayer2Points(DEFAULT_POINTS);
        setLoadSessionId('');

        const placeholderPlayer2Address = await getFundedSimulationSourceAddress([
          player1AddressQuickstart,
          player2AddressQuickstart,
        ]);

        const authEntryXDR = await zkBattleshipService.prepareStartGame(
          quickstartSessionId,
          player1AddressQuickstart,
          placeholderPlayer2Address,
          p1Points,
          p1Points,
          player1Signer
        );

        const fullySignedTxXDR = await zkBattleshipService.importAndSignAuthEntry(
          authEntryXDR,
          player2AddressQuickstart,
          p1Points,
          player2Signer
        );

        await zkBattleshipService.finalizeStartGame(
          fullySignedTxXDR,
          player2AddressQuickstart,
          player2Signer
        );

        try {
          const game = await zkBattleshipService.getGame(quickstartSessionId);
          setGameState(game);
        } catch (err) {
          console.log('Quickstart game not available yet:', err);
        }
        setGamePhase('shot');
        onStandingsRefresh();
        setSuccess('Quickstart complete! Both players signed and the game is ready.');
        setTimeout(() => setSuccess(null), 2000);
      } catch (err) {
        console.error('Quickstart error:', err);
        setError(err instanceof Error ? err.message : 'Quickstart failed');
      } finally {
        setQuickstartLoading(false);
      }
    });
  };

  const handleImportTransaction = async () => {
    await runAction(async () => {
      try {
        setLoading(true);
        setError(null);
        setSuccess(null);
        // Validate required inputs (only auth entry and player 2 points)
        if (!importAuthEntryXDR.trim()) {
          throw new Error('Enter auth entry XDR from Player 1');
        }
        if (!importPlayer2Points.trim()) {
          throw new Error('Enter your points amount (Player 2)');
        }

        // Parse Player 2's points
        const p2Points = parsePoints(importPlayer2Points);
        if (!p2Points || p2Points <= 0n) {
          throw new Error('Invalid Player 2 points');
        }

        // Parse auth entry to extract game parameters
        // The auth entry contains: session_id, player1, player1_points
        console.log('Parsing auth entry to extract game parameters...');
        const gameParams = zkBattleshipService.parseAuthEntry(importAuthEntryXDR.trim());

        console.log('Extracted from auth entry:', {
          sessionId: gameParams.sessionId,
          player1: gameParams.player1,
          player1Points: gameParams.player1Points.toString(),
        });

        // Auto-populate read-only fields from parsed auth entry (for display)
        setImportSessionId(gameParams.sessionId.toString());
        setImportPlayer1(gameParams.player1);
        setImportPlayer1Points((Number(gameParams.player1Points) / 10_000_000).toString());

        // Verify the user is Player 2 (prevent self-play)
        if (gameParams.player1 === userAddress) {
          throw new Error('Invalid game: You cannot play against yourself (you are Player 1 in this auth entry)');
        }

        // Additional validation: Ensure Player 2 address is different from Player 1
        // (In case user manually edits the Player 2 field)
        if (userAddress === gameParams.player1) {
          throw new Error('Cannot play against yourself. Player 2 must be different from Player 1.');
        }

        const signer = getContractSigner();

        // Step 1: Import Player 1's signed auth entry and rebuild transaction
        // New simplified API - only needs: auth entry, player 2 address, player 2 points
        console.log('Importing Player 1 auth entry and rebuilding transaction...');
        const fullySignedTxXDR = await zkBattleshipService.importAndSignAuthEntry(
          importAuthEntryXDR.trim(),
          userAddress, // Player 2 address (current user)
          p2Points,
          signer
        );

        // Step 2: Player 2 finalizes and submits (they are the transaction source)
        console.log('Simulating and submitting transaction...');
        await zkBattleshipService.finalizeStartGame(
          fullySignedTxXDR,
          userAddress,
          signer
        );

        // If we get here, transaction succeeded! Now update state.
        console.log('Transaction submitted successfully! Updating state...');
        setSessionId(gameParams.sessionId);
        setSuccess('Game created successfully! Both players signed.');
        setGamePhase('shot');

        // Clear import fields
        setImportAuthEntryXDR('');
        setImportSessionId('');
        setImportPlayer1('');
        setImportPlayer1Points('');
        setImportPlayer2Points(DEFAULT_POINTS);

        // Load the newly created game state
        await loadGameState();

        // Refresh dashboard to show updated available points (locked in game)
        onStandingsRefresh();

        // Clear success message after 2 seconds
        setTimeout(() => setSuccess(null), 2000);
      } catch (err) {
        console.error('Import transaction error:', err);
        // Extract detailed error message if available
        let errorMessage = 'Failed to import and sign transaction';
        if (err instanceof Error) {
          errorMessage = err.message;

          // Check for common Soroban errors
          if (err.message.includes('simulation failed')) {
            errorMessage = `Simulation failed: ${err.message}. Check that you have enough Points and the game parameters are correct.`;
          } else if (err.message.includes('transaction failed')) {
            errorMessage = `Transaction failed: ${err.message}. The game could not be created on the blockchain.`;
          }
        }

        setError(errorMessage);

        // Keep the component in 'create' phase so user can see the error and retry
        // Don't change gamePhase or clear any fields - let the user see what went wrong
      } finally {
        setLoading(false);
      }
    });
  };

  const handleLoadExistingGame = async () => {
    await runAction(async () => {
      try {
        setLoading(true);
        setError(null);
        setSuccess(null);
        const parsedSessionId = parseInt(loadSessionId.trim());
        if (isNaN(parsedSessionId) || parsedSessionId <= 0) {
          throw new Error('Enter a valid session ID');
        }

        // Try to load the game (use cache to prevent duplicate calls)
        const game = await requestCache.dedupe(
          createCacheKey('game-state', parsedSessionId),
          () => zkBattleshipService.getGame(parsedSessionId),
          5000
        );

        // Verify game exists and user is one of the players
        if (!game) {
          throw new Error('Game not found');
        }

        if (game.player1 !== userAddress && game.player2 !== userAddress) {
          throw new Error('You are not a player in this game');
        }

        // Load successful - update session ID and transition to game
        setSessionId(parsedSessionId);
        setGameState(game);
        setLoadSessionId('');

        // Determine game phase based on game state
        if (game.winner !== null && game.winner !== undefined) {
          // Game is complete - show reveal phase with winner
          setGamePhase('reveal');
          const isWinner = game.winner === userAddress;
          setSuccess(isWinner ? '🎉 You won this game!' : 'Game complete. Winner revealed.');
        } else if (game.player1_guess !== null && game.player1_guess !== undefined &&
            game.player2_guess !== null && game.player2_guess !== undefined) {
          // Both players locked shots, waiting for reveal
          setGamePhase('reveal');
          setSuccess('Game loaded! Both players locked shots. You can reveal the winner.');
        } else {
          // Still in shot phase
          setGamePhase('shot');
          setSuccess('Game loaded! Take your shot.');
        }

        // Clear success message after 2 seconds
        setTimeout(() => setSuccess(null), 2000);
      } catch (err) {
        console.error('Load game error:', err);
        setError(err instanceof Error ? err.message : 'Failed to load game');
      } finally {
        setLoading(false);
      }
    });
  };

  const copyAuthEntryToClipboard = async () => {
    if (exportedAuthEntryXDR) {
      try {
        await navigator.clipboard.writeText(exportedAuthEntryXDR);
        setAuthEntryCopied(true);
        setTimeout(() => setAuthEntryCopied(false), 2000);
      } catch (err) {
        console.error('Failed to copy auth entry XDR:', err);
        setError('Failed to copy to clipboard');
      }
    }
  };

  const copyShareGameUrlWithAuthEntry = async () => {
    if (exportedAuthEntryXDR) {
      try {
        // Build URL with only Player 1's info and auth entry
        // Player 2 will specify their own points when they import
        const params = new URLSearchParams({
          'game': 'zk-battleship',
          'auth': exportedAuthEntryXDR,
        });

        const shareUrl = `${window.location.origin}${window.location.pathname}?${params.toString()}`;
        await navigator.clipboard.writeText(shareUrl);
        setShareUrlCopied(true);
        setTimeout(() => setShareUrlCopied(false), 2000);
      } catch (err) {
        console.error('Failed to copy share URL:', err);
        setError('Failed to copy to clipboard');
      }
    }
  };

  const copyShareGameUrlWithSessionId = async () => {
    if (loadSessionId) {
      try {
        const shareUrl = `${window.location.origin}${window.location.pathname}?game=zk-battleship&session-id=${loadSessionId}`;
        await navigator.clipboard.writeText(shareUrl);
        setShareUrlCopied(true);
        setTimeout(() => setShareUrlCopied(false), 2000);
      } catch (err) {
        console.error('Failed to copy share URL:', err);
        setError('Failed to copy to clipboard');
      }
    }
  };

  const toggleBoardSetupCell = (cell: number) => {
    if (!gameState) return;

    const setupStep = !boardP1Locked ? 1 : !boardP2Locked ? 2 : 0;
    if (setupStep === 0) return;

    const isExpectedPlayer = setupStep === 1 ? isPlayer1 : isPlayer2;
    if (!isExpectedPlayer) return;

    const currentCells = setupStep === 1 ? boardP1Cells : boardP2Cells;
    const hasCell = currentCells.includes(cell);

    let nextCells: number[];
    if (hasCell) {
      nextCells = currentCells.filter((value) => value !== cell);
    } else {
      if (currentCells.length >= 4) return;
      nextCells = [...currentCells, cell].sort((a, b) => a - b);
    }

    if (setupStep === 1) {
      setBoardP1Cells(nextCells);
    } else {
      setBoardP2Cells(nextCells);
    }
  };

  const validateTwoSizeTwoShips = (cells: number[]): string | null => {
    if (cells.length !== 4) {
      return 'Select exactly 4 ship cells before locking the board.';
    }

    const selected = new Set(cells);
    const visited = new Set<number>();
    const components: number[][] = [];

    const neighbors = (cell: number): number[] => {
      const x = (cell - 1) % 4;
      const y = Math.floor((cell - 1) / 4);
      const result: number[] = [];
      const deltas = [[1, 0], [-1, 0], [0, 1], [0, -1]];

      for (const [dx, dy] of deltas) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx >= 0 && nx < 4 && ny >= 0 && ny < 4) {
          const nextCell = ny * 4 + nx + 1;
          if (selected.has(nextCell)) {
            result.push(nextCell);
          }
        }
      }

      return result;
    };

    for (const cell of cells) {
      if (visited.has(cell)) continue;

      const queue = [cell];
      const component: number[] = [];
      visited.add(cell);

      while (queue.length > 0) {
        const current = queue.shift();
        if (current === undefined) continue;
        component.push(current);

        for (const next of neighbors(current)) {
          if (!visited.has(next)) {
            visited.add(next);
            queue.push(next);
          }
        }
      }

      components.push(component);
    }

    if (components.length !== 2 || components.some((component) => component.length !== 2)) {
      return 'Invalid layout: board must contain exactly 2 ships of size 2.';
    }

    return null;
  };

  const handleLockBoardSetup = () => {
    if (!gameState) return;

    const setupStep = !boardP1Locked ? 1 : !boardP2Locked ? 2 : 0;
    if (setupStep === 0) return;

    const isExpectedPlayer = setupStep === 1 ? isPlayer1 : isPlayer2;
    if (!isExpectedPlayer) {
      setError(`Switch to Player ${setupStep} wallet to lock this board.`);
      return;
    }

    const selectedCells = setupStep === 1 ? boardP1Cells : boardP2Cells;
    const validationError = validateTwoSizeTwoShips(selectedCells);
    if (validationError) {
      setError(validationError);
      return;
    }

    setError(null);

    if (setupStep === 1) {
      setBoardP1Locked(true);
      setSuccess('Player 1 board locked. Switch to Player 2 to place ships.');
      return;
    }

    setBoardP2Locked(true);
    setSuccess('Player 2 board locked. Setup complete, proceed with shots.');
  };

  const handleSubmitShot = () => {
    if (shotCell === null) {
      setError('Select a cell to shoot');
      return;
    }

    if (!boardSetupComplete) {
      setError('Complete board setup for both players before taking shots.');
      return;
    }

    if (localWinner !== 0) {
      setError('Match already finished. Proceed to Submit Proof.');
      return;
    }

    const player = isPlayer1 ? 1 : isPlayer2 ? 2 : 0;
    if (player === 0) {
      setError('You are not a player in this match.');
      return;
    }

    if (player !== currentTurn) {
      setError(`It is Player ${currentTurn}'s turn.`);
      return;
    }

    const alreadyShot = moves.some((move) => move.player === player && move.cell === shotCell);
    if (alreadyShot) {
      setError('You already shot this cell. Choose another one.');
      return;
    }

    const x = (shotCell - 1) % 4;
    const y = Math.floor((shotCell - 1) / 4);
    const move: LocalMove = { player: player as 1 | 2, cell: shotCell, x, y };

    const isHit = player === 1 ? boardP2Cells.includes(shotCell) : boardP1Cells.includes(shotCell);

    const nextHitsP1 = player === 1 && isHit ? hitsP1 + 1 : hitsP1;
    const nextHitsP2 = player === 2 && isHit ? hitsP2 + 1 : hitsP2;

    setMoves((prev) => [...prev, move]);
    setHitsP1(nextHitsP1);
    setHitsP2(nextHitsP2);
    setShotCell(null);
    setError(null);

    if (nextHitsP1 >= 4) {
      setLocalWinner(1);
      setGamePhase('reveal');
      setSuccess(`Hit on cell ${shotCell}. Player 1 sank all ships. Submit proof.`);
      return;
    }

    if (nextHitsP2 >= 4) {
      setLocalWinner(2);
      setGamePhase('reveal');
      setSuccess(`Hit on cell ${shotCell}. Player 2 sank all ships. Submit proof.`);
      return;
    }

    setCurrentTurn(player === 1 ? 2 : 1);
    setSuccess(`${isHit ? 'Hit' : 'Miss'} on cell ${shotCell}. Next turn: Player ${player === 1 ? 2 : 1}.`);
  };

  const waitForWinner = async () => {
    let updatedGame = await zkBattleshipService.getGame(sessionId);
    let attempts = 0;
    while (attempts < 5 && (!updatedGame || updatedGame.winner === null || updatedGame.winner === undefined)) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
      updatedGame = await zkBattleshipService.getGame(sessionId);
      attempts += 1;
    }
    return updatedGame;
  };

  const buildBoardArray = (cells: number[]): number[] => {
    const board = new Array<number>(16).fill(0);
    for (const cell of cells) {
      if (cell >= 1 && cell <= 16) board[cell - 1] = 1;
    }
    return board;
  };

  const buildGameInputPayload = () => ({
    session_id: sessionId,
    board_p1: buildBoardArray(boardP1Cells),
    board_p2: buildBoardArray(boardP2Cells),
    moves: moves.map((move) => ({ player: move.player, x: move.x, y: move.y })),
  });

  const handleGenerateGameInputJson = () => {
    if (!boardP1Locked || !boardP2Locked) {
      setError('Lock both boards before generating game-input.json.');
      return;
    }
    if (moves.length === 0) {
      setError('No moves recorded yet.');
      return;
    }

    const payload = buildGameInputPayload();
    const json = JSON.stringify(payload, null, 2);
    setGameInputJson(json);
    setError(null);
    setSuccess('game-input.json generated from current local match state.');
  };

  const handleCopyGameInputJson = async () => {
    if (!gameInputJson) return;
    try {
      await navigator.clipboard.writeText(gameInputJson);
      setSuccess('game-input.json copied to clipboard.');
    } catch {
      setError('Failed to copy game-input.json.');
    }
  };

  const handleDownloadGameInputJson = () => {
    if (!gameInputJson) return;
    const blob = new Blob([gameInputJson], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `game-input-${sessionId}.json`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
    setSuccess('game-input.json downloaded.');
  };

  const handleCopyHostCommand = async () => {
    try {
      await navigator.clipboard.writeText(hostRunCommand);
      setSuccess('Host command copied. Run it in terminal to generate proof-output.json.');
    } catch {
      setError('Failed to copy host command.');
    }
  };

  const handleSubmitProofResult = async () => {
    await runAction(async () => {
      try {
        setLoading(true);
        setError(null);
        setSuccess(null);

        if (!proofOutputJson.trim()) {
          throw new Error('Paste proof-output.json content before submitting');
        }

        const payload = parseProofPayload(proofOutputJson);
        if (localWinner !== 0 && payload.winner !== localWinner) {
          throw new Error(`Proof winner (${payload.winner}) does not match local match winner (${localWinner}).`);
        }
        if (moves.length > 0 && payload.totalMoves !== moves.length) {
          throw new Error(`Proof total_moves (${payload.totalMoves}) does not match local move count (${moves.length}).`);
        }
        const signer = getContractSigner();
        const submitOutcome = await zkBattleshipService.submitResult(sessionId, userAddress, payload, signer);

        setSubmittedProof(payload);
        setSettlementTxHash(submitOutcome.txHash);

        const updatedGame = await waitForWinner();
        setGameState(updatedGame);
        setGamePhase('complete');

        const isWinner = updatedGame?.winner === userAddress;
        setSuccess(isWinner ? '🎉 ZK proof submitted and you won!' : 'ZK proof submitted. Game settled on-chain.');

        onStandingsRefresh();
      } catch (err) {
        console.error('Submit proof error:', err);
        setError(err instanceof Error ? err.message : 'Failed to submit proof result');
      } finally {
        setLoading(false);
      }
    });
  };

  const isPlayer1 = gameState && gameState.player1 === userAddress;
  const isPlayer2 = gameState && gameState.player2 === userAddress;

  const setupStep = !boardP1Locked ? 1 : !boardP2Locked ? 2 : 0;
  const setupCells = setupStep === 1 ? boardP1Cells : setupStep === 2 ? boardP2Cells : [];
  const isSetupPlayerConnected = setupStep === 1 ? Boolean(isPlayer1) : setupStep === 2 ? Boolean(isPlayer2) : true;
  const hasAnyLocalShot = moves.length > 0;
  const boardSetupComplete = setupStep === 0 || hasAnyLocalShot;

  const isTurnPlayerConnected = currentTurn === 1 ? Boolean(isPlayer1) : Boolean(isPlayer2);
  const player1ShotsCount = moves.filter((move) => move.player === 1).length;
  const player2ShotsCount = moves.filter((move) => move.player === 2).length;
  const activeShooter: 1 | 2 | null = isPlayer1 ? 1 : isPlayer2 ? 2 : null;
  const activeTargetBoard = activeShooter === 1 ? boardP2Cells : boardP1Cells;
  const activeShotResults = new Map<number, boolean>();
  if (activeShooter !== null) {
    for (const move of moves) {
      if (move.player !== activeShooter) continue;
      activeShotResults.set(move.cell, activeTargetBoard.includes(move.cell));
    }
  }

  const moveHistory = moves.slice(-6).map((move) => {
    const targetBoard = move.player === 1 ? boardP2Cells : boardP1Cells;
    return {
      ...move,
      hit: targetBoard.includes(move.cell),
    };
  }).reverse();

  const commitHashP1 = toHex(gameState?.board_commit_p1);
  const commitHashP2 = toHex(gameState?.board_commit_p2);
  const proofHashP1 = submittedProof?.boardHashP1Hex ?? toHex(gameState?.board_hash_p1);
  const proofHashP2 = submittedProof?.boardHashP2Hex ?? toHex(gameState?.board_hash_p2);
  const hashMatchP1 = Boolean(commitHashP1 && proofHashP1 && commitHashP1 === proofHashP1);
  const hashMatchP2 = Boolean(commitHashP2 && proofHashP2 && commitHashP2 === proofHashP2);
  const proofMoves = submittedProof?.totalMoves ?? moves.length;
  const settlementTxUrl = settlementTxHash ? `https://stellar.expert/explorer/testnet/tx/${settlementTxHash}` : null;

  const hostInputFileName = `game-input-${sessionId}.json`;
  const hostInputPath = `/home/max/battleship-project/zk-battleship-risc0/${hostInputFileName}`;
  const hostRunCommand = `cd /home/max/battleship-project/zk-battleship-risc0 && cp ~/Downloads/${hostInputFileName} ${hostInputPath} && cargo run -- --input ${hostInputPath} --proof ./proof-output.json --receipt ./receipt.bin`;

  return (
    <div className="bg-white/70 backdrop-blur-xl rounded-2xl p-8 shadow-xl border-2 border-purple-200">
      <div className="flex items-center mb-6">
        <div>
          <h2 className="text-3xl font-black bg-gradient-to-r from-purple-600 via-pink-600 to-red-600 bg-clip-text text-transparent">
            Zk Battleship Game 🚢
          </h2>
          <p className="text-xs text-gray-500 font-mono mt-1">
            Session ID: {sessionId}
          </p>
        </div>
      </div>

      {error && (
        <div className="mb-6 p-4 bg-gradient-to-r from-red-50 to-pink-50 border-2 border-red-200 rounded-xl">
          <p className="text-sm font-semibold text-red-700">{error}</p>
        </div>
      )}

      {success && (
        <div className="mb-6 p-4 bg-gradient-to-r from-green-50 to-emerald-50 border-2 border-green-200 rounded-xl">
          <p className="text-sm font-semibold text-green-700">{success}</p>
        </div>
      )}

      {/* CREATE GAME PHASE */}
      {gamePhase === 'create' && (
        <div className="space-y-6">
          {/* Mode Toggle */}
          <div className="flex flex-col sm:flex-row items-center justify-center gap-3 p-2 bg-gray-100 rounded-xl">
            <button
              onClick={() => {
                setCreateMode('create');
                setExportedAuthEntryXDR(null);
                setImportAuthEntryXDR('');
                setImportSessionId('');
                setImportPlayer1('');
                setImportPlayer1Points('');
                setImportPlayer2Points(DEFAULT_POINTS);
                setLoadSessionId('');
              }}
              className={`flex-1 py-3 px-4 rounded-lg font-bold text-sm transition-all ${
                createMode === 'create'
                  ? 'bg-gradient-to-r from-purple-500 to-pink-500 text-white shadow-lg'
                  : 'bg-white text-gray-600 hover:bg-gray-50'
              }`}
            >
              Create & Export
            </button>
            <button
              onClick={() => {
                setCreateMode('import');
                setExportedAuthEntryXDR(null);
                setLoadSessionId('');
              }}
              className={`flex-1 py-3 px-4 rounded-lg font-bold text-sm transition-all ${
                createMode === 'import'
                  ? 'bg-gradient-to-r from-blue-500 to-cyan-500 text-white shadow-lg'
                  : 'bg-white text-gray-600 hover:bg-gray-50'
              }`}
            >
              Import Auth Entry
            </button>
            <button
              onClick={() => {
                setCreateMode('load');
                setExportedAuthEntryXDR(null);
                setImportAuthEntryXDR('');
                setImportSessionId('');
                setImportPlayer1('');
                setImportPlayer1Points('');
                setImportPlayer2Points(DEFAULT_POINTS);
              }}
              className={`flex-1 py-3 px-4 rounded-lg font-bold text-sm transition-all ${
                createMode === 'load'
                  ? 'bg-gradient-to-r from-green-500 to-emerald-500 text-white shadow-lg'
                  : 'bg-white text-gray-600 hover:bg-gray-50'
              }`}
            >
              Load Existing Game
            </button>
          </div>

          <div className="p-4 bg-gradient-to-r from-yellow-50 to-orange-50 border-2 border-yellow-200 rounded-xl">
            <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3">
              <div>
                <p className="text-sm font-bold text-yellow-900">⚡ Quickstart (Dev)</p>
                <p className="text-xs font-semibold text-yellow-800">
                  Creates and signs for both dev wallets in one click. Works only in the Games Library.
                </p>
              </div>
              <button
                onClick={handleQuickStart}
                disabled={isBusy || !quickstartAvailable}
                className="px-4 py-3 rounded-xl font-bold text-sm text-white bg-gradient-to-r from-yellow-500 to-orange-500 hover:from-yellow-600 hover:to-orange-600 disabled:from-gray-200 disabled:to-gray-300 disabled:text-gray-500 transition-all shadow-md hover:shadow-lg transform hover:scale-105 disabled:transform-none"
              >
                {quickstartLoading ? 'Quickstarting...' : '⚡ Quickstart Game'}
              </button>
            </div>
          </div>

          {createMode === 'create' ? (
            <div className="space-y-6">
          <div className="space-y-4">
            <div>
              <label className="block text-sm font-bold text-gray-700 mb-2">
                Your Address (Player 1)
              </label>
              <input
                type="text"
                value={player1Address}
                onChange={(e) => setPlayer1Address(e.target.value.trim())}
                placeholder="G..."
                className="w-full px-4 py-3 rounded-xl bg-white border-2 border-gray-200 focus:outline-none focus:border-purple-400 focus:ring-4 focus:ring-purple-100 text-sm font-medium text-gray-700"
              />
              <p className="text-xs font-semibold text-gray-600 mt-1">
                Pre-filled from your connected wallet. If you change it, you must be able to sign as that address.
              </p>
            </div>

            <div>
              <label className="block text-sm font-bold text-gray-700 mb-2">
                Your Points
              </label>
              <input
                type="text"
                value={player1Points}
                onChange={(e) => setPlayer1Points(e.target.value)}
                placeholder="0.1"
                className="w-full px-4 py-3 rounded-xl bg-white border-2 border-gray-200 focus:outline-none focus:border-purple-400 focus:ring-4 focus:ring-purple-100 text-sm font-medium"
              />
              <p className="text-xs font-semibold text-gray-600 mt-1">
                Available: {(Number(availablePoints) / 10000000).toFixed(2)} Points
              </p>
            </div>

            <div className="p-3 bg-blue-50 border-2 border-blue-200 rounded-xl">
              <p className="text-xs font-semibold text-blue-800">
                ℹ️ Player 2 will specify their own address and points when they import your auth entry. You only need to prepare and export your signature.
              </p>
            </div>
          </div>

          <div className="pt-4 border-t-2 border-gray-100 space-y-4">
            <p className="text-xs font-semibold text-gray-600">
              Session ID: {sessionId}
            </p>

            {!exportedAuthEntryXDR ? (
              <button
                onClick={handlePrepareTransaction}
                disabled={isBusy}
                className="w-full py-4 rounded-xl font-bold text-white text-sm bg-gradient-to-r from-purple-500 to-pink-500 hover:from-purple-600 hover:to-pink-600 disabled:from-gray-200 disabled:to-gray-300 disabled:text-gray-500 transition-all shadow-lg hover:shadow-xl transform hover:scale-105 disabled:transform-none"
              >
                {loading ? 'Preparing...' : 'Prepare & Export Auth Entry'}
              </button>
            ) : (
              <div className="space-y-3">
                <div className="p-4 bg-gradient-to-br from-green-50 to-emerald-50 border-2 border-green-200 rounded-xl">
                  <p className="text-xs font-bold uppercase tracking-wide text-green-700 mb-2">
                    Auth Entry XDR (Player 1 Signed)
                  </p>
                  <div className="bg-white p-3 rounded-lg border border-green-200 mb-3">
                    <code className="text-xs font-mono text-gray-700 break-all">
                      {exportedAuthEntryXDR}
                    </code>
                  </div>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <button
                      onClick={copyAuthEntryToClipboard}
                      className="py-3 rounded-lg bg-gradient-to-r from-green-500 to-emerald-500 hover:from-green-600 hover:to-emerald-600 text-white font-bold text-sm transition-all shadow-md hover:shadow-lg transform hover:scale-105"
                    >
                      {authEntryCopied ? '✓ Copied!' : '📋 Copy Auth Entry'}
                    </button>
                    <button
                      onClick={copyShareGameUrlWithAuthEntry}
                      className="py-3 rounded-lg bg-gradient-to-r from-blue-500 to-indigo-500 hover:from-blue-600 hover:to-indigo-600 text-white font-bold text-sm transition-all shadow-md hover:shadow-lg transform hover:scale-105"
                    >
                      {shareUrlCopied ? '✓ Copied!' : '🔗 Share URL'}
                    </button>
                  </div>
                </div>
                <p className="text-xs text-gray-600 text-center font-semibold">
                  Copy the auth entry XDR or share URL with Player 2 to complete the transaction
                </p>
              </div>
            )}
          </div>
            </div>
          ) : createMode === 'import' ? (
            /* IMPORT MODE */
            <div className="space-y-4">
              <div className="p-4 bg-gradient-to-br from-blue-50 to-cyan-50 border-2 border-blue-200 rounded-xl">
                <p className="text-sm font-semibold text-blue-800 mb-2">
                  📥 Import Auth Entry from Player 1
                </p>
                <p className="text-xs text-gray-700 mb-4">
                  Paste the auth entry XDR from Player 1. Session ID, Player 1 address, and their points will be auto-extracted. You only need to enter your points amount.
                </p>
                <div className="space-y-3">
                  <div>
                    <label className="block text-xs font-bold text-gray-700 mb-1 flex items-center gap-2">
                      Auth Entry XDR
                      {xdrParsing && (
                        <span className="text-blue-500 text-xs animate-pulse">Parsing...</span>
                      )}
                      {xdrParseSuccess && (
                        <span className="text-green-600 text-xs">✓ Parsed successfully</span>
                      )}
                      {xdrParseError && (
                        <span className="text-red-600 text-xs">✗ Parse failed</span>
                      )}
                    </label>
                    <textarea
                      value={importAuthEntryXDR}
                      onChange={(e) => setImportAuthEntryXDR(e.target.value)}
                      placeholder="Paste Player 1's signed auth entry XDR here..."
                      rows={4}
                      className={`w-full px-4 py-3 rounded-xl bg-white border-2 focus:outline-none focus:ring-4 text-xs font-mono resize-none transition-colors ${
                        xdrParseError
                          ? 'border-red-300 focus:border-red-400 focus:ring-red-100'
                          : xdrParseSuccess
                          ? 'border-green-300 focus:border-green-400 focus:ring-green-100'
                          : 'border-blue-200 focus:border-blue-400 focus:ring-blue-100'
                      }`}
                    />
                    {xdrParseError && (
                      <p className="text-xs text-red-600 font-semibold mt-1">
                        {xdrParseError}
                      </p>
                    )}
                  </div>
                  {/* Auto-populated fields from auth entry (read-only) */}
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="block text-xs font-bold text-gray-500 mb-1">Session ID (auto-filled)</label>
                      <input
                        type="text"
                        value={importSessionId}
                        readOnly
                        placeholder="Auto-filled from auth entry"
                        className="w-full px-4 py-2 rounded-xl bg-gray-50 border-2 border-gray-200 text-xs font-mono text-gray-600 cursor-not-allowed"
                      />
                    </div>
                    <div>
                      <label className="block text-xs font-bold text-gray-500 mb-1">Player 1 Points (auto-filled)</label>
                      <input
                        type="text"
                        value={importPlayer1Points}
                        readOnly
                        placeholder="Auto-filled from auth entry"
                        className="w-full px-4 py-2 rounded-xl bg-gray-50 border-2 border-gray-200 text-xs text-gray-600 cursor-not-allowed"
                      />
                    </div>
                  </div>
                  <div>
                    <label className="block text-xs font-bold text-gray-500 mb-1">Player 1 Address (auto-filled)</label>
                    <input
                      type="text"
                      value={importPlayer1}
                      readOnly
                      placeholder="Auto-filled from auth entry"
                      className="w-full px-4 py-2 rounded-xl bg-gray-50 border-2 border-gray-200 text-xs font-mono text-gray-600 cursor-not-allowed"
                    />
                  </div>
                  {/* User inputs */}
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="block text-xs font-bold text-gray-500 mb-1">Player 2 (You)</label>
                      <input
                        type="text"
                        value={userAddress}
                        readOnly
                        className="w-full px-4 py-2 rounded-xl bg-gray-50 border-2 border-gray-200 text-xs font-mono text-gray-600 cursor-not-allowed"
                      />
                    </div>
                    <div>
                      <label className="block text-xs font-bold text-gray-700 mb-1">Your Points *</label>
                      <input
                        type="text"
                        value={importPlayer2Points}
                        onChange={(e) => setImportPlayer2Points(e.target.value)}
                        placeholder="e.g., 0.1"
                        className="w-full px-4 py-2 rounded-xl bg-white border-2 border-blue-200 focus:outline-none focus:border-blue-400 focus:ring-4 focus:ring-blue-100 text-xs"
                      />
                    </div>
                  </div>
                </div>
              </div>

              <button
                onClick={handleImportTransaction}
                disabled={isBusy || !importAuthEntryXDR.trim() || !importPlayer2Points.trim()}
                className="w-full py-4 rounded-xl font-bold text-white text-lg bg-gradient-to-r from-blue-500 via-cyan-500 to-teal-500 hover:from-blue-600 hover:via-cyan-600 hover:to-teal-600 disabled:from-gray-200 disabled:to-gray-300 disabled:text-gray-500 transition-all shadow-xl hover:shadow-2xl transform hover:scale-105 disabled:transform-none"
              >
                {loading ? 'Importing & Signing...' : 'Import & Sign Auth Entry'}
              </button>
            </div>
          ) : createMode === 'load' ? (
            /* LOAD EXISTING GAME MODE */
            <div className="space-y-4">
              <div className="p-4 bg-gradient-to-br from-green-50 to-emerald-50 border-2 border-green-200 rounded-xl">
                <p className="text-sm font-semibold text-green-800 mb-2">
                  🎮 Load Existing Game by Session ID
                </p>
                <p className="text-xs text-gray-700 mb-4">
                  Enter a session ID to load and continue an existing game. You must be one of the players.
                </p>
                <input
                  type="text"
                  value={loadSessionId}
                  onChange={(e) => setLoadSessionId(e.target.value)}
                  placeholder="Enter session ID (e.g., 123456789)"
                  className="w-full px-4 py-3 rounded-xl bg-white border-2 border-green-200 focus:outline-none focus:border-green-400 focus:ring-4 focus:ring-green-100 text-sm font-mono"
                />
              </div>

              <div className="p-4 bg-gradient-to-br from-yellow-50 to-amber-50 border-2 border-yellow-200 rounded-xl">
                <p className="text-xs font-bold text-yellow-800 mb-2">
                  Requirements
                </p>
                <ul className="text-xs text-gray-700 space-y-1 list-disc list-inside">
                  <li>You must be Player 1 or Player 2 in the game</li>
                  <li>Game must be active (not completed)</li>
                  <li>Valid session ID from an existing game</li>
                </ul>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <button
                  onClick={handleLoadExistingGame}
                  disabled={isBusy || !loadSessionId.trim()}
                  className="py-4 rounded-xl font-bold text-white text-lg bg-gradient-to-r from-green-500 via-emerald-500 to-teal-500 hover:from-green-600 hover:via-emerald-600 hover:to-teal-600 disabled:from-gray-200 disabled:to-gray-300 disabled:text-gray-500 transition-all shadow-xl hover:shadow-2xl transform hover:scale-105 disabled:transform-none"
                >
                  {loading ? 'Loading...' : '🎮 Load Game'}
                </button>
                <button
                  onClick={copyShareGameUrlWithSessionId}
                  disabled={!loadSessionId.trim()}
                  className="py-4 rounded-xl font-bold text-white text-lg bg-gradient-to-r from-blue-500 to-indigo-500 hover:from-blue-600 hover:to-indigo-600 disabled:from-gray-200 disabled:to-gray-300 disabled:text-gray-500 transition-all shadow-xl hover:shadow-2xl transform hover:scale-105 disabled:transform-none"
                >
                  {shareUrlCopied ? '✓ Copied!' : '🔗 Share Game'}
                </button>
              </div>
              <p className="text-xs text-gray-600 text-center font-semibold">
                Load the game to continue playing, or share the URL with another player
              </p>
            </div>
          ) : null}
        </div>
      )}

      {/* SHOT PHASE */}
      {gamePhase === 'shot' && gameState && (
        <div className="space-y-6">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div className={`p-5 rounded-xl border-2 ${isPlayer1 ? 'border-purple-400 bg-gradient-to-br from-purple-50 to-pink-50 shadow-lg' : 'border-gray-200 bg-white'}`}>
              <div className="text-xs font-bold uppercase tracking-wide text-gray-600 mb-1">Player 1</div>
              <div className="font-mono text-sm font-semibold mb-2 text-gray-800">
                {gameState.player1.slice(0, 8)}...{gameState.player1.slice(-4)}
              </div>
              <div className="text-xs font-semibold text-gray-600">
                Points: {(Number(gameState.player1_points) / 10000000).toFixed(2)}
              </div>
              <div className="mt-3 text-xs font-semibold text-gray-600">
                Shots: {player1ShotsCount} | Hits: {hitsP1}/4
              </div>
            </div>

            <div className={`p-5 rounded-xl border-2 ${isPlayer2 ? 'border-purple-400 bg-gradient-to-br from-purple-50 to-pink-50 shadow-lg' : 'border-gray-200 bg-white'}`}>
              <div className="text-xs font-bold uppercase tracking-wide text-gray-600 mb-1">Player 2</div>
              <div className="font-mono text-sm font-semibold mb-2 text-gray-800">
                {gameState.player2.slice(0, 8)}...{gameState.player2.slice(-4)}
              </div>
              <div className="text-xs font-semibold text-gray-600">
                Points: {(Number(gameState.player2_points) / 10000000).toFixed(2)}
              </div>
              <div className="mt-3 text-xs font-semibold text-gray-600">
                Shots: {player2ShotsCount} | Hits: {hitsP2}/4
              </div>
            </div>
          </div>

          {boardSetupComplete && localWinner === 0 && (
            <div className="p-4 bg-gradient-to-r from-cyan-50 to-blue-50 border-2 border-cyan-200 rounded-xl">
              <p className="text-sm font-semibold text-cyan-800">
                Current turn: Player {currentTurn} {isTurnPlayerConnected ? '(you can shoot)' : '(switch wallet)'}
              </p>
            </div>
          )}

          {!boardSetupComplete && (
            <div className="space-y-4 p-5 bg-gradient-to-br from-indigo-50 to-purple-50 border-2 border-indigo-200 rounded-xl">
              <div>
                <h4 className="text-sm font-black text-indigo-900">Board Setup (2 ships of size 2)</h4>
                <p className="text-xs font-semibold text-indigo-700 mt-1">
                  Configure Player 1 first, then Player 2. Each player must lock exactly 2 ships of size 2 (4 cells total).
                </p>
              </div>

              <div className="text-xs font-semibold text-gray-700">
                {setupStep === 1 && 'Current step: Player 1 board placement'}
                {setupStep === 2 && 'Current step: Player 2 board placement'}
              </div>

              {!isSetupPlayerConnected && (
                <div className="p-3 bg-yellow-50 border border-yellow-200 rounded-lg text-xs font-semibold text-yellow-800">
                  Switch wallet to Player {setupStep} to select and lock this board.
                </div>
              )}

              <div className="grid grid-cols-4 gap-3">
                {Array.from({ length: 16 }, (_, i) => i + 1).map((cell) => {
                  const selected = setupCells.includes(cell);
                  return (
                    <button
                      key={`setup-${cell}`}
                      onClick={() => toggleBoardSetupCell(cell)}
                      disabled={!isSetupPlayerConnected}
                      className={`p-3 rounded-xl border-2 font-black text-lg transition-all ${
                        selected
                          ? 'border-indigo-500 bg-gradient-to-br from-indigo-500 to-purple-500 text-white shadow-lg'
                          : 'border-gray-200 bg-white hover:border-indigo-300'
                      } disabled:opacity-50 disabled:cursor-not-allowed`}
                    >
                      {cell}
                    </button>
                  );
                })}
              </div>

              <div className="flex items-center justify-between text-xs font-semibold text-gray-700">
                <span>Selected: {setupCells.length}/4</span>
                <span>P1 locked: {boardP1Locked ? 'yes' : 'no'} | P2 locked: {boardP2Locked ? 'yes' : 'no'}</span>
              </div>

              <button
                onClick={handleLockBoardSetup}
                disabled={!isSetupPlayerConnected || setupCells.length !== 4}
                className="w-full py-3 rounded-xl font-bold text-white text-sm bg-gradient-to-r from-indigo-500 to-purple-500 hover:from-indigo-600 hover:to-purple-600 disabled:from-gray-200 disabled:to-gray-300 disabled:text-gray-500 transition-all"
              >
                {setupStep === 1 ? 'Lock Player 1 Board' : 'Lock Player 2 Board'}
              </button>
            </div>
          )}

          {(isPlayer1 || isPlayer2) && boardSetupComplete && localWinner === 0 && (
            <div className="space-y-4">
              <label className="block text-sm font-bold text-gray-700">
                Select Your Shot (4x4 Grid)
              </label>
              <div className="grid grid-cols-4 gap-3">
                {Array.from({ length: 16 }, (_, i) => i + 1).map((cell) => {
                  const hasShot = activeShotResults.has(cell);
                  const isHit = activeShotResults.get(cell) === true;
                  const isMiss = hasShot && !isHit;
                  return (
                    <button
                      key={cell}
                      onClick={() => setShotCell(cell)}
                      disabled={hasShot}
                      className={`p-4 rounded-xl border-2 font-black text-xl transition-all disabled:cursor-not-allowed ${
                        isHit
                          ? 'border-emerald-500 bg-gradient-to-br from-emerald-500 to-green-500 text-white shadow-xl'
                          : isMiss
                            ? 'border-rose-500 bg-gradient-to-br from-rose-500 to-red-500 text-white shadow-xl'
                            : shotCell === cell
                              ? 'border-purple-500 bg-gradient-to-br from-purple-500 to-pink-500 text-white scale-110 shadow-2xl'
                              : 'border-gray-200 bg-white hover:border-purple-300 hover:shadow-lg hover:scale-105'
                      }`}
                    >
                      {isHit ? '🚢✓' : isMiss ? '💣' : cell}
                    </button>
                  );
                })}
              </div>
              <div className="flex flex-wrap gap-4 text-xs font-semibold text-gray-600">
                <span>🚢✓ Hit</span>
                <span>💣 Miss</span>
              </div>
              {moveHistory.length > 0 && (
                <div className="p-3 rounded-xl border border-gray-200 bg-white/70">
                  <div className="text-xs font-bold text-gray-600 mb-2">Last shots</div>
                  <div className="space-y-1.5">
                    {moveHistory.map((entry, index) => (
                      <div key={`${entry.player}-${entry.cell}-${index}`} className="text-xs font-semibold text-gray-700">
                        P{entry.player} {'>'} Cell {entry.cell} {'>'} {entry.hit ? '🚢 HIT' : '💣 MISS'}
                      </div>
                    ))}
                  </div>
                </div>
              )}
              <button
                onClick={handleSubmitShot}
                disabled={isBusy || shotCell === null || !isTurnPlayerConnected}
                className="w-full mt-2.5 py-4 rounded-xl font-bold text-white text-lg bg-gradient-to-r from-purple-500 via-pink-500 to-red-500 hover:from-purple-600 hover:via-pink-600 hover:to-red-600 disabled:from-gray-200 disabled:to-gray-300 disabled:text-gray-500 transition-all shadow-xl hover:shadow-2xl transform hover:scale-105 disabled:transform-none"
              >
                {loading ? 'Submitting...' : 'Submit Shot'}
              </button>
            </div>
          )}

          {boardSetupComplete && localWinner === 0 && !isTurnPlayerConnected && (
            <div className="p-4 bg-gradient-to-r from-blue-50 to-cyan-50 border-2 border-blue-200 rounded-xl">
              <p className="text-sm font-semibold text-blue-700">
                Waiting for Player {currentTurn} turn.
              </p>
            </div>
          )}
        </div>
      )}

      {/* REVEAL PHASE */}
      {gamePhase === 'reveal' && gameState && (
        <div className="space-y-6">
          <div className="p-8 bg-gradient-to-br from-yellow-50 via-orange-50 to-amber-50 border-2 border-yellow-300 rounded-2xl shadow-xl">
            <div className="text-6xl mb-4 text-center">🧾</div>
            <h3 className="text-2xl font-black text-gray-900 mb-3 text-center">
              Submit ZK Match Proof
            </h3>
            <p className="text-sm font-semibold text-gray-700 mb-4 text-center">
              Paste the full content of <span className="font-mono">proof-output.json</span> generated by the RISC0 host.
            </p>
            <p className="text-xs text-gray-600 mb-3 font-mono text-center">
              Expected session: {sessionId}
            </p>

            <div className="mb-4 p-4 bg-white/70 border border-yellow-200 rounded-xl">
              <p className="text-xs font-semibold text-gray-700 mb-3">
                Generate <span className="font-mono">game-input.json</span> from local match state for the RISC0 host.
              </p>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 mb-3">
                <button
                  onClick={handleGenerateGameInputJson}
                  className="py-2 rounded-lg font-bold text-xs text-white bg-gradient-to-r from-indigo-500 to-purple-500 hover:from-indigo-600 hover:to-purple-600"
                >
                  Generate game-input.json
                </button>
                <button
                  onClick={handleCopyGameInputJson}
                  disabled={!gameInputJson}
                  className="py-2 rounded-lg font-bold text-xs text-white bg-gradient-to-r from-blue-500 to-cyan-500 hover:from-blue-600 hover:to-cyan-600 disabled:from-gray-200 disabled:to-gray-300 disabled:text-gray-500"
                >
                  Copy game-input.json
                </button>
                <button
                  onClick={handleDownloadGameInputJson}
                  disabled={!gameInputJson}
                  className="py-2 rounded-lg font-bold text-xs text-white bg-gradient-to-r from-emerald-500 to-green-500 hover:from-emerald-600 hover:to-green-600 disabled:from-gray-200 disabled:to-gray-300 disabled:text-gray-500"
                >
                  Download game-input.json
                </button>
              </div>
              <textarea
                value={gameInputJson}
                readOnly
                placeholder="Generated game-input.json will appear here..."
                rows={8}
                className="w-full px-3 py-2 rounded-lg bg-gray-50 border border-gray-200 text-xs font-mono resize-y"
              />

              <div className="mt-3 p-3 bg-gray-50 border border-gray-200 rounded-lg">
                <p className="text-xs font-semibold text-gray-700 mb-2">
                  Run Prover (manual, in terminal)
                </p>
                <code className="block text-[11px] font-mono text-gray-700 break-all">
                  {hostRunCommand}
                </code>
                <button
                  onClick={handleCopyHostCommand}
                  className="mt-3 py-2 px-3 rounded-lg font-bold text-xs text-white bg-gradient-to-r from-slate-600 to-gray-700 hover:from-slate-700 hover:to-gray-800"
                >
                  Copy Host Command
                </button>
              </div>
            </div>

            <textarea
              value={proofOutputJson}
              onChange={(e) => setProofOutputJson(e.target.value)}
              placeholder="Paste proof-output.json here..."
              rows={10}
              className="w-full px-4 py-3 rounded-xl bg-white border-2 border-yellow-200 focus:outline-none focus:border-yellow-400 focus:ring-4 focus:ring-yellow-100 text-xs font-mono resize-y"
            />
            <div className="mt-5 text-center">
              <button
                onClick={handleSubmitProofResult}
                disabled={isBusy || !proofOutputJson.trim()}
                className="px-10 py-4 rounded-xl font-bold text-white text-lg bg-gradient-to-r from-yellow-500 via-orange-500 to-amber-500 hover:from-yellow-600 hover:via-orange-600 hover:to-amber-600 disabled:from-gray-200 disabled:to-gray-300 disabled:text-gray-500 transition-all shadow-xl hover:shadow-2xl transform hover:scale-105 disabled:transform-none"
              >
                {loading ? 'Submitting Proof...' : 'Submit Proof Result'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* COMPLETE PHASE */}
      {gamePhase === 'complete' && gameState && (
        <div className="space-y-6">
          <div className="p-8 bg-gradient-to-br from-green-50 via-emerald-50 to-teal-50 border-2 border-green-300 rounded-2xl shadow-2xl">
            <div className="text-center mb-6">
              <div className="text-6xl mb-3">🏆</div>
              <h3 className="text-3xl font-black text-gray-900">Verified Match Complete</h3>
              <p className="text-sm font-semibold text-gray-700 mt-2">
                Session {sessionId} settled on-chain with ZK verification.
              </p>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <div className="p-4 bg-white/80 border border-green-200 rounded-xl">
                <p className="text-xs font-bold uppercase tracking-wide text-gray-600 mb-1">Session ID</p>
                <p className="font-mono text-sm font-semibold text-gray-800">{sessionId}</p>
              </div>
              <div className="p-4 bg-white/80 border border-green-200 rounded-xl">
                <p className="text-xs font-bold uppercase tracking-wide text-gray-600 mb-1">Winner</p>
                <p className="font-mono text-sm font-semibold text-gray-800">{shortText(gameState.winner ?? null)}</p>
              </div>
              <div className="p-4 bg-white/80 border border-green-200 rounded-xl">
                <p className="text-xs font-bold uppercase tracking-wide text-gray-600 mb-1">Total Moves</p>
                <p className="font-mono text-sm font-semibold text-gray-800">{proofMoves}</p>
              </div>
            </div>

            <div className="mt-6 grid grid-cols-1 md:grid-cols-3 gap-4">
              <div className="p-4 bg-white border border-blue-200 rounded-xl">
                <p className="text-sm font-black text-blue-900 mb-2">Start / Commit</p>
                <p className="text-xs text-gray-700 mb-1">Board commit P1: <span className="font-mono">{shortText(commitHashP1)}</span></p>
                <p className="text-xs text-gray-700 mb-1">Board commit P2: <span className="font-mono">{shortText(commitHashP2)}</span></p>
                <p className="text-xs font-semibold text-blue-700 mt-2">Boards committed at game start (anti-tampering checkpoint).</p>
              </div>

              <div className="p-4 bg-white border border-yellow-200 rounded-xl">
                <p className="text-sm font-black text-yellow-900 mb-2">Proof Generation</p>
                <p className="text-xs text-gray-700 mb-1">Proof hash P1: <span className="font-mono">{shortText(proofHashP1)}</span></p>
                <p className="text-xs text-gray-700 mb-1">Proof hash P2: <span className="font-mono">{shortText(proofHashP2)}</span></p>
                <p className="text-xs text-gray-700 mt-2">Local comparison: {hashMatchP1 && hashMatchP2 ? 'MATCH ✅' : 'MISMATCH ❌'}</p>
                <p className="text-xs font-semibold text-yellow-700 mt-1">ZK proof computed from full match transcript.</p>
              </div>

              <div className="p-4 bg-white border border-purple-200 rounded-xl">
                <p className="text-sm font-black text-purple-900 mb-2">Final On-chain Verification</p>
                <p className="text-xs text-gray-700 mb-1">Commit check: {hashMatchP1 && hashMatchP2 ? 'commit == proof ✅' : 'failed ❌'}</p>
                <p className="text-xs text-gray-700 mb-1">Verifier: <span className="font-mono">{shortText(verifierContract, 6)}</span></p>
                <p className="text-xs text-gray-700 mb-1">Image ID: <span className="font-mono">{shortText(imageIdHex, 8)}</span></p>
                <p className="text-xs text-gray-700">Result settled: {gameState.winner ? 'winner recorded ✅' : 'pending'}</p>
                <p className="text-xs font-semibold text-purple-700 mt-1">No board changes possible after commit.</p>
              </div>
            </div>

            <div className="mt-6 p-4 bg-white/80 border border-green-200 rounded-xl">
              <p className="text-xs font-bold uppercase tracking-wide text-gray-600 mb-1">Settlement Transaction</p>
              {settlementTxUrl ? (
                <a
                  href={settlementTxUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="text-sm font-mono text-blue-700 underline break-all"
                >
                  {settlementTxHash}
                </a>
              ) : (
                <p className="text-sm font-mono text-gray-600">Not captured in this session</p>
              )}
            </div>

            {gameState.winner === userAddress && (
              <p className="mt-5 text-center text-xl font-black text-green-700">🎉 You won!</p>
            )}
          </div>

          <button
            onClick={handleStartNewGame}
            className="w-full py-4 rounded-xl font-bold text-gray-700 bg-gradient-to-r from-gray-200 to-gray-300 hover:from-gray-300 hover:to-gray-400 transition-all shadow-lg hover:shadow-xl transform hover:scale-105"
          >
            Start New Game
          </button>
        </div>
      )}
    </div>
  );
}
