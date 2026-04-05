const hostCanvas = document.getElementById("hostCanvas");
const hostCtx = hostCanvas.getContext("2d");
const playerCanvas = document.getElementById("playerCanvas");
const playerCtx = playerCanvas.getContext("2d");

const modeHostButton = document.getElementById("modeHostButton");
const modeJoinButton = document.getElementById("modeJoinButton");
const hostView = document.getElementById("hostView");
const joinView = document.getElementById("joinView");

const createRoomButton = document.getElementById("createRoomButton");
const startMatchButton = document.getElementById("startMatchButton");
const restartMatchButton = document.getElementById("restartMatchButton");
const roomCodeEl = document.getElementById("roomCode");
const joinLinkEl = document.getElementById("joinLink");
const qrCodeEl = document.getElementById("qrCode");
const qrHintEl = document.getElementById("qrHint");
const bossNameEl = document.getElementById("bossName");
const bossHealthFill = document.getElementById("bossHealthFill");
const bossHealthText = document.getElementById("bossHealthText");
const phaseLabel = document.getElementById("phaseLabel");
const messageLabel = document.getElementById("messageLabel");
const rosterList = document.getElementById("rosterList");

const joinPanel = document.getElementById("joinPanel");
const playerView = document.getElementById("playerView");
const nameInput = document.getElementById("nameInput");
const codeInput = document.getElementById("codeInput");
const joinButton = document.getElementById("joinButton");
const joinMessage = document.getElementById("joinMessage");
const playerNameEl = document.getElementById("playerName");
const playerRoleEl = document.getElementById("playerRole");
const playerHealthFill = document.getElementById("playerHealthFill");
const playerHealthText = document.getElementById("playerHealthText");
const statusMessage = document.getElementById("statusMessage");
const abilityList = document.getElementById("abilityList");
const banner = document.getElementById("banner");
const movePad = document.getElementById("movePad");
const moveKnob = document.getElementById("moveKnob");
const mobileQButton = document.getElementById("mobileQButton");
const mobileEButton = document.getElementById("mobileEButton");
const mobileRButton = document.getElementById("mobileRButton");
const roleButtons = [...document.querySelectorAll(".role-button")];
const bgmPlayer = document.getElementById("bgmPlayer");

const HOST = "host";
const JOIN = "join";
const STORAGE_KEY = "islandJuggernautSession";
const MUSIC_TRACKS = [
  // Add your finished music files here, for example:
  // "/assets/music/lobby-theme.mp3",
  // "/assets/music/battle-theme.mp3",
];

let activeMode = HOST;
let roomCode = "";
let state = null;
let playerId = "";
let selectedRole = "random";
let lastPollAt = 0;
let hostSprites = new Map();
let playerSprites = new Map();
let projectilesState = [];
let effectsState = [];
let musicUnlocked = false;
let currentTrackIndex = 0;

const keyboard = new Set();
const inputState = {
  moveX: 0,
  moveY: 0,
  aimX: 1,
  aimY: 0,
  basic: false,
};

function isTouchDevice() {
  return window.matchMedia("(pointer: coarse)").matches;
}

function setupMusicSystem() {
  if (!bgmPlayer) return;
  if (!MUSIC_TRACKS.length) return;
  bgmPlayer.volume = 0.45;
  bgmPlayer.src = MUSIC_TRACKS[currentTrackIndex];
  bgmPlayer.addEventListener("ended", () => {
    currentTrackIndex = (currentTrackIndex + 1) % MUSIC_TRACKS.length;
    bgmPlayer.src = MUSIC_TRACKS[currentTrackIndex];
    if (musicUnlocked) bgmPlayer.play().catch(() => {});
  });
}

function unlockMusic() {
  if (musicUnlocked || !bgmPlayer || !MUSIC_TRACKS.length) return;
  musicUnlocked = true;
  bgmPlayer.play().catch(() => {
    musicUnlocked = false;
  });
}

async function postJson(url, payload = {}) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "Request failed");
  return data;
}

function capitalize(value = "") {
  return value ? value.charAt(0).toUpperCase() + value.slice(1) : "";
}

function showBanner(text) {
  banner.textContent = text;
  banner.classList.remove("hidden");
}

function hideBanner() {
  banner.classList.add("hidden");
}

function switchMode(mode) {
  activeMode = mode;
  hostView.classList.toggle("hidden", mode !== HOST);
  joinView.classList.toggle("hidden", mode !== JOIN);
  modeHostButton.classList.toggle("secondary", mode !== HOST);
  modeJoinButton.classList.toggle("secondary", mode !== JOIN);
}

