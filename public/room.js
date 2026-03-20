const socket = io();

const roomId = window.location.pathname.split("/").filter(Boolean).pop() || "";

const state = {
  roomId,
  playerId: null,
  nickname: "",
  players: [],
  canStart: false,
  currentQuestion: null,
  selectedAnswerIndex: null,
  timerInterval: null,
  roomStatus: "missing",
  pendingAvatar: null,
  roomExists: false,
  roomJoinable: false,
  serverTimeOffsetMs: 0,
};

const AVATAR_STYLE = "fun-emoji";
const DICEBEAR_BASE_URL = "https://api.dicebear.com/9.x";

const errorBanner = document.getElementById("errorBanner");
const lobbyView = document.getElementById("lobbyView");
const gameView = document.getElementById("gameView");
const roomIdLabel = document.getElementById("roomIdLabel");
const roomStatusCopy = document.getElementById("roomStatusCopy");
const joinCard = document.getElementById("joinCard");
const lobbyCard = document.getElementById("lobbyCard");
const nicknameInput = document.getElementById("nicknameInput");
const enterRoomButton = document.getElementById("enterRoomButton");
const readyCountLabel = document.getElementById("readyCountLabel");
const playerNameLabel = document.getElementById("playerNameLabel");
const selectedAvatarImage = document.getElementById("selectedAvatarImage");
const shuffleAvatarsButton = document.getElementById("shuffleAvatarsButton");
const playersList = document.getElementById("playersList");
const readyToggleButton = document.getElementById("readyToggleButton");

const questionSection = document.getElementById("questionSection");
const resultSection = document.getElementById("resultSection");
const endSection = document.getElementById("endSection");
const questionIndexLabel = document.getElementById("questionIndexLabel");
const totalQuestionsLabel = document.getElementById("totalQuestionsLabel");
const timerPill = document.querySelector(".timer-pill");
const timerLabel = document.getElementById("timerLabel");
const questionPrompt = document.getElementById("questionPrompt");
const answersContainer = document.getElementById("answersContainer");
const answerStateLabel = document.getElementById("answerStateLabel");
const answerCountLabel = document.getElementById("answerCountLabel");
const correctAnswerLabel = document.getElementById("correctAnswerLabel");
const podiumContainer = document.getElementById("podiumContainer");
const restTableWrapper = document.getElementById("restTableWrapper");
const restLeaderboardBody = document.getElementById("restLeaderboardBody");

function showError(message) {
  errorBanner.textContent = message;
  errorBanner.classList.remove("hidden");

  window.clearTimeout(showError.timeoutId);
  showError.timeoutId = window.setTimeout(() => {
    errorBanner.classList.add("hidden");
  }, 4000);
}

function getServerNow() {
  return Date.now() + state.serverTimeOffsetMs;
}

function syncServerClock(sampleCount = 3) {
  if (!socket.connected) {
    return;
  }

  const offsets = [];
  let completed = 0;

  function collectSample() {
    const startedAt = Date.now();

    socket.emit("time:sync", (payload) => {
      const receivedAt = Date.now();
      const roundTripMs = receivedAt - startedAt;
      const serverTime = Number(payload?.serverTime);

      if (Number.isFinite(serverTime)) {
        offsets.push(serverTime + roundTripMs / 2 - receivedAt);
      }

      completed += 1;

      if (completed >= sampleCount) {
        if (offsets.length > 0) {
          offsets.sort((left, right) => left - right);
          state.serverTimeOffsetMs = offsets[Math.floor(offsets.length / 2)];
        }
        return;
      }

      window.setTimeout(collectSample, 120);
    });
  }

  collectSample();
}

function getCurrentPlayer() {
  return state.players.find((player) => player.id === state.playerId) || null;
}

