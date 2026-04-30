/**
 * Interacta Cloud Functions
 *
 * Server-authoritative game engine: role assignment, game lifecycle,
 * and score management. Clients cannot manipulate roles or scores directly.
 */

const {setGlobalOptions} = require("firebase-functions");
const {onCall, HttpsError} = require("firebase-functions/https");
const {initializeApp} = require("firebase-admin/app");
const {getFirestore, FieldValue} = require("firebase-admin/firestore");
const logger = require("firebase-functions/logger");

initializeApp();
const db = getFirestore();
setGlobalOptions({maxInstances: 10});

/**
 * startGame — Callable function
 *
 * Validates the caller is the host, assigns spy/civilian roles to a
 * private secrets sub-collection, and activates the game timer.
 */
exports.startGame = onCall(async (request) => {
  if (!request.auth) {
    throw new HttpsError("unauthenticated", "You must be signed in.");
  }

  const gameId = request.data && request.data.gameId;
  if (!gameId || typeof gameId !== "string") {
    throw new HttpsError("invalid-argument", "A valid gameId is required.");
  }

  const gameRef = db.collection("games").doc(gameId);

  return db.runTransaction(async (transaction) => {
    const gameDoc = await transaction.get(gameRef);
    if (!gameDoc.exists) {
      throw new HttpsError("not-found", "Game room not found.");
    }

    const gameData = gameDoc.data();

    if (gameData.hostId !== request.auth.uid) {
      throw new HttpsError(
          "permission-denied",
          "Only the host can start the game.",
      );
    }

    if (gameData.status !== "waiting") {
      throw new HttpsError(
          "failed-precondition",
          "Game has already started or ended.",
      );
    }

    // Fetch all players inside the transaction
    const playersSnapshot = await transaction.get(
        gameRef.collection("players"),
    );
    const players = playersSnapshot.docs.filter((p) => p.data().status === "active");

    if (players.length < 2) {
      throw new HttpsError(
          "failed-precondition",
          "Need at least 2 active players to start. Currently: " + players.length,
      );
    }

    // Clamp spy count to valid range
    const spyCount = Math.min(
        Math.max(gameData.spyCount || 1, 1),
        players.length - 1,
    );

    // Clamp detective count: at least 1, but spies + detectives < total
    const detectiveCount = Math.min(
        Math.max(gameData.detectiveCount || 1, 1),
        players.length - spyCount - 1,
    );

    // Ensure at least 1 influencer remains
    if (spyCount + detectiveCount >= players.length) {
      throw new HttpsError(
          "failed-precondition",
          "Not enough players for the configured spy/detective counts. " +
          "Need at least " + (spyCount + detectiveCount + 1) + " players.",
      );
    }

    // Fisher-Yates shuffle for fair randomness
    const ids = players.map((p) => p.id);
    for (let i = ids.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      const tmp = ids[i];
      ids[i] = ids[j];
      ids[j] = tmp;
    }

    // Assign roles: spies → detectives → influencers
    for (let i = 0; i < ids.length; i++) {
      let role;
      if (i < spyCount) {
        role = "spy";
      } else if (i < spyCount + detectiveCount) {
        role = "detective";
      } else {
        role = "influencer";
      }
      const secretRef = gameRef.collection("secrets").doc(ids[i]);
      transaction.set(secretRef, {
        role: role,
        assignedAt: FieldValue.serverTimestamp(),
      });

      // Task Generation logic
      const maxPossibleScans = Math.max(1, players.length - 1);

      const taskRef = db.collection("tasks").doc(`${gameId}_${ids[i]}`);
      let taskData = {
        gameId: gameId,
        userId: ids[i],
        currentTask: {
          progress: 0,
          scannedUsers: [],
          lastScanTime: null,
          maxScans: Math.min(3, maxPossibleScans),
          cooldown: 10
        },
        history: []
      };

      if (role === "influencer" || role === "spy") {
        taskData.currentTask.type = "INTERACTION";
        taskData.currentTask.targetCount = Math.min(3, maxPossibleScans);
      } else if (role === "detective") {
        taskData.currentTask.type = "DETECT";
        taskData.currentTask.targetCount = 1;
        taskData.currentTask.clues = ["Likes Blue"]; // Mock clue
      }
      
      transaction.set(taskRef, taskData);
    }

    // Set game timer
    const durationMs = (gameData.durationMinutes || 5) * 60 * 1000;
    const endsAt = new Date(Date.now() + durationMs);

    transaction.update(gameRef, {
      status: "active",
      startedAt: FieldValue.serverTimestamp(),
      endsAt: endsAt,
      remainingSpies: spyCount,
    });

    logger.info(
        "Game " + gameId + " started: " + players.length +
        " players, " + spyCount + " spies, " +
        detectiveCount + " detectives, " +
        (players.length - spyCount - detectiveCount) + " influencers",
    );

    return {
      success: true,
      playerCount: players.length,
      spyCount: spyCount,
      detectiveCount: detectiveCount,
      influencerCount: players.length - spyCount - detectiveCount,
    };
  });
});

