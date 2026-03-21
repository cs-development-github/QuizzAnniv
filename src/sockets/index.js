const crypto = require("crypto");

const {
  loadQuestions,
  sanitizeQuestionForClient,
  getCorrectAnswerIndex,
} = require("../utils/questions");

const QUESTION_TIME_LIMIT_MS = 20000;
const CORRECT_ANSWER_POINTS = 10;
const RULES_SCREEN_MS = 30000;
const QUESTION_TRANSITION_MS = 5000;
const ROOM_ID_LENGTH = 8;
const AVATAR_STYLE = "fun-emoji";

const rooms = new Map();

function createDefaultAvatar(seedSource) {
  return {
    style: AVATAR_STYLE,
    seed: `${seedSource}-${Date.now()}-${crypto.randomUUID().slice(0, 6)}`,
  };
}

function sanitizeAvatar(payload, fallbackSeedSource) {
  const style = typeof payload?.style === "string" ? payload.style.trim() : "";
  const seed = typeof payload?.seed === "string" ? payload.seed.trim() : "";

  if (style !== AVATAR_STYLE || !seed) {
    return createDefaultAvatar(fallbackSeedSource);
  }

  return { style, seed };
}

function emitError(socket, message) {
  socket.emit("error:message", { message });
}

function normalizeRoomId(roomId) {
  const value = typeof roomId === "string" ? roomId.trim().toLowerCase() : "";
  return value.slice(0, ROOM_ID_LENGTH);
}

function getRoomChannel(roomId) {
  return `room:${roomId}`;
}

function getAdminChannel(roomId) {
  return `room:${roomId}:admins`;
}

function createRoom(roomId) {
  const normalizedRoomId = normalizeRoomId(roomId);

  if (!normalizedRoomId) {
    return null;
  }

  if (!rooms.has(normalizedRoomId)) {
    rooms.set(normalizedRoomId, {
      id: normalizedRoomId,
      admins: [],
      players: [],
      currentQuestionIndex: -1,
      questions: loadQuestions(),
      answers: {},
      status: "lobby",
      timer: null,
      questionStartedAt: null,
      phaseEndsAt: null,
    });
  }

  return rooms.get(normalizedRoomId);
}

function getRoom(roomId) {
  return rooms.get(normalizeRoomId(roomId)) || null;
}

function getVisiblePlayers(room) {
  return room.players.map((player) => ({
    id: player.id,
    name: player.name,
    score: player.score,
    isReady: player.isReady,
    avatar: player.avatar,
  }));
}

function getRoomStatus(room) {
  if (!room) {
    return {
      exists: false,
      joinable: false,
      status: "missing",
      playerCount: 0,
      readyCount: 0,
    };
  }

  const readyCount = room.players.filter((player) => player.isReady).length;

  return {
    exists: true,
    joinable: room.status === "lobby",
    status: room.status,
    playerCount: room.players.length,
    readyCount,
  };
}

function canStartGame(room) {
  return room.players.length >= 1 && room.players.every((player) => player.isReady);
}

function getLeaderboard(room) {
  return [...room.players]
    .sort((left, right) => right.score - left.score)
    .map((player, index) => ({
      rank: index + 1,
      id: player.id,
      name: player.name,
      score: player.score,
      avatar: player.avatar,
    }));
}

function emitRoomSnapshot(io, room, socket = null) {
  const payload = {
    roomId: room.id,
    players: getVisiblePlayers(room),
    status: room.status,
    currentQuestionIndex: room.currentQuestionIndex,
    totalQuestions: room.questions.length,
    canStart: canStartGame(room),
    readyCount: room.players.filter((player) => player.isReady).length,
    phaseEndsAt: room.phaseEndsAt,
  };

  if (socket) {
    socket.emit("room:state", payload);
    return;
  }

  io.to(getRoomChannel(room.id)).emit("room:state", payload);
}

