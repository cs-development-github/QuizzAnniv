const crypto = require("crypto");

const {
  loadQuestions,
  sanitizeQuestionForClient,
  getCorrectAnswerIndex,
} = require("../utils/questions");

const QUESTION_TIME_LIMIT_MS = 20000;
const BASE_POINTS = 100;
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

  const payload = {
    leaderboard: getLeaderboard(room),
  };

  io.to(getRoomChannel(room.id)).emit("game:end", payload);
  io.to(getAdminChannel(room.id)).emit("game:end", payload);

  emitFullState(io, room);
}

function calculateSpeedBonus(answeredAt, questionStartedAt) {
  const elapsedMs = Math.max(0, answeredAt - questionStartedAt);
  const remainingRatio = Math.max(0, QUESTION_TIME_LIMIT_MS - elapsedMs) / QUESTION_TIME_LIMIT_MS;

  return Math.round(remainingRatio * 50);
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

  const payload = {
    questionIndex: room.currentQuestionIndex,
    totalQuestions: room.questions.length,
    question: sanitizeQuestionForClient(question),
    endsAt: room.questionStartedAt + QUESTION_TIME_LIMIT_MS,
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

  const question = room.questions[room.currentQuestionIndex];
  const correctAnswerIndex = getCorrectAnswerIndex(question);

  room.status = "result";

  const payload = {
    correctAnswerIndex,
    leaderboard: getLeaderboard(room),
    answers: Object.values(room.answers),
  };

  io.to(getRoomChannel(room.id)).emit("question:result", payload);
  io.to(getAdminChannel(room.id)).emit("question:result", payload);

  emitFullState(io, room);

  room.timer = setTimeout(() => {
    advanceToQuestion(io, room);
  }, 5000);
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

  advanceToQuestion(io, room);
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

  if (room.answers[socket.id]) {
    emitError(socket, "Une seule reponse par question.");
    return;
  }

  const selectedAnswerIndex = Number(payload?.answerIndex);
  const currentQuestion = room.questions[room.currentQuestionIndex];

  if (!Number.isInteger(selectedAnswerIndex) || selectedAnswerIndex < 0 || selectedAnswerIndex > 3) {
    emitError(socket, "Reponse invalide.");
    return;
  }

  const answeredAt = Date.now();
  const correctAnswerIndex = getCorrectAnswerIndex(currentQuestion);
  const isCorrect = selectedAnswerIndex === correctAnswerIndex;
  const speedBonus = isCorrect ? calculateSpeedBonus(answeredAt, room.questionStartedAt) : 0;
  const pointsEarned = isCorrect ? BASE_POINTS + speedBonus : 0;

  room.answers[socket.id] = {
    playerId: socket.id,
    name: socket.data.nickname,
    answerIndex: selectedAnswerIndex,
    isCorrect,
    pointsEarned,
    answeredAt,
  };

  const player = room.players.find((entry) => entry.id === socket.id);

  if (player) {
    player.score += pointsEarned;
  }

  socket.emit("answer:submitted", {
    accepted: true,
    isCorrect,
    pointsEarned,
  });

  const everyoneAnswered = room.players.every((playerEntry) => room.answers[playerEntry.id]);

  if (everyoneAnswered) {
    finishQuestion(io, room);
    return;
  }

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

    if (room.admins.length === 0) {
      closeRoom(io, room);
      return;
    }

    emitAdminSnapshot(io, room);
    return;
  }

  room.players = room.players.filter((player) => player.id !== socket.id);
  delete room.answers[socket.id];

  if (room.players.length === 0) {
    closeRoom(io, room);
    return;
  }

  emitFullState(io, room);
}

function registerSocketHandlers(io) {
  io.on("connection", (socket) => {
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
