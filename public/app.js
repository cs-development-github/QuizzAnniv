const socket = io();

const state = {
  playerId: null,
  hostId: null,
  nickname: "",
  players: [],
  canStart: false,
  currentQuestion: null,
  hasAnswered: false,
  timerInterval: null,
  sessionExists: false,
  sessionJoinable: false,
  roomStatus: "idle",
  pendingAvatar: null,
};

const AVATAR_STYLE = "fun-emoji";
const DICEBEAR_BASE_URL = "https://api.dicebear.com/9.x";

const errorBanner = document.getElementById("errorBanner");

const lobbyView = document.getElementById("lobbyView");
const gameView = document.getElementById("gameView");

const joinCard = document.getElementById("joinCard");
const lobbyCard = document.getElementById("lobbyCard");
const nicknameInput = document.getElementById("nicknameInput");
const enterRoomButton = document.getElementById("enterRoomButton");
const adminSummary = document.getElementById("adminSummary");
const connectedCountLabel = document.getElementById("connectedCountLabel");
const readyCountLabel = document.getElementById("readyCountLabel");
const playerNameLabel = document.getElementById("playerNameLabel");
const selectedAvatarImage = document.getElementById("selectedAvatarImage");
const shuffleAvatarsButton = document.getElementById("shuffleAvatarsButton");
const playersList = document.getElementById("playersList");
const readyToggleButton = document.getElementById("readyToggleButton");
const startGameButton = document.getElementById("startGameButton");

const questionSection = document.getElementById("questionSection");
const resultSection = document.getElementById("resultSection");
const endSection = document.getElementById("endSection");
const questionIndexLabel = document.getElementById("questionIndexLabel");
const totalQuestionsLabel = document.getElementById("totalQuestionsLabel");
const timerLabel = document.getElementById("timerLabel");
const questionPrompt = document.getElementById("questionPrompt");
const answersContainer = document.getElementById("answersContainer");
const answerStateLabel = document.getElementById("answerStateLabel");
const answerCountLabel = document.getElementById("answerCountLabel");
const correctAnswerLabel = document.getElementById("correctAnswerLabel");
const leaderboardList = document.getElementById("leaderboardList");
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

function isHost() {
  return state.playerId && state.playerId === state.hostId;
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
    const badges = [];

    if (player.id === state.hostId) {
      badges.push('<span class="player-status player-status-host">admin</span>');
    } else {
      badges.push(
        player.isReady
          ? '<span class="player-status player-status-ready">pret</span>'
          : '<span class="player-status player-status-waiting">en attente</span>'
      );
    }

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

  joinCard.classList.toggle("hidden", joined);
  lobbyCard.classList.toggle("hidden", !joined);

  if (!joined) {
    enterRoomButton.disabled = !state.sessionJoinable && state.sessionExists;
    return;
  }

  playerNameLabel.textContent = currentPlayer.name;
  if (!currentPlayer.avatar && !state.pendingAvatar) {
    state.pendingAvatar = createAvatarChoice();
    emitAvatarSelection(state.pendingAvatar);
  }
  renderAvatarPicker();
  renderPlayers();

  adminSummary.classList.toggle("hidden", !isHost());
  connectedCountLabel.textContent = String(state.players.length);
  readyCountLabel.textContent = `${readyPlayers}/${state.players.length}`;

  readyToggleButton.classList.toggle("hidden", isHost());
  startGameButton.classList.toggle("hidden", !isHost());

  if (isHost()) {
    startGameButton.disabled = !state.canStart;
    return;
  }

  readyToggleButton.textContent = currentPlayer.isReady
    ? "Je ne suis plus pret"
    : "Je suis pret";
}