function getBaseUrl() {
  const params = new URLSearchParams(location.search);
  const shareHost = params.get("host");
  if (shareHost) {
    return `${location.protocol}//${shareHost}`;
  }
  return location.origin;
}

function getJoinUrl() {
  if (!roomCode) return "";
  if (location.hostname === "localhost" || location.hostname === "127.0.0.1") return "";
  return `${getBaseUrl()}/?mode=join&code=${roomCode}`;
}

function renderQrCode(joinUrl) {
  qrCodeEl.innerHTML = "";
  if (!joinUrl) {
    qrHintEl.textContent = "Open this page from your LAN or website URL to generate a scannable QR code.";
    return;
  }
  qrHintEl.textContent = "Scan to open this same page in Join View.";
  const image = document.createElement("img");
  image.alt = "Join QR code";
  image.width = 132;
  image.height = 132;
  image.src = `/api/qr?text=${encodeURIComponent(joinUrl)}`;
  qrCodeEl.appendChild(image);
}

function syncRoomHeader() {
  roomCodeEl.textContent = roomCode || "----";
  if (!roomCode) {
    joinLinkEl.textContent = "Join link will appear here";
    qrCodeEl.innerHTML = "";
    qrHintEl.textContent = "Create a room to generate a scan code.";
    return;
  }
  const joinUrl = getJoinUrl();
  joinLinkEl.textContent = joinUrl || `Open this site from your PC's LAN IP or hosted URL, then use code ${roomCode}`;
  renderQrCode(joinUrl);
}

function applyState(newState) {
  state = newState;
  projectilesState = newState.projectiles || [];
  effectsState = newState.effects || [];
  mergeSprites(hostSprites, newState.players || []);
  mergeSprites(playerSprites, newState.players || []);
}

function mergeSprites(store, players) {
  const ids = new Set(players.map((player) => player.id));
  for (const player of players) {
    const current = store.get(player.id) || { x: player.x, y: player.y, facing: player.facing, health: player.health };
    current.targetX = player.x;
    current.targetY = player.y;
    current.targetFacing = player.facing;
    current.targetHealth = player.health;
    current.role = player.role;
    current.color = player.color;
    current.radius = player.radius;
    current.maxHealth = player.maxHealth;
    current.name = player.name;
    current.dead = player.dead;
    current.invisible = player.invisible;
    current.hiddenToViewer = player.hiddenToViewer;
    if (!("x" in current)) {
      current.x = player.x;
      current.y = player.y;
      current.facing = player.facing;
      current.health = player.health;
    }
    store.set(player.id, current);
  }
  for (const key of [...store.keys()]) {
    if (!ids.has(key)) store.delete(key);
  }
}

function animateSprites(store) {
  for (const sprite of store.values()) {
    sprite.x += (sprite.targetX - sprite.x) * 0.22;
    sprite.y += (sprite.targetY - sprite.y) * 0.22;
    sprite.facing += angleDelta(sprite.facing, sprite.targetFacing) * 0.22;
    sprite.health += (sprite.targetHealth - sprite.health) * 0.25;
  }
}

function angleDelta(from, to) {
  let delta = to - from;
  while (delta > Math.PI) delta -= Math.PI * 2;
  while (delta < -Math.PI) delta += Math.PI * 2;
  return delta;
}

async function createRoom() {
  const data = await postJson("/api/create-room");
  roomCode = data.code;
  syncRoomHeader();
  hideBanner();
}

async function startMatch() {
  if (!roomCode) return;
  try {
    await postJson("/api/start-match", { code: roomCode });
  } catch (error) {
    showBanner(error.message);
  }
}

async function restartMatch() {
  if (!roomCode) return;
  try {
    await postJson("/api/restart-match", { code: roomCode });
  } catch (error) {
    showBanner(error.message);
  }
}

async function joinRoom() {
  try {
    const joined = await postJson("/api/join-room", {
      code: codeInput.value.trim().toUpperCase(),
      name: nameInput.value.trim(),
    });
    roomCode = joined.code;
    playerId = joined.playerId;
    await postJson("/api/set-role", { code: roomCode, playerId, role: selectedRole });
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ roomCode, playerId, name: nameInput.value.trim() }));
    joinPanel.classList.add("hidden");
    playerView.classList.remove("hidden");
    switchMode(JOIN);
    syncRoomHeader();
  } catch (error) {
    joinMessage.textContent = error.message;
  }
}

