const {
  loadQuestions,
  sanitizeQuestionForClient,
  getCorrectAnswerIndex,
} = require("../utils/questions");

const QUESTION_TIME_LIMIT_MS = 15000;
const BASE_POINTS = 100;
const EVENT_ROOM_ID = "main-event";

let activeRoom = null;

function emitError(socket, message) {
  socket.emit("error:message", { message });
}

function getSessionStatus() {
  if (!activeRoom) {
    return {
      exists: false,
      joinable: false,
      status: "idle",
      hostName: null,
      playerCount: 0,
    };
  }

  const host = activeRoom.players.find((player) => player.id === activeRoom.hostId);

  return {
    exists: true,
    joinable: activeRoom.status === "lobby",
    status: activeRoom.status,
    hostName: host ? host.name : null,
    playerCount: activeRoom.players.length,
  };
}

function emitSessionStatus(io, socket = null) {
  const payload = getSessionStatus();

  if (socket) {
    socket.emit("session:status", payload);
    return;
  }

  io.emit("session:status", payload);
}

function canStartGame(room) {
  return room.players.length >= 2 && room.players.every((player) => player.isReady);
}

function getLeaderboard(room) {
  return [...room.players]
    .sort((left, right) => right.score - left.score)
    .map((player, index) => ({
      rank: index + 1,
      id: player.id,
      name: player.name,
      score: player.score,
    }));
}

function emitRoomState(io) {
  if (!activeRoom) {
    emitSessionStatus(io);
    io.emit("room:closed");
    return;
  }

  io.to(EVENT_ROOM_ID).emit("room:state", {
    hostId: activeRoom.hostId,
    players: activeRoom.players.map((player) => ({
      id: player.id,
      name: player.name,
      score: player.score,
      isReady: player.isReady,
      isHost: player.id === activeRoom.hostId,
    })),
    status: activeRoom.status,
    currentQuestionIndex: activeRoom.currentQuestionIndex,
    totalQuestions: activeRoom.questions.length,
    canStart: canStartGame(activeRoom),
  });

  emitSessionStatus(io);
}

function cleanupRoom() {
  if (!activeRoom) {
    return;
  }

  if (activeRoom.timer) {
    clearTimeout(activeRoom.timer);
  }

  activeRoom = null;
}

function finishGame(io) {
  if (!activeRoom) {
    return;
  }

  activeRoom.status = "finished";

  io.to(EVENT_ROOM_ID).emit("game:end", {
    leaderboard: getLeaderboard(activeRoom),
  });

  emitRoomState(io);
}

function calculateSpeedBonus(answeredAt, questionStartedAt) {
  const elapsedMs = Math.max(0, answeredAt - questionStartedAt);
  const remainingRatio = Math.max(0, QUESTION_TIME_LIMIT_MS - elapsedMs) / QUESTION_TIME_LIMIT_MS;

  return Math.round(remainingRatio * 50);
}

function advanceToQuestion(io) {
  if (!activeRoom) {
    return;
  }

  activeRoom.currentQuestionIndex += 1;

  if (activeRoom.currentQuestionIndex >= activeRoom.questions.length) {
    finishGame(io);
    return;
  }

  const question = activeRoom.questions[activeRoom.currentQuestionIndex];
  activeRoom.answers = {};
  activeRoom.questionStartedAt = Date.now();
  activeRoom.status = "question";

  io.to(EVENT_ROOM_ID).emit("question:send", {
    questionIndex: activeRoom.currentQuestionIndex,
    totalQuestions: activeRoom.questions.length,
    question: sanitizeQuestionForClient(question),
    endsAt: activeRoom.questionStartedAt + QUESTION_TIME_LIMIT_MS,
    durationMs: QUESTION_TIME_LIMIT_MS,
  });

  emitRoomState(io);

  activeRoom.timer = setTimeout(() => {
    finishQuestion(io);
  }, QUESTION_TIME_LIMIT_MS);
}

function finishQuestion(io) {
  if (!activeRoom || activeRoom.status !== "question") {
    return;
  }

  if (activeRoom.timer) {
    clearTimeout(activeRoom.timer);
    activeRoom.timer = null;
  }

  const question = activeRoom.questions[activeRoom.currentQuestionIndex];
  const correctAnswerIndex = getCorrectAnswerIndex(question);

  activeRoom.status = "result";

  io.to(EVENT_ROOM_ID).emit("question:result", {
    correctAnswerIndex,
    leaderboard: getLeaderboard(activeRoom),
    answers: Object.values(activeRoom.answers),
  });

  emitRoomState(io);

  activeRoom.timer = setTimeout(() => {
    advanceToQuestion(io);
  }, 5000);
}

function handleRoomCreate(io, socket, payload) {
  const nickname = payload?.nickname?.trim();

  if (!nickname) {
    emitError(socket, "Le pseudo est obligatoire.");
    return;
  }

  if (activeRoom) {
    emitError(socket, "Une partie existe deja. Entre simplement ton pseudo pour la rejoindre.");
    return;
  }

  activeRoom = {
    hostId: socket.id,
    players: [{ id: socket.id, name: nickname, score: 0, isReady: true }],
    currentQuestionIndex: -1,
    questions: loadQuestions(),
    answers: {},
    status: "lobby",
    timer: null,
    questionStartedAt: null,
  };

  socket.data.roomId = EVENT_ROOM_ID;
  socket.data.nickname = nickname;
  socket.join(EVENT_ROOM_ID);

  socket.emit("room:create", {
    playerId: socket.id,
  });

  emitRoomState(io);
}

