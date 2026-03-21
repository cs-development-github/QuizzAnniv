const socket = io();

const state = {
  roomId: "",
  players: [],
  canStart: false,
  roomStatus: "idle",
  timerInterval: null,
  currentQuestion: null,
  serverTimeOffsetMs: 0,
  audioUnlocked: false,
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

const lobbyView = document.getElementById("lobbyView");
const gameView = document.getElementById("gameView");
const rulesSection = document.getElementById("rulesSection");
const questionSection = document.getElementById("questionSection");
const resultSection = document.getElementById("resultSection");
const endSection = document.getElementById("endSection");
const rulesTimerLabel = document.getElementById("rulesTimerLabel");
const resultTimerLabel = document.getElementById("resultTimerLabel");
const questionIndexLabel = document.getElementById("questionIndexLabel");
const totalQuestionsLabel = document.getElementById("totalQuestionsLabel");
const questionTimerPill = questionSection.querySelector(".timer-pill");
const timerLabel = document.getElementById("timerLabel");
const questionPrompt = document.getElementById("questionPrompt");
const correctAnswerLabel = document.getElementById("correctAnswerLabel");
const podiumContainer = document.getElementById("podiumContainer");
const restTableWrapper = document.getElementById("restTableWrapper");
const restLeaderboardBody = document.getElementById("restLeaderboardBody");
const waitingRoomAudio = document.getElementById("waitingRoomAudio");
const timerAudio = document.getElementById("timerAudio");

const DICEBEAR_BASE_URL = "https://api.dicebear.com/9.x";

waitingRoomAudio.volume = 0.6;
timerAudio.volume = 1;
waitingRoomAudio.load();
timerAudio.load();

function logAudio(message, details) {
  if (details === undefined) {
    console.log(`[admin-audio] ${message}`);
    return;
  }

  console.log(`[admin-audio] ${message}`, details);
}

function describeAudioState(audio) {
  return {
    src: audio.currentSrc || audio.src,
    paused: audio.paused,
    currentTime: audio.currentTime,
    readyState: audio.readyState,
    networkState: audio.networkState,
    volume: audio.volume,
    ended: audio.ended,
  };
}

function safePlay(audio) {
  logAudio("safePlay called", describeAudioState(audio));
  const playPromise = audio.play();

  if (playPromise && typeof playPromise.catch === "function") {
    playPromise
      .then(() => {
        logAudio("play resolved", describeAudioState(audio));
      })
      .catch((error) => {
        logAudio("play rejected", {
          message: error?.message,
          name: error?.name,
          audio: describeAudioState(audio),
        });
      });
  }
}

function stopAudio(audio) {
  logAudio("stopAudio called", describeAudioState(audio));
  audio.pause();
  audio.currentTime = 0;
}

function syncAudioState() {
  const shouldPlayWaitingRoom =
    state.audioUnlocked &&
    Boolean(state.roomId) &&
    (state.roomStatus === "idle" || state.roomStatus === "lobby");

  logAudio("syncAudioState", {
    roomId: state.roomId,
    roomStatus: state.roomStatus,
    audioUnlocked: state.audioUnlocked,
    shouldPlayWaitingRoom,
  });

  if (shouldPlayWaitingRoom) {
    safePlay(waitingRoomAudio);
  } else {
    waitingRoomAudio.pause();
    waitingRoomAudio.currentTime = 0;
  }

  if (state.roomStatus !== "question") {
    timerAudio.pause();
    timerAudio.currentTime = 0;
  }
}

function unlockAudio() {
  if (state.audioUnlocked) {
    logAudio("unlockAudio skipped: already unlocked");
    return;
  }

  state.audioUnlocked = true;
  waitingRoomAudio.load();
  timerAudio.load();
  logAudio("audio unlocked by admin interaction");
  syncAudioState();
}

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
  rulesSection.classList.add("hidden");
  questionSection.classList.add("hidden");
  resultSection.classList.add("hidden");
  endSection.classList.add("hidden");
  endSection.classList.remove("finale-active");
  questionTimerPill.classList.remove("timer-pill-danger");
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
  syncAudioState();
}

function renderShell() {
  const gameActive =
    state.roomStatus === "rules" ||
    state.roomStatus === "question" ||
    state.roomStatus === "result" ||
    state.roomStatus === "finished";

  lobbyView.classList.toggle("hidden", gameActive);
  gameView.classList.toggle("hidden", !gameActive);
  syncAudioState();
}

function renderFinalLeaderboard(leaderboard) {
  endSection.classList.remove("finale-active");
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
    card.style.setProperty("--reveal-delay", `${160 + podiumContainer.children.length * 180}ms`);
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
  restTableWrapper.style.setProperty("--reveal-delay", `${160 + topThree.length * 180}ms`);

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

  window.requestAnimationFrame(() => {
    endSection.classList.add("finale-active");
  });
}