async function pollState(force = false) {
  if (!roomCode) return;
  const now = performance.now();
  const interval = activeMode === HOST ? 90 : 65;
  if (!force && now - lastPollAt < interval) return;
  lastPollAt = now;

  try {
    const viewerQuery = playerId ? `&playerId=${playerId}` : "";
    const response = await fetch(`/api/state?code=${roomCode}${viewerQuery}`);
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || "Failed to fetch room state");
    applyState(payload);
    renderHostHud();
    renderPlayerHud();
  } catch (error) {
    showBanner(error.message);
  }
}

function renderHostHud() {
  if (!state) return;
  phaseLabel.textContent = state.phase;
  messageLabel.textContent = state.message;

  if (state.juggernaut) {
    bossNameEl.textContent = state.juggernaut.name;
    bossHealthFill.style.width = `${(state.juggernaut.health / state.juggernaut.maxHealth) * 100}%`;
    bossHealthText.textContent = `${Math.ceil(state.juggernaut.health)} / ${state.juggernaut.maxHealth}`;
  } else {
    bossNameEl.textContent = "No match yet";
    bossHealthFill.style.width = "100%";
    bossHealthText.textContent = "1500 HP";
  }

  rosterList.innerHTML = state.players.map((player) => `
    <div class="roster-card ${player.dead ? "dead" : ""}">
      <strong>${player.name}</strong>
      <div>${capitalize(player.role || "random")}</div>
      <div>${Math.ceil(player.health)} / ${player.maxHealth}</div>
    </div>
  `).join("");

  if (state.winner) {
    showBanner(`${state.winner}. ${state.message}.`);
  } else {
    hideBanner();
  }
}

function renderPlayerHud() {
  if (!state || !state.you) return;
  playerNameEl.textContent = state.you.name;
  playerRoleEl.textContent = state.started ? `You are ${capitalize(state.you.role)}` : `Preferred role: ${capitalize(state.you.preferredRole)}`;
  playerHealthFill.style.width = `${(state.you.health / state.you.maxHealth) * 100}%`;
  playerHealthText.textContent = `${Math.ceil(state.you.health)} / ${state.you.maxHealth}`;

  if (state.winner) {
    statusMessage.textContent = `${state.winner}. ${state.message}`;
  } else if (!state.started) {
    statusMessage.textContent = `Lobby open. Room ${state.code}. Waiting for the host to start.`;
  } else if (state.you.dead) {
    statusMessage.textContent = "You are down, but you can still watch the battle.";
  } else if (state.you.invisibleRemaining > 0) {
    statusMessage.textContent = `Invisible to the juggernaut for ${state.you.invisibleRemaining.toFixed(1)}s`;
  } else {
    statusMessage.textContent = state.message;
  }

  abilityList.innerHTML = (state.you.abilities || []).map((ability) => `
    <div class="ability-pill">
      <strong>${ability.key} ${ability.name}</strong>
      <div>${ability.cooldown <= 0 ? "Ready" : `${ability.cooldown.toFixed(1)}s`}</div>
    </div>
  `).join("");

  syncAbilityButtons(state.you);
}

function setAbilityButton(button, ability, enabled = true) {
  if (!button) return;
  if (!enabled || !ability) {
    button.disabled = true;
    button.classList.add("disabled");
    return;
  }
  button.disabled = false;
  button.classList.toggle("disabled", ability.cooldown > 0);
  button.textContent = ability.cooldown > 0 ? `${ability.key} ${Math.ceil(ability.cooldown)}` : ability.key;
}

function syncAbilityButtons(you) {
  const byKey = Object.fromEntries((you.abilities || []).map((ability) => [ability.key, ability]));
  setAbilityButton(mobileQButton, byKey.Q);
  setAbilityButton(mobileEButton, byKey.E);
  setAbilityButton(mobileRButton, byKey.R, you.role === "juggernaut");
}

function drawScene(ctx, canvas, store, cameraMode) {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  if (!state) return;

  animateSprites(store);

  const seaGradient = ctx.createLinearGradient(0, 0, 0, canvas.height);
  seaGradient.addColorStop(0, "#1a6076");
  seaGradient.addColorStop(1, "#082c39");
  ctx.fillStyle = seaGradient;
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  const view = getCamera(cameraMode);
  ctx.save();
  ctx.translate(canvas.width / 2, canvas.height / 2);
  ctx.scale(view.zoom, view.zoom);
  ctx.translate(-view.x, -view.y);

  drawArena(ctx, state.arena);
  drawEffects(ctx, effectsState);
  drawProjectiles(ctx, projectilesState);
  for (const sprite of store.values()) drawPlayer(ctx, sprite, cameraMode === "player");
  ctx.restore();
}