function emitAdminSnapshot(io, room, socket = null) {
  const payload = {
    roomId: room.id,
    players: getVisiblePlayers(room),
    status: room.status,
    currentQuestionIndex: room.currentQuestionIndex,
    totalQuestions: room.questions.length,
    canStart: canStartGame(room),
    readyCount: room.players.filter((player) => player.isReady).length,
    phaseEndsAt: room.phaseEndsAt,
  };

  if (socket) {
    socket.emit("admin:state", payload);
    return;
  }

  io.to(getAdminChannel(room.id)).emit("admin:state", payload);
}

function emitFullState(io, room, socket = null) {
  emitRoomSnapshot(io, room, socket);
  emitAdminSnapshot(io, room, socket);
}

function cleanupRoom(roomId) {
  const room = getRoom(roomId);

  if (!room) {
    return;
  }

  if (room.timer) {
    clearTimeout(room.timer);
  }

  rooms.delete(room.id);
}

function closeRoom(io, room) {
  io.to(getRoomChannel(room.id)).emit("room:closed");
  io.to(getAdminChannel(room.id)).emit("room:closed", { roomId: room.id });
  cleanupRoom(room.id);
}

function listRooms() {
  return [...rooms.values()]
    .map((room) => ({
      roomId: room.id,
      status: room.status,
      playerCount: room.players.length,
      readyCount: room.players.filter((player) => player.isReady).length,
      adminCount: room.admins.length,
      currentQuestionIndex: room.currentQuestionIndex,
      totalQuestions: room.questions.length,
    }))
    .sort((left, right) => left.roomId.localeCompare(right.roomId));
}

function closeRoomById(io, roomId) {
  const room = getRoom(roomId);

  if (!room) {
    return false;
  }

  closeRoom(io, room);
  return true;
}

function finishGame(io, room) {
  room.status = "finished";
  room.phaseEndsAt = null;

  const payload = {
    leaderboard: getLeaderboard(room),
  };

  io.to(getRoomChannel(room.id)).emit("game:end", payload);
  io.to(getAdminChannel(room.id)).emit("game:end", payload);

  emitFullState(io, room);
}

function startRulesPhase(io, room) {
  if (room.timer) {
    clearTimeout(room.timer);
  }

  room.status = "rules";
  room.phaseEndsAt = Date.now() + RULES_SCREEN_MS;

  const payload = {
    endsAt: room.phaseEndsAt,
    durationMs: RULES_SCREEN_MS,
  };

  io.to(getRoomChannel(room.id)).emit("rules:show", payload);
  io.to(getAdminChannel(room.id)).emit("rules:show", payload);
  emitFullState(io, room);

  room.timer = setTimeout(() => {
    advanceToQuestion(io, room);
  }, RULES_SCREEN_MS);
}

function advanceToQuestion(io, room) {
  room.currentQuestionIndex += 1;

  if (room.currentQuestionIndex >= room.questions.length) {
    finishGame(io, room);
    return;
  }

  const question = room.questions[room.currentQuestionIndex];
  room.answers = {};
  room.questionStartedAt = Date.now();
  room.status = "question";
  room.phaseEndsAt = room.questionStartedAt + QUESTION_TIME_LIMIT_MS;

  const payload = {
    questionIndex: room.currentQuestionIndex,
    totalQuestions: room.questions.length,
    question: sanitizeQuestionForClient(question),
    endsAt: room.phaseEndsAt,
    durationMs: QUESTION_TIME_LIMIT_MS,
  };

  io.to(getRoomChannel(room.id)).emit("question:send", payload);
  io.to(getAdminChannel(room.id)).emit("question:send", payload);

  emitFullState(io, room);

  room.timer = setTimeout(() => {
    finishQuestion(io, room);
  }, QUESTION_TIME_LIMIT_MS);
}

