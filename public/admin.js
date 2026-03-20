const socket = io();

const state = {
  roomId: "",
  players: [],
  canStart: false,
  roomStatus: "idle",
  timerInterval: null,
  currentQuestion: null,
  serverTimeOffsetMs: 0,
};

const errorBanner = document.getElementById("errorBanner");
const createRoomButton = document.getElementById("createRoomButton");
const createRoomCard = document.getElementById("createRoomCard");
const roomLiveCard = document.getElementById("roomLiveCard");
const roomIdLabel = document.getElementById("roomIdLabel");
const qrCodeImage = document.getElementById("qrCodeImage");
const connectedCountLabel = document.getElementById("connectedCountLabel");
const readyCountLabel = document.getElementById("readyCountLabel");
const playersList = document.getElementById("playersList");
const participantHint = document.getElementById("participantHint");
const startGameButton = document.getElementById("startGameButton");

const gameView = document.getElementById("gameView");
const questionSection = document.getElementById("questionSection");
const resultSection = document.getElementById("resultSection");
const endSection = document.getElementById("endSection");
const questionIndexLabel = document.getElementById("questionIndexLabel");
const totalQuestionsLabel = document.getElementById("totalQuestionsLabel");
const timerPill = document.querySelector(".timer-pill");
const timerLabel = document.getElementById("timerLabel");
const questionPrompt = document.getElementById("questionPrompt");
const answerCountLabel = document.getElementById("answerCountLabel");
const correctAnswerLabel = document.getElementById("correctAnswerLabel");
const podiumContainer = document.getElementById("podiumContainer");
const restTableWrapper = document.getElementById("restTableWrapper");
const restLeaderboardBody = document.getElementById("restLeaderboardBody");

const DICEBEAR_BASE_URL = "https://api.dicebear.com/9.x";

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

function resetGamePanels() {
  questionSection.classList.add("hidden");
  resultSection.classList.add("hidden");
  endSection.classList.add("hidden");
  timerPill.classList.remove("timer-pill-danger");
}

function renderPlayers() {
  playersList.innerHTML = "";

  if (state.players.length === 0) {
    participantHint.textContent = "Aucun joueur n'a encore rejoint la room.";
    return;
  }

  participantHint.textContent = "Les joueurs apparaissent ici en direct avec leur statut.";

  state.players.forEach((player) => {
    const item = document.createElement("li");
    item.className = "player-row";
    item.innerHTML = `
      <div class="player-avatar">
        <img src="${getAvatarUrl(player.avatar, 64)}" alt="" />
      </div>
      <div class="player-main">
        <strong>${player.name}</strong>
        <div class="player-status-row">
          <span class="player-status ${
            player.isReady ? "player-status-ready" : "player-status-waiting"
          }">
            ${player.isReady ? "pret" : "en attente"}
          </span>
          <span class="player-status player-status-self">${player.score} pts</span>
        </div>
      </div>
    `;
    playersList.appendChild(item);
  });
}

function renderAdminCard() {
  const joined = Boolean(state.roomId);

  createRoomCard.classList.toggle("hidden", joined);
  roomLiveCard.classList.toggle("hidden", !joined);

  if (!joined) {
    return;
  }

  const readyPlayers = state.players.filter((player) => player.isReady).length;
  roomIdLabel.textContent = state.roomId;
  connectedCountLabel.textContent = String(state.players.length);
  readyCountLabel.textContent = `${readyPlayers}/${state.players.length}`;
  startGameButton.disabled = !state.canStart;
  renderPlayers();
}

function renderShell() {
  const gameActive =
    state.roomStatus === "question" ||
    state.roomStatus === "result" ||
    state.roomStatus === "finished";

  gameView.classList.toggle("hidden", !gameActive);
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

createRoomButton.addEventListener("click", async () => {
  createRoomButton.disabled = true;

  try {
    const response = await fetch("/api/rooms", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({}),
    });

    if (!response.ok) {
      throw new Error("Impossible de creer la room.");
    }

    const payload = await response.json();
    state.roomId = payload.roomId;
    qrCodeImage.src = payload.qrCodeDataUrl;
    socket.emit("admin:join", { roomId: payload.roomId });
    renderAdminCard();
  } catch (error) {
    showError(error.message);
    createRoomButton.disabled = false;
  }
});

startGameButton.addEventListener("click", () => {
  socket.emit("game:start");
});

socket.on("error:message", (payload) => {
  showError(payload.message);
});

socket.on("admin:joined", (payload) => {
  state.roomId = payload.roomId;
  createRoomButton.disabled = false;
  syncServerClock();
  renderAdminCard();
});

socket.on("admin:state", (payload) => {
  state.roomId = payload.roomId;
  state.players = payload.players;
  state.canStart = payload.canStart;
  state.roomStatus = payload.status;
  renderAdminCard();
  renderShell();
});

socket.on("question:send", (payload) => {
  syncServerClock(1);
  state.roomStatus = "question";
  state.currentQuestion = payload.question;
  resetGamePanels();
  questionSection.classList.remove("hidden");
  questionIndexLabel.textContent = String(payload.questionIndex + 1);
  totalQuestionsLabel.textContent = String(payload.totalQuestions);
  questionPrompt.textContent = payload.question.prompt;
  answerCountLabel.textContent = "";
  renderShell();
  startCountdown(payload.endsAt);
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

socket.on("room:closed", () => {
  state.roomId = "";
  state.players = [];
  state.canStart = false;
  state.roomStatus = "idle";
  qrCodeImage.src = "";
  window.clearInterval(state.timerInterval);
  resetGamePanels();
  renderAdminCard();
  renderShell();
  showError("La room a ete fermee.");
});

socket.on("connect", () => {
  syncServerClock();
});

renderAdminCard();
renderShell();