function getCamera(mode) {
  if (mode === "player" && state?.you) {
    const you = playerSprites.get(state.you.id);
    const x = you ? you.x : state.arena.center_x;
    const y = you ? you.y : state.arena.center_y;
    return { x, y, zoom: window.innerWidth < 860 ? 0.72 : 0.82 };
  }
  return { x: state.camera.camera_x, y: state.camera.camera_y, zoom: state.camera.zoom };
}

function drawArena(ctx, arena) {
  for (let i = 0; i < 12; i += 1) {
    ctx.beginPath();
    ctx.arc(220 + i * 210, 180 + (i % 3) * 120, 90 + (i % 4) * 18, 0, Math.PI * 2);
    ctx.fillStyle = "rgba(255,255,255,0.03)";
    ctx.fill();
  }

  ctx.beginPath();
  ctx.arc(arena.center_x, arena.center_y, arena.island_radius + 30, 0, Math.PI * 2);
  ctx.fillStyle = "rgba(7, 20, 27, 0.32)";
  ctx.fill();

  const islandGradient = ctx.createRadialGradient(arena.center_x, arena.center_y - 60, 50, arena.center_x, arena.center_y, arena.island_radius);
  islandGradient.addColorStop(0, "#9fcb79");
  islandGradient.addColorStop(0.55, "#4a8846");
  islandGradient.addColorStop(1, "#d8bd7b");
  ctx.beginPath();
  ctx.arc(arena.center_x, arena.center_y, arena.island_radius, 0, Math.PI * 2);
  ctx.fillStyle = islandGradient;
  ctx.fill();

  ctx.beginPath();
  ctx.arc(arena.center_x, arena.center_y, arena.island_radius - 85, 0, Math.PI * 2);
  ctx.strokeStyle = "rgba(66, 95, 42, 0.32)";
  ctx.lineWidth = 85;
  ctx.stroke();
}

function drawPlayer(ctx, player, isPlayerView) {
  if (player.dead || (isPlayerView && player.hiddenToViewer)) return;
  ctx.save();
  ctx.translate(player.x, player.y);
  ctx.rotate(player.facing);
  if (player.role === "juggernaut") {
    ctx.shadowBlur = 30;
    ctx.shadowColor = "#4db3ff";
  }
  ctx.beginPath();
  ctx.arc(0, 0, player.radius, 0, Math.PI * 2);
  ctx.fillStyle = player.color;
  ctx.fill();
  if (player.role === "juggernaut") {
    ctx.beginPath();
    ctx.arc(0, 0, player.radius + 9, 0, Math.PI * 2);
    ctx.strokeStyle = "rgba(136, 218, 255, 0.7)";
    ctx.lineWidth = 5;
    ctx.stroke();
  }
  ctx.fillStyle = "#031118";
  ctx.fillRect(player.radius - 4, -5, player.role === "juggernaut" ? 44 : 28, 10);
  ctx.restore();

  const barWidth = player.role === "juggernaut" ? 92 : 62;
  ctx.fillStyle = "rgba(0, 0, 0, 0.35)";
  ctx.fillRect(player.x - barWidth / 2, player.y - player.radius - 30, barWidth, 8);
  ctx.fillStyle = "#88f5b2";
  ctx.fillRect(player.x - barWidth / 2, player.y - player.radius - 30, barWidth * (player.health / player.maxHealth), 8);

  ctx.fillStyle = "#f7fcfd";
  ctx.textAlign = "center";
  ctx.font = "24px Space Grotesk";
  ctx.fillText(player.name, player.x, player.y + player.radius + 34);

  if (player.invisible && player.role === "wizard") {
    ctx.strokeStyle = "rgba(210, 249, 255, 0.75)";
    ctx.setLineDash([7, 7]);
    ctx.beginPath();
    ctx.arc(player.x, player.y, player.radius + 12, 0, Math.PI * 2);
    ctx.stroke();
    ctx.setLineDash([]);
  }
}