function renderLeaderboard(targetElement, leaderboard) {
  targetElement.innerHTML = "";

  leaderboard.forEach((entry) => {
    const item = document.createElement("li");
    item.textContent = `#${entry.rank} - ${entry.name} - ${entry.score} pts`;
    targetElement.appendChild(item);
  });
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
    const remainingMs = Math.max(0, endsAt - Date.now());
    timerLabel.textContent = String(Math.ceil(remainingMs / 1000));
  }

  updateTimer();
  state.timerInterval = window.setInterval(updateTimer, 250);
}

function renderQuestion(questionIndex, totalQuestions, question, endsAt) {
  resetGamePanels();
  questionSection.classList.remove("hidden");

  state.currentQuestion = question;
  state.hasAnswered = false;
  questionIndexLabel.textContent = String(questionIndex + 1);
  totalQuestionsLabel.textContent = String(totalQuestions);
  questionPrompt.textContent = question.prompt;
  answerStateLabel.textContent = "";
  answerCountLabel.textContent = "";
  answersContainer.innerHTML = "";

  question.answers.forEach((answer, index) => {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = answer;
    button.addEventListener("click", () => {
      if (state.hasAnswered) {
        return;
      }

      state.hasAnswered = true;
      answerStateLabel.textContent = "Reponse envoyee. Suspense...";

      Array.from(answersContainer.querySelectorAll("button")).forEach((entry) => {
        entry.disabled = true;
      });

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

  if (!state.sessionExists) {
    socket.emit("room:create", { nickname });
    return;
  }

  socket.emit("room:join", { nickname });
});

startGameButton.addEventListener("click", () => {
  socket.emit("game:start");
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

socket.on("connect", () => {});

socket.on("disconnect", () => {});

socket.on("error:message", (payload) => {
  showError(payload.message);
});

socket.on("room:create", (payload) => {
  state.playerId = payload.playerId;
  playerNameLabel.textContent = state.nickname;
  nicknameInput.value = state.nickname;
  renderLobby();
});

socket.on("room:join", (payload) => {
  state.playerId = payload.playerId;
  playerNameLabel.textContent = state.nickname;
  nicknameInput.value = state.nickname;
  renderLobby();
});

socket.on("room:state", (payload) => {
  state.hostId = payload.hostId;
  state.players = payload.players;
  state.canStart = payload.canStart;
  state.roomStatus = payload.status;

  renderShell();
  renderLobby();
});

socket.on("room:closed", () => {
  state.playerId = null;
  state.hostId = null;
  state.players = [];
  state.canStart = false;
  state.sessionExists = false;
  state.sessionJoinable = false;
  state.roomStatus = "idle";
  state.currentQuestion = null;
  state.pendingAvatar = null;

  window.clearInterval(state.timerInterval);
  resetGamePanels();
  renderShell();
  renderLobby();
});

socket.on("session:status", (payload) => {
  state.sessionExists = payload.exists;
  state.sessionJoinable = payload.joinable;
  state.roomStatus = payload.status;

  renderShell();
  renderLobby();
});

socket.on("question:send", (payload) => {
  state.roomStatus = "question";
  renderQuestion(
    payload.questionIndex,
    payload.totalQuestions,
    payload.question,
    payload.endsAt
  );
});

socket.on("answer:submitted", (payload) => {
  answerStateLabel.textContent = payload.isCorrect
    ? `Bonne reponse ! +${payload.pointsEarned} points`
    : "Reponse envoyee. Verdict a la fin du chrono.";
});

socket.on("answer:count", (payload) => {
  answerCountLabel.textContent = `${payload.count}/${payload.totalPlayers} joueurs ont repondu`;
});

socket.on("question:result", (payload) => {
  state.roomStatus = "result";
  resetGamePanels();
  resultSection.classList.remove("hidden");
  window.clearInterval(state.timerInterval);

  if (state.currentQuestion) {
    correctAnswerLabel.textContent = `Bonne reponse : ${state.currentQuestion.answers[payload.correctAnswerIndex]}`;
  }

  renderLeaderboard(leaderboardList, payload.leaderboard);
  renderShell();
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
