const errorBanner = document.getElementById("errorBanner");
const refreshRoomsButton = document.getElementById("refreshRoomsButton");
const emptyState = document.getElementById("emptyState");
const roomsGrid = document.getElementById("roomsGrid");

function showError(message) {
  errorBanner.textContent = message;
  errorBanner.classList.remove("hidden");

  window.clearTimeout(showError.timeoutId);
  showError.timeoutId = window.setTimeout(() => {
    errorBanner.classList.add("hidden");
  }, 4000);
}

function getStatusLabel(status) {
  if (status === "lobby") {
    return "lobby";
  }

  if (status === "question") {
    return "en question";
  }

  if (status === "result") {
    return "resultat";
  }

  if (status === "finished") {
    return "terminee";
  }

  return status;
}

function renderRooms(rooms) {
  roomsGrid.innerHTML = "";
  emptyState.classList.toggle("hidden", rooms.length > 0);

  rooms.forEach((room) => {
    const card = document.createElement("article");
    card.className = "room-admin-card";
    card.innerHTML = `
      <div class="room-admin-head">
        <div class="room-badge-row">
          <span class="room-badge">Room <strong>${room.roomId}</strong></span>
          <span class="room-badge room-badge-accent">${getStatusLabel(room.status)}</span>
        </div>
        <a class="link-button" href="/admin" target="_blank" rel="noreferrer">Ouvrir /admin</a>
      </div>

      <div class="admin-summary room-admin-stats">
        <div class="admin-summary-card">
          <span class="admin-summary-label">Joueurs</span>
          <strong>${room.playerCount}</strong>
        </div>
        <div class="admin-summary-card">
          <span class="admin-summary-label">Prets</span>
          <strong>${room.readyCount}/${room.playerCount}</strong>
        </div>
      </div>

      <div class="room-admin-meta">
        <span>Admins connectes: <strong>${room.adminCount}</strong></span>
        <span>Question: <strong>${
          room.currentQuestionIndex >= 0 ? room.currentQuestionIndex + 1 : 0
        }/${room.totalQuestions}</strong></span>
      </div>

      <div class="action-row">
        <a class="secondary-button" href="/room/${room.roomId}" target="_blank" rel="noreferrer">
          Ouvrir la room
        </a>
        <button class="danger-button" data-room-id="${room.roomId}">Kill la room</button>
      </div>
    `;
    roomsGrid.appendChild(card);
  });

  for (const button of roomsGrid.querySelectorAll("[data-room-id]")) {
    button.addEventListener("click", async () => {
      const roomId = button.getAttribute("data-room-id");
      button.disabled = true;

      try {
        const response = await fetch(`/api/room-admin/rooms/${roomId}`, {
          method: "DELETE",
        });

        if (!response.ok) {
          throw new Error("Impossible de fermer cette room.");
        }

        await loadRooms();
      } catch (error) {
        showError(error.message);
        button.disabled = false;
      }
    });
  }
}

async function loadRooms() {
  refreshRoomsButton.disabled = true;

  try {
    const response = await fetch("/api/room-admin/rooms");

    if (!response.ok) {
      throw new Error("Impossible de charger les rooms.");
    }

    const payload = await response.json();
    renderRooms(payload.rooms);
  } catch (error) {
    showError(error.message);
  } finally {
    refreshRoomsButton.disabled = false;
  }
}

refreshRoomsButton.addEventListener("click", () => {
  loadRooms();
});

window.setInterval(loadRooms, 5000);
loadRooms();