exports.validateScan = onCall(async (request) => {
  if (!request.auth) {
    throw new HttpsError("unauthenticated", "You must be signed in.");
  }

  const { gameId, scannedUserId } = request.data;
  const scannerId = request.auth.uid;

  if (!gameId || !scannedUserId) {
    throw new HttpsError("invalid-argument", "gameId and scannedUserId required.");
  }
  if (scannerId === scannedUserId) {
    throw new HttpsError("invalid-argument", "Cannot scan yourself.");
  }

  const taskRef = db.collection("tasks").doc(`${gameId}_${scannerId}`);

  return db.runTransaction(async (transaction) => {
    const taskDoc = await transaction.get(taskRef);
    if (!taskDoc.exists) {
      throw new HttpsError("not-found", "Task document not found.");
    }
    
    const taskData = taskDoc.data();
    const currentTask = taskData.currentTask;

    if (!currentTask) {
      throw new HttpsError("failed-precondition", "No active task.");
    }
    
    if (currentTask.progress >= currentTask.targetCount) {
      throw new HttpsError("failed-precondition", "Task is already completed.");
    }
    
    // Check cooldown (10 seconds minimum)
    if (currentTask.lastScanTime) {
      let lastScanDate;
      // Handle both Timestamp and generic date formats safely
      if (currentTask.lastScanTime.toDate) {
        lastScanDate = currentTask.lastScanTime.toDate();
      } else if (currentTask.lastScanTime._seconds) {
        lastScanDate = new Date(currentTask.lastScanTime._seconds * 1000);
      } else {
        lastScanDate = new Date(currentTask.lastScanTime);
      }
      
      const now = new Date();
      if ((now.getTime() - lastScanDate.getTime()) < currentTask.cooldown * 1000) {
         throw new HttpsError("failed-precondition", "Cooldown active. Please wait.");
      }
    }

    // Check max scans
    if (currentTask.scannedUsers.length >= currentTask.maxScans) {
       throw new HttpsError("failed-precondition", "Max scan limit reached for this task.");
    }

    // Duplicate scan prevention
    if (currentTask.scannedUsers.includes(scannedUserId)) {
      throw new HttpsError("failed-precondition", "You have already scanned this player.");
    }

    currentTask.scannedUsers.push(scannedUserId);
    currentTask.lastScanTime = FieldValue.serverTimestamp();

    let scanResult = { success: false, message: "" };

    if (currentTask.type === "INTERACTION") {
      currentTask.progress += 1;
      scanResult.success = true;
      if (currentTask.progress >= currentTask.targetCount) {
         scanResult.message = "Task completed!";
      } else {
         scanResult.message = `Scan successful! (${currentTask.progress}/${currentTask.targetCount})`;
      }
    } else if (currentTask.type === "DETECT") {
      // Mock validation logic for Detective
      // Ideally, we'd check if the user matches the clue (e.g. they are a spy). Let's check their role as a proxy.
      const scannedSecretRef = db.collection("games").doc(gameId).collection("secrets").doc(scannedUserId);
      const scannedSecretDoc = await transaction.get(scannedSecretRef);
      
      if (scannedSecretDoc.exists && scannedSecretDoc.data().role === "spy") {
         currentTask.progress += 1;
         scanResult.success = true;
         scanResult.message = "Target found! Task completed!";
      } else {
         scanResult.success = false;
         scanResult.message = "Wrong person. Penalty applied.";
      }
    }

    transaction.update(taskRef, { currentTask });
    return scanResult;
  });
});

/**
 * endGame — Callable function
 *
 * Reveals all player roles by copying secrets to the player documents,
 * then marks the game as ended. Host can end early; any participant
 * can end once the timer expires.
 */
exports.endGame = onCall(async (request) => {
  if (!request.auth) {
    throw new HttpsError("unauthenticated", "You must be signed in.");
  }

  const gameId = request.data && request.data.gameId;
  if (!gameId || typeof gameId !== "string") {
    throw new HttpsError("invalid-argument", "A valid gameId is required.");
  }

  const gameRef = db.collection("games").doc(gameId);

  return db.runTransaction(async (transaction) => {
    const gameDoc = await transaction.get(gameRef);
    if (!gameDoc.exists) {
      throw new HttpsError("not-found", "Game room not found.");
    }

    const gameData = gameDoc.data();

    if (gameData.status === "ended") {
      throw new HttpsError("failed-precondition", "Game has already ended.");
    }

    const isHost = gameData.hostId === request.auth.uid;
    let isExpired = false;
    if (gameData.endsAt) {
      if (typeof gameData.endsAt.toDate === "function") {
        isExpired = gameData.endsAt.toDate() <= new Date();
      } else {
        isExpired = new Date(gameData.endsAt) <= new Date();
      }
    }

    if (!isHost) {
      // Non-host: verify they are a participant
      const callerRef = gameRef.collection("players").doc(request.auth.uid);
      const callerDoc = await transaction.get(callerRef);

      if (!callerDoc.exists) {
        throw new HttpsError(
            "permission-denied",
            "You are not part of this game.",
        );
      }

      if (!isExpired) {
        throw new HttpsError(
            "permission-denied",
            "Only the host can end the game before the timer expires.",
        );
      }
    }

    // Reveal roles: copy from secrets to player docs
    const secretsSnapshot = await transaction.get(
        gameRef.collection("secrets"),
    );

    for (const secretDoc of secretsSnapshot.docs) {
      const playerRef = gameRef.collection("players").doc(secretDoc.id);
      transaction.set(playerRef, {
        role: secretDoc.data().role,
        revealed: true,
      }, { merge: true });
    }

    transaction.update(gameRef, {
      status: "ended",
      endedAt: FieldValue.serverTimestamp(),
    });

    logger.info(
        "Game " + gameId + " ended by " + (isHost ? "host" : "timer/player"),
    );

    return {success: true};
  });
});