function handleRoomJoin(io, socket, payload) {
  const nickname = payload?.nickname?.trim();

  if (!nickname) {
    emitError(socket, "Le pseudo est obligatoire.");
    return;
  }

  if (!activeRoom) {
    emitError(socket, "Aucune partie n'a encore ete creee.");
    return;
  }

  if (activeRoom.status !== "lobby") {
    emitError(socket, "La partie a deja commence.");
    return;
  }

  if (activeRoom.players.some((player) => player.name.toLowerCase() === nickname.toLowerCase())) {
    emitError(socket, "Ce pseudo est deja pris.");
    return;
  }

  activeRoom.players.push({ id: socket.id, name: nickname, score: 0, isReady: false });

  socket.data.roomId = EVENT_ROOM_ID;
  socket.data.nickname = nickname;
  socket.join(EVENT_ROOM_ID);

  socket.emit("room:join", {
    playerId: socket.id,
  });

  emitRoomState(io);
}

function handleGameStart(io, socket) {
  if (!activeRoom) {
    emitError(socket, "Aucune partie active.");
    return;
  }

  if (activeRoom.hostId !== socket.id) {
    emitError(socket, "Seul l'admin peut lancer la partie.");
    return;
  }

  if (activeRoom.status !== "lobby") {
    emitError(socket, "La partie a deja commence.");
    return;
  }

  if (!canStartGame(activeRoom)) {
    emitError(socket, "Tous les joueurs doivent etre prets avant le lancement.");
    return;
  }

  advanceToQuestion(io);
}

function handleReadyToggle(io, socket, payload) {
  if (!activeRoom) {
    emitError(socket, "Aucune partie active.");
    return;
  }

  if (activeRoom.status !== "lobby") {
    emitError(socket, "Le statut pret ne peut etre change que dans le lobby.");
    return;
  }

  const player = activeRoom.players.find((entry) => entry.id === socket.id);

  if (!player) {
    emitError(socket, "Joueur introuvable.");
    return;
  }

  player.isReady = Boolean(payload?.isReady);
  emitRoomState(io);
}

function handleAnswerSubmit(io, socket, payload) {
  if (!activeRoom || activeRoom.status !== "question") {
    emitError(socket, "Aucune question active pour le moment.");
    return;
  }

  if (activeRoom.answers[socket.id]) {
    emitError(socket, "Une seule reponse par question.");
    return;
  }

  const selectedAnswerIndex = Number(payload?.answerIndex);
  const currentQuestion = activeRoom.questions[activeRoom.currentQuestionIndex];

  if (!Number.isInteger(selectedAnswerIndex) || selectedAnswerIndex < 0 || selectedAnswerIndex > 3) {
    emitError(socket, "Reponse invalide.");
    return;
  }

  const answeredAt = Date.now();
  const correctAnswerIndex = getCorrectAnswerIndex(currentQuestion);
  const isCorrect = selectedAnswerIndex === correctAnswerIndex;
  const speedBonus = isCorrect ? calculateSpeedBonus(answeredAt, activeRoom.questionStartedAt) : 0;
  const pointsEarned = isCorrect ? BASE_POINTS + speedBonus : 0;

  activeRoom.answers[socket.id] = {
    playerId: socket.id,
    name: socket.data.nickname,
    answerIndex: selectedAnswerIndex,
    isCorrect,
    pointsEarned,
    answeredAt,
  };

  const player = activeRoom.players.find((entry) => entry.id === socket.id);

  if (player) {
    player.score += pointsEarned;
  }

  socket.emit("answer:submitted", {
    accepted: true,
    isCorrect,
    pointsEarned,
  });

  const everyoneAnswered = activeRoom.players.every((playerEntry) => activeRoom.answers[playerEntry.id]);

  if (everyoneAnswered) {
    finishQuestion(io);
  } else {
    io.to(EVENT_ROOM_ID).emit("answer:count", {
      count: Object.keys(activeRoom.answers).length,
      totalPlayers: activeRoom.players.length,
    });
    emitRoomState(io);
  }
}

function handleDisconnect(io, socket) {
  if (!activeRoom) {
    return;
  }

  activeRoom.players = activeRoom.players.filter((player) => player.id !== socket.id);
  delete activeRoom.answers[socket.id];

  if (activeRoom.players.length === 0) {
    cleanupRoom();
    emitSessionStatus(io);
    io.emit("room:closed");
    return;
  }

  if (activeRoom.hostId === socket.id) {
    activeRoom.hostId = activeRoom.players[0].id;
    activeRoom.players[0].isReady = true;
  }

  emitRoomState(io);
}

function registerSocketHandlers(io) {
  io.on("connection", (socket) => {
    emitSessionStatus(io, socket);
    socket.on("room:create", (payload) => handleRoomCreate(io, socket, payload));
    socket.on("room:join", (payload) => handleRoomJoin(io, socket, payload));
    socket.on("game:start", () => handleGameStart(io, socket));
    socket.on("player:ready", (payload) => handleReadyToggle(io, socket, payload));
    socket.on("answer:submit", (payload) => handleAnswerSubmit(io, socket, payload));
    socket.on("disconnect", () => handleDisconnect(io, socket));
  });
}

module.exports = {
  registerSocketHandlers,
};