function startCountdown(endsAt) {
  window.clearInterval(state.timerInterval);

  function updateTimer() {
    const remainingMs = Math.max(0, endsAt - getServerNow());
    const remainingSeconds = Math.ceil(remainingMs / 1000);

    timerLabel.textContent = String(remainingSeconds);
    questionTimerPill.classList.toggle("timer-pill-danger", remainingSeconds <= 5 && remainingMs > 0);
  }

  updateTimer();
  state.timerInterval = window.setInterval(updateTimer, 250);
}

function renderRules(endsAt) {
  resetGamePanels();
  rulesSection.classList.remove("hidden");
  renderShell();

  window.clearInterval(state.timerInterval);

  function updateRulesTimer() {
    const remainingMs = Math.max(0, endsAt - getServerNow());
    const remainingSeconds = Math.ceil(remainingMs / 1000);
    rulesTimerLabel.textContent = String(remainingSeconds);
  }

  updateRulesTimer();
  state.timerInterval = window.setInterval(updateRulesTimer, 250);
}

function renderQuestionTransition(endsAt, nextQuestionIndex, totalQuestions) {
  resetGamePanels();
  resultSection.classList.remove("hidden");
  correctAnswerLabel.textContent =
    nextQuestionIndex === null
      ? "Classement final dans 5 secondes..."
      : `Question ${nextQuestionIndex + 1}/${totalQuestions} dans 5 secondes...`;
  renderShell();

  window.clearInterval(state.timerInterval);

  function updateResultTimer() {
    const remainingMs = Math.max(0, endsAt - getServerNow());
    const remainingSeconds = Math.ceil(remainingMs / 1000);
    resultTimerLabel.textContent = String(remainingSeconds);
  }

  updateResultTimer();
  state.timerInterval = window.setInterval(updateResultTimer, 250);
}

createRoomButton.addEventListener("click", async () => {
  unlockAudio();
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
  unlockAudio();
  socket.emit("game:start");
});

document.addEventListener(
  "pointerdown",
  () => {
    logAudio("document pointerdown");
    unlockAudio();
  },
  { once: true }
);

socket.on("error:message", (payload) => {
  showError(payload.message);
});

socket.on("admin:joined", (payload) => {
  logAudio("socket admin:joined", payload);
  state.roomId = payload.roomId;
  createRoomButton.disabled = false;
  syncServerClock();
  renderAdminCard();
});

socket.on("admin:state", (payload) => {
  logAudio("socket admin:state", payload);
  state.roomId = payload.roomId;
  state.players = payload.players;
  state.canStart = payload.canStart;
  state.roomStatus = payload.status;
  renderAdminCard();
  renderShell();

  if (payload.status === "rules" && payload.phaseEndsAt) {
    renderRules(payload.phaseEndsAt);
  } else if (payload.status === "result" && payload.phaseEndsAt) {
    renderQuestionTransition(
      payload.phaseEndsAt,
      payload.currentQuestionIndex + 1 < payload.totalQuestions ? payload.currentQuestionIndex + 1 : null,
      payload.totalQuestions
    );
  }
});

socket.on("question:send", (payload) => {
  logAudio("socket question:send", payload);
  syncServerClock(1);
  state.roomStatus = "question";
  state.currentQuestion = payload.question;
  resetGamePanels();
  questionSection.classList.remove("hidden");
  questionIndexLabel.textContent = String(payload.questionIndex + 1);
  totalQuestionsLabel.textContent = String(payload.totalQuestions);
  questionPrompt.textContent = payload.question.prompt;
  renderShell();
  timerAudio.currentTime = 0;
  safePlay(timerAudio);
  startCountdown(payload.endsAt);
});

socket.on("rules:show", (payload) => {
  logAudio("socket rules:show", payload);
  syncServerClock(1);
  state.roomStatus = "rules";
  renderRules(payload.endsAt);
});

socket.on("question:transition", (payload) => {
  logAudio("socket question:transition", payload);
  syncServerClock(1);
  state.roomStatus = "result";
  renderQuestionTransition(payload.endsAt, payload.nextQuestionIndex, payload.totalQuestions);
});

socket.on("game:end", (payload) => {
  logAudio("socket game:end", payload);
  state.roomStatus = "finished";
  resetGamePanels();
  endSection.classList.remove("hidden");
  window.clearInterval(state.timerInterval);
  renderFinalLeaderboard(payload.leaderboard);
  renderShell();
  stopAudio(waitingRoomAudio);
  stopAudio(timerAudio);
});

socket.on("room:closed", () => {
  logAudio("socket room:closed");
  state.roomId = "";
  state.players = [];
  state.canStart = false;
  state.roomStatus = "idle";
  qrCodeImage.src = "";
  window.clearInterval(state.timerInterval);
  resetGamePanels();
  renderAdminCard();
  renderShell();
  stopAudio(waitingRoomAudio);
  stopAudio(timerAudio);
  showError("La room a ete fermee.");
});

socket.on("connect", () => {
  logAudio("socket connect");
  syncServerClock();
});

renderAdminCard();
renderShell();
syncAudioState();