function drawProjectiles(ctx, projectiles) {
  for (const projectile of projectiles) {
    ctx.beginPath();
    ctx.arc(projectile.x, projectile.y, projectile.radius, 0, Math.PI * 2);
    ctx.fillStyle = projectile.color;
    ctx.shadowBlur = 16;
    ctx.shadowColor = projectile.color;
    ctx.fill();
    ctx.shadowBlur = 0;
  }
}

function drawEffects(ctx, effects) {
  for (const effect of effects) {
    const alpha = Math.max(0, effect.life / effect.max_life);
    if (effect.kind === "ring") {
      ctx.beginPath();
      ctx.arc(effect.x, effect.y, effect.size * (1 - alpha * 0.35), 0, Math.PI * 2);
      ctx.strokeStyle = hexToRgba(effect.color, alpha);
      ctx.lineWidth = 8;
      ctx.stroke();
    } else if (effect.kind === "text") {
      ctx.fillStyle = hexToRgba(effect.color, alpha);
      ctx.font = "bold 26px Space Grotesk";
      ctx.textAlign = "center";
      ctx.fillText(effect.text, effect.x, effect.y);
    }
  }
}

function hexToRgba(hex, alpha) {
  const safe = hex.replace("#", "");
  const value = safe.length === 3 ? safe.split("").map((char) => char + char).join("") : safe;
  const numeric = parseInt(value, 16);
  return `rgba(${(numeric >> 16) & 255}, ${(numeric >> 8) & 255}, ${numeric & 255}, ${alpha})`;
}

function updateKeyboardMovement() {
  const moveX = (keyboard.has("d") ? 1 : 0) - (keyboard.has("a") ? 1 : 0);
  const moveY = (keyboard.has("s") ? 1 : 0) - (keyboard.has("w") ? 1 : 0);
  inputState.moveX = moveX;
  inputState.moveY = moveY;
}

function pulseAbility(slot) {
  if (!roomCode || !playerId) return;
  postJson("/api/input", {
    code: roomCode,
    playerId,
    moveX: inputState.moveX,
    moveY: inputState.moveY,
    aimX: inputState.aimX,
    aimY: inputState.aimY,
    basic: inputState.basic,
    [slot]: true,
  }).catch((error) => {
    joinMessage.textContent = error.message;
  });
}

function pulseBasic() {
  if (!roomCode || !playerId) return;
  postJson("/api/input", {
    code: roomCode,
    playerId,
    moveX: inputState.moveX,
    moveY: inputState.moveY,
    aimX: inputState.aimX,
    aimY: inputState.aimY,
    basic: true,
  }).catch((error) => {
    joinMessage.textContent = error.message;
  });
}

async function sendInput() {
  if (!roomCode || !playerId) return;
  try {
    await postJson("/api/input", {
      code: roomCode,
      playerId,
      moveX: inputState.moveX,
      moveY: inputState.moveY,
      aimX: inputState.aimX,
      aimY: inputState.aimY,
      basic: inputState.basic,
    });
  } catch (error) {
    joinMessage.textContent = error.message;
  }
}

function setupMovePad() {
  if (!movePad) return;
  const activePointers = new Map();
  const update = (event) => {
    const rect = movePad.getBoundingClientRect();
    const x = event.clientX - rect.left - rect.width / 2;
    const y = event.clientY - rect.top - rect.height / 2;
    const maxDistance = rect.width * 0.32;
    const angle = Math.atan2(y, x);
    const distance = Math.min(maxDistance, Math.hypot(x, y));
    inputState.moveX = distance === 0 ? 0 : (Math.cos(angle) * distance) / maxDistance;
    inputState.moveY = distance === 0 ? 0 : (Math.sin(angle) * distance) / maxDistance;
    moveKnob.style.transform = `translate(calc(-50% + ${Math.cos(angle) * distance}px), calc(-50% + ${Math.sin(angle) * distance}px))`;
  };
  const reset = (event) => {
    activePointers.delete(event.pointerId);
    if (!activePointers.size) {
      inputState.moveX = 0;
      inputState.moveY = 0;
      moveKnob.style.transform = "translate(-50%, -50%)";
    }
  };
  movePad.addEventListener("pointerdown", (event) => {
    movePad.setPointerCapture(event.pointerId);
    activePointers.set(event.pointerId, true);
    update(event);
  });
  movePad.addEventListener("pointermove", (event) => {
    if (activePointers.has(event.pointerId)) update(event);
  });
  movePad.addEventListener("pointerup", reset);
  movePad.addEventListener("pointercancel", reset);
}