function createAvatarSeed() {
  if (window.crypto?.randomUUID) {
    return window.crypto.randomUUID();
  }

  return `avatar-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function getAvatarUrl(avatar, size = 96) {
  if (!avatar?.style || !avatar?.seed) {
    return "";
  }

  const params = new URLSearchParams({
    seed: avatar.seed,
    size: String(size),
    radius: "24",
    backgroundType: "gradientLinear",
  });

  return `${DICEBEAR_BASE_URL}/${avatar.style}/svg?${params.toString()}`;
}

function createAvatarChoice(style = AVATAR_STYLE) {
  return {
    style,
    seed: createAvatarSeed(),
  };
}

function emitAvatarSelection(avatar) {
  if (!state.playerId) {
    return;
  }

  socket.emit("player:avatar", avatar);
}

function renderAvatarPicker() {
  const currentPlayer = getCurrentPlayer();
  const currentAvatar = currentPlayer?.avatar || state.pendingAvatar;
  selectedAvatarImage.src = getAvatarUrl(currentAvatar, 128);
}

function resetGamePanels() {
  questionSection.classList.add("hidden");
  resultSection.classList.add("hidden");
  endSection.classList.add("hidden");
  timerPill.classList.remove("timer-pill-danger");
}

function renderShell() {
  const gameActive =
    state.roomStatus === "question" ||
    state.roomStatus === "result" ||
    state.roomStatus === "finished";

  lobbyView.classList.toggle("hidden", gameActive);
  gameView.classList.toggle("hidden", !gameActive);
}

function renderPlayers() {
  playersList.innerHTML = "";

  state.players.forEach((player) => {
    const item = document.createElement("li");
    const badges = [
      player.isReady
        ? '<span class="player-status player-status-ready">pret</span>'
        : '<span class="player-status player-status-waiting">en attente</span>',
    ];

    if (player.id === state.playerId) {
      badges.push('<span class="player-status player-status-self">toi</span>');
    }

    item.className = "player-row";
    item.innerHTML = `
      <div class="player-avatar">
        <img src="${getAvatarUrl(player.avatar, 64)}" alt="" />
      </div>
      <div class="player-main">
        <strong>${player.name}</strong>
        <div class="player-status-row">${badges.join("")}</div>
      </div>
    `;
    playersList.appendChild(item);
  });
}

function renderLobby() {
  const currentPlayer = getCurrentPlayer();
  const joined = Boolean(currentPlayer);
  const readyPlayers = state.players.filter((player) => player.isReady).length;

  roomIdLabel.textContent = state.roomId || "-";

  if (!state.roomExists) {
    roomStatusCopy.textContent = "Cette room n'existe pas ou a deja ete fermee.";
  } else if (!state.roomJoinable && !joined) {
    roomStatusCopy.textContent = "La partie est deja lancee. Cette salle d'attente est fermee.";
  } else {
    roomStatusCopy.textContent =
      "Choisis ton avatar, entre ton pseudo puis passe en mode pret.";
  }

  joinCard.classList.toggle("hidden", joined);
  lobbyCard.classList.toggle("hidden", !joined);

  if (!joined) {
    enterRoomButton.disabled = !state.roomExists || !state.roomJoinable;
    return;
  }

  playerNameLabel.textContent = currentPlayer.name;
  readyCountLabel.textContent = `${readyPlayers}/${state.players.length}`;

  if (!currentPlayer.avatar && !state.pendingAvatar) {
    state.pendingAvatar = createAvatarChoice();
    emitAvatarSelection(state.pendingAvatar);
  }

  renderAvatarPicker();
  renderPlayers();

  readyToggleButton.textContent = currentPlayer.isReady ? "Je ne suis plus pret" : "Je suis pret";
}

function renderFinalLeaderboard(leaderboard) {
  podiumContainer.innerHTML = "";
  restLeaderboardBody.innerHTML = "";

  const topThree = leaderboard.slice(0, 3);
  const podiumOrder = [1, 0, 2];

  podiumOrder.forEach((index) => {
    const entry = topThree[index];

    if (!entry) {
      return;
    }

    const card = document.createElement("article");
    card.className = `podium-card rank-${entry.rank}`;
    card.innerHTML = `
      <div class="player-avatar podium-avatar">
        <img src="${getAvatarUrl(entry.avatar, 88)}" alt="" />
      </div>
      <div class="podium-place">${entry.rank}</div>
      <div class="podium-name">${entry.name}</div>
      <div class="podium-score">${entry.score} pts</div>
    `;
    podiumContainer.appendChild(card);
  });

  const remainingPlayers = leaderboard.slice(3);
  restTableWrapper.classList.toggle("hidden", remainingPlayers.length === 0);

  remainingPlayers.forEach((entry) => {
    const row = document.createElement("tr");
    row.innerHTML = `
      <td>${entry.rank}</td>
      <td class="leaderboard-name-cell">
        <span class="player-avatar player-avatar-inline">
          <img src="${getAvatarUrl(entry.avatar, 48)}" alt="" />
        </span>
        <span>${entry.name}</span>
      </td>
      <td>${entry.score} pts</td>
    `;
    restLeaderboardBody.appendChild(row);
  });
}

function startCountdown(endsAt) {
  window.clearInterval(state.timerInterval);

  function updateTimer() {
    const remainingMs = Math.max(0, endsAt - getServerNow());
    const remainingSeconds = Math.ceil(remainingMs / 1000);

    timerLabel.textContent = String(remainingSeconds);
    timerPill.classList.toggle("timer-pill-danger", remainingSeconds <= 5 && remainingMs > 0);
  }

  updateTimer();
  state.timerInterval = window.setInterval(updateTimer, 250);
}

function renderQuestion(questionIndex, totalQuestions, question, endsAt) {
  resetGamePanels();
  questionSection.classList.remove("hidden");

  state.currentQuestion = question;
  state.selectedAnswerIndex = null;
  questionIndexLabel.textContent = String(questionIndex + 1);
  totalQuestionsLabel.textContent = String(totalQuestions);
  questionPrompt.textContent = question.prompt;
  answerStateLabel.textContent = "Clique pour selectionner ta reponse. Tu peux la changer avant la fin du chrono.";
  answerCountLabel.textContent = "";
  answersContainer.innerHTML = "";
  const answerLetters = ["A", "B", "C", "D"];

  question.answers.forEach((answer, index) => {
    const button = document.createElement("button");
    button.type = "button";
    button.classList.add(`answer-choice-${index + 1}`);
    button.innerHTML = `
      <span class="answer-choice-letter">${answerLetters[index] || index + 1}</span>
      <span class="answer-choice-text">${answer}</span>
    `;
    button.addEventListener("click", () => {
      state.selectedAnswerIndex = index;
      Array.from(answersContainer.querySelectorAll("button")).forEach((entry, entryIndex) => {
        entry.classList.toggle("answer-choice-selected", entryIndex === index);
      });
      answerStateLabel.textContent =
        "Reponse selectionnee. Tu peux encore changer d'avis avant la fin du chrono.";
      socket.emit("answer:submit", { answerIndex: index });
    });

    answersContainer.appendChild(button);
  });

  renderShell();
  startCountdown(endsAt);
}

enterRoomButton.addEventListener("click", () => {
  const nickname = nicknameInput.value.trim();

  if (!nickname) {
    showError("Entre un pseudo.");
    return;
  }

  state.nickname = nickname;
  socket.emit("room:join", { roomId: state.roomId, nickname });
});

readyToggleButton.addEventListener("click", () => {
  const currentPlayer = getCurrentPlayer();

  if (!currentPlayer) {
    return;
  }

  socket.emit("player:ready", { isReady: !currentPlayer.isReady });
});

shuffleAvatarsButton.addEventListener("click", () => {
  state.pendingAvatar = createAvatarChoice();
  renderAvatarPicker();
  emitAvatarSelection(state.pendingAvatar);
});

socket.on("connect", () => {
  syncServerClock();
  socket.emit("room:status", { roomId: state.roomId });
});

socket.on("error:message", (payload) => {
  showError(payload.message);
});

socket.on("room:status", (payload) => {
  state.roomId = payload.roomId || state.roomId;
  state.roomExists = payload.exists;
  state.roomJoinable = payload.joinable;
  state.roomStatus = payload.status;
  renderShell();
  renderLobby();
});

socket.on("room:join", (payload) => {
  state.playerId = payload.playerId;
  state.roomId = payload.roomId;
  playerNameLabel.textContent = state.nickname;
  nicknameInput.value = state.nickname;
  renderLobby();
});

socket.on("room:state", (payload) => {
  state.roomId = payload.roomId;
  state.players = payload.players;
  state.canStart = payload.canStart;
  state.roomStatus = payload.status;
  state.roomExists = true;
  state.roomJoinable = payload.status === "lobby";

  renderShell();
  renderLobby();
});

socket.on("room:closed", () => {
  state.playerId = null;
  state.players = [];
  state.canStart = false;
  state.roomExists = false;
  state.roomJoinable = false;
  state.roomStatus = "missing";
  state.currentQuestion = null;
  state.pendingAvatar = null;

  window.clearInterval(state.timerInterval);
  resetGamePanels();
  renderShell();
  renderLobby();
});

socket.on("question:send", (payload) => {
  syncServerClock(1);
  state.roomStatus = "question";
  renderQuestion(
    payload.questionIndex,
    payload.totalQuestions,
    payload.question,
    payload.endsAt
  );
});

socket.on("answer:selected", (payload) => {
  state.selectedAnswerIndex = payload.answerIndex;
  answerStateLabel.textContent =
    "Reponse selectionnee. Elle sera validee a la fin du chrono.";
});

socket.on("answer:count", (payload) => {
  answerCountLabel.textContent = `${payload.count}/${payload.totalPlayers} joueurs ont repondu`;
});

socket.on("game:end", (payload) => {
  state.roomStatus = "finished";
  resetGamePanels();
  endSection.classList.remove("hidden");
  window.clearInterval(state.timerInterval);
  renderFinalLeaderboard(payload.leaderboard);
  renderShell();
});

renderShell();
state.pendingAvatar = createAvatarChoice();
renderLobby();