function finishQuestion(io, room) {
  if (room.status !== "question") {
    return;
  }

  if (room.timer) {
    clearTimeout(room.timer);
    room.timer = null;
  }

  room.phaseEndsAt = null;

  const question = room.questions[room.currentQuestionIndex];
  const correctAnswerIndex = getCorrectAnswerIndex(question);
  Object.values(room.answers).forEach((answer) => {
    const isCorrect = answer.answerIndex === correctAnswerIndex;
    const pointsEarned = isCorrect ? CORRECT_ANSWER_POINTS : 0;

    answer.isCorrect = isCorrect;
    answer.pointsEarned = pointsEarned;

    const player = room.players.find((entry) => entry.id === answer.playerId);

    if (player) {
      player.score += pointsEarned;
    }
  });

  if (room.currentQuestionIndex + 1 >= room.questions.length) {
    finishGame(io, room);
    return;
  }

  startQuestionTransition(io, room);
}

function handleAdminJoin(io, socket, payload) {
  const roomId = normalizeRoomId(payload?.roomId);

  if (!roomId) {
    emitError(socket, "Room introuvable.");
    return;
  }

  const room = createRoom(roomId);

  room.admins = room.admins.filter((admin) => admin.id !== socket.id);
  room.admins.push({ id: socket.id });

  socket.data.role = "admin";
  socket.data.roomId = room.id;
  socket.join(getRoomChannel(room.id));
  socket.join(getAdminChannel(room.id));

  socket.emit("admin:joined", { roomId: room.id });
  emitFullState(io, room, socket);
}

function handleRoomStatusRequest(io, socket, payload) {
  const room = getRoom(payload?.roomId);
  socket.emit("room:status", {
    roomId: normalizeRoomId(payload?.roomId),
    ...getRoomStatus(room),
  });
}

function handleRoomJoin(io, socket, payload) {
  const room = getRoom(payload?.roomId);
  const nickname = payload?.nickname?.trim();

  if (!nickname) {
    emitError(socket, "Le pseudo est obligatoire.");
    return;
  }

  if (!room) {
    emitError(socket, "Cette room n'existe pas.");
    return;
  }

  if (room.status !== "lobby") {
    emitError(socket, "La partie a deja commence.");
    return;
  }

  if (room.players.some((player) => player.name.toLowerCase() === nickname.toLowerCase())) {
    emitError(socket, "Ce pseudo est deja pris.");
    return;
  }

  const player = {
    id: socket.id,
    name: nickname,
    score: 0,
    isReady: false,
    avatar: createDefaultAvatar(socket.id),
  };

  room.players.push(player);

  socket.data.role = "player";
  socket.data.roomId = room.id;
  socket.data.nickname = nickname;
  socket.join(getRoomChannel(room.id));

  socket.emit("room:join", {
    playerId: socket.id,
    roomId: room.id,
  });

  emitFullState(io, room);
}

function handleGameStart(io, socket) {
  const room = getRoom(socket.data.roomId);

  if (!room) {
    emitError(socket, "Aucune room active.");
    return;
  }

  if (socket.data.role !== "admin") {
    emitError(socket, "Seul l'admin peut lancer la partie.");
    return;
  }

  if (room.status !== "lobby") {
    emitError(socket, "La partie a deja commence.");
    return;
  }

  if (!canStartGame(room)) {
    emitError(socket, "Tous les joueurs doivent etre prets avant le lancement.");
    return;
  }

  startRulesPhase(io, room);
}

function handleReadyToggle(io, socket, payload) {
  const room = getRoom(socket.data.roomId);

  if (!room) {
    emitError(socket, "Aucune room active.");
    return;
  }

  if (room.status !== "lobby") {
    emitError(socket, "Le statut pret ne peut etre change que dans le lobby.");
    return;
  }

  const player = room.players.find((entry) => entry.id === socket.id);

  if (!player) {
    emitError(socket, "Joueur introuvable.");
    return;
  }

  player.isReady = Boolean(payload?.isReady);
  emitFullState(io, room);
}