function updateAimFromCanvas(event, canvas) {
  const rect = canvas.getBoundingClientRect();
  const x = event.clientX - rect.left - rect.width / 2;
  const y = event.clientY - rect.top - rect.height / 2;
  const length = Math.hypot(x, y);
  if (length > 0.001) {
    inputState.aimX = x / length;
    inputState.aimY = y / length;
  }
}

function setupPlayerCanvasControls() {
  playerCanvas.addEventListener("mousemove", (event) => {
    if (isTouchDevice()) return;
    updateAimFromCanvas(event, playerCanvas);
  });
  playerCanvas.addEventListener("mousedown", (event) => {
    if (event.button !== 0 || isTouchDevice()) return;
    updateAimFromCanvas(event, playerCanvas);
    inputState.basic = true;
  });
  window.addEventListener("mouseup", (event) => {
    if (event.button === 0) inputState.basic = false;
  });

  playerCanvas.addEventListener("pointerdown", (event) => {
    if (!isTouchDevice()) return;
    if (event.pointerType !== "touch") return;
    updateAimFromCanvas(event, playerCanvas);
    pulseBasic();
  });
  playerCanvas.addEventListener("pointermove", (event) => {
    if (!isTouchDevice()) return;
    if (event.pointerType !== "touch") return;
    updateAimFromCanvas(event, playerCanvas);
  });
}

function restoreSession() {
  const params = new URLSearchParams(location.search);
  const mode = params.get("mode");
  const code = params.get("code");
  if (mode === JOIN) switchMode(JOIN);
  if (code) codeInput.value = code.toUpperCase();

  const saved = localStorage.getItem(STORAGE_KEY);
  if (!saved) return;
  try {
    const parsed = JSON.parse(saved);
    if (parsed.roomCode) {
      roomCode = parsed.roomCode;
      codeInput.value = parsed.roomCode;
    }
    if (parsed.playerId) {
      playerId = parsed.playerId;
      joinPanel.classList.add("hidden");
      playerView.classList.remove("hidden");
    }
    if (parsed.name) nameInput.value = parsed.name;
  } catch {
    // Ignore invalid saved session.
  }
}

function animate() {
  requestAnimationFrame(animate);
  drawScene(hostCtx, hostCanvas, hostSprites, "host");
  if (playerView && !playerView.classList.contains("hidden")) {
    drawScene(playerCtx, playerCanvas, playerSprites, "player");
  } else {
    playerCtx.clearRect(0, 0, playerCanvas.width, playerCanvas.height);
  }
}

modeHostButton.addEventListener("click", () => switchMode(HOST));
modeJoinButton.addEventListener("click", () => switchMode(JOIN));
createRoomButton.addEventListener("click", async () => {
  unlockMusic();
  try {
    await createRoom();
    await pollState(true);
  } catch (error) {
    showBanner(error.message);
  }
});
startMatchButton.addEventListener("click", startMatch);
restartMatchButton.addEventListener("click", restartMatch);
joinButton.addEventListener("click", () => {
  unlockMusic();
  joinRoom();
});
mobileQButton.addEventListener("click", () => {
  unlockMusic();
  pulseAbility("Q");
});
mobileEButton.addEventListener("click", () => {
  unlockMusic();
  pulseAbility("E");
});
mobileRButton.addEventListener("click", () => {
  unlockMusic();
  pulseAbility("R");
});

roleButtons.forEach((button) => {
  button.addEventListener("click", () => {
    roleButtons.forEach((current) => current.classList.remove("active"));
    button.classList.add("active");
    selectedRole = button.dataset.role;
  });
});

window.addEventListener("keydown", (event) => {
  unlockMusic();
  keyboard.add(event.key.toLowerCase());
  updateKeyboardMovement();
  if (event.key.toLowerCase() === "q") pulseAbility("Q");
  if (event.key.toLowerCase() === "e") pulseAbility("E");
  if (event.key.toLowerCase() === "r") pulseAbility("R");
  if (event.key === "Enter" && !playerId && activeMode === JOIN) joinRoom();
});

window.addEventListener("keyup", (event) => {
  keyboard.delete(event.key.toLowerCase());
  updateKeyboardMovement();
});

restoreSession();
setupMovePad();
setupPlayerCanvasControls();
setupMusicSystem();
syncRoomHeader();
setInterval(() => pollState(), 50);
setInterval(sendInput, 50);
animate();