function handleAvatarUpdate(io, socket, payload) {
  const room = getRoom(socket.data.roomId);

  if (!room) {
    emitError(socket, "Aucune room active.");
    return;
  }

  if (room.status !== "lobby") {
    emitError(socket, "L avatar ne peut etre change que dans le lobby.");
    return;
  }

  const player = room.players.find((entry) => entry.id === socket.id);

  if (!player) {
    emitError(socket, "Joueur introuvable.");
    return;
  }

  player.avatar = sanitizeAvatar(payload, socket.id);
  emitFullState(io, room);
}

function handleAnswerSubmit(io, socket, payload) {
  const room = getRoom(socket.data.roomId);

  if (!room || room.status !== "question") {
    emitError(socket, "Aucune question active pour le moment.");
    return;
  }

  if (socket.data.role !== "player") {
    emitError(socket, "Seuls les joueurs peuvent repondre.");
    return;
  }

  const selectedAnswerIndex = Number(payload?.answerIndex);
  const currentQuestion = room.questions[room.currentQuestionIndex];

  if (
    !Number.isInteger(selectedAnswerIndex) ||
    selectedAnswerIndex < 0 ||
    selectedAnswerIndex >= currentQuestion.answers.length
  ) {
    emitError(socket, "Reponse invalide.");
    return;
  }

  room.answers[socket.id] = {
    playerId: socket.id,
    name: socket.data.nickname,
    answerIndex: selectedAnswerIndex,
  };

  socket.emit("answer:selected", {
    accepted: true,
    answerIndex: selectedAnswerIndex,
  });

  const countPayload = {
    count: Object.keys(room.answers).length,
    totalPlayers: room.players.length,
  };

  io.to(getRoomChannel(room.id)).emit("answer:count", countPayload);
  io.to(getAdminChannel(room.id)).emit("answer:count", countPayload);
  emitFullState(io, room);
}

function removeSocketFromRoom(io, socket, room) {
  if (!room) {
    return;
  }

  if (socket.data.role === "admin") {
    room.admins = room.admins.filter((admin) => admin.id !== socket.id);
    emitAdminSnapshot(io, room);
    return;
  }

  room.players = room.players.filter((player) => player.id !== socket.id);
  delete room.answers[socket.id];

  emitFullState(io, room);
}

function startQuestionTransition(io, room) {
  if (room.timer) {
    clearTimeout(room.timer);
  }

  room.status = "result";
  room.phaseEndsAt = Date.now() + QUESTION_TRANSITION_MS;

  const hasNextQuestion = room.currentQuestionIndex + 1 < room.questions.length;
  const payload = {
    endsAt: room.phaseEndsAt,
    durationMs: QUESTION_TRANSITION_MS,
    nextQuestionIndex: hasNextQuestion ? room.currentQuestionIndex + 1 : null,
    totalQuestions: room.questions.length,
  };

  io.to(getRoomChannel(room.id)).emit("question:transition", payload);
  io.to(getAdminChannel(room.id)).emit("question:transition", payload);

  emitFullState(io, room);

  room.timer = setTimeout(() => {
    advanceToQuestion(io, room);
  }, QUESTION_TRANSITION_MS);
}

function registerSocketHandlers(io) {
  io.on("connection", (socket) => {
    socket.on("time:sync", (ack) => {
      if (typeof ack === "function") {
        ack({ serverTime: Date.now() });
      }
    });
    socket.on("admin:join", (payload) => handleAdminJoin(io, socket, payload));
    socket.on("room:status", (payload) => handleRoomStatusRequest(io, socket, payload));
    socket.on("room:join", (payload) => handleRoomJoin(io, socket, payload));
    socket.on("game:start", () => handleGameStart(io, socket));
    socket.on("player:ready", (payload) => handleReadyToggle(io, socket, payload));
    socket.on("player:avatar", (payload) => handleAvatarUpdate(io, socket, payload));
    socket.on("answer:submit", (payload) => handleAnswerSubmit(io, socket, payload));
    socket.on("disconnect", () => {
      const room = getRoom(socket.data.roomId);
      removeSocketFromRoom(io, socket, room);
    });
  });
}

module.exports = {
  closeRoomById,
  createRoom,
  listRooms,
  registerSocketHandlers,
};
