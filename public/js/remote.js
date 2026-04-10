/**
 * PDF Presenter — Remote Control
 * MIT License
 */

const $ = (id) => document.getElementById(id);

const connectScreen = $("remoteConnect");
const remotePad = $("remotePad");
const sessionInput = $("sessionInput");
const connectBtn = $("connectBtn");
const rcHint = $("rcHint");
const rcPrev = $("rcPrev");
const rcNext = $("rcNext");
const rcSessionBadge = $("rcSessionBadge");
const rcStatusDot = $("rcStatusDot");
const rcSlideNum = $("rcSlideNum");
const rcTotalSlides = $("rcTotalSlides");
const rcSlideBox = $("rcSlideBox");
const jumpInput = $("jumpInput");
const jumpBtn = $("jumpBtn");
const rcDisconnect = $("rcDisconnect");
const rcFullscreen = $("rcFullscreen");
const rcHeaderFullscreen = $("rcHeaderFullscreen");
const rcCursorToggle = $("rcCursorToggle");
const toast = $("toast");
const notesArea = $("notesArea");
const notesFontDown = $("notesFontDown");
const notesFontUp = $("notesFontUp");
const notesTeleBtn = $("notesTeleBtn");
const teleOverlay = $("teleprompterOverlay");
const tpClose = $("tpClose");
const tpText = $("tpText");
const tpTextWrap = $("tpTextWrap");
const tpPlayPause = $("tpPlayPause");
const tpSpeed = $("tpSpeed");
const rcFsOverlay = $("rcFsOverlay");
const rfsCounter = $("rfsCounter");
const rfsPrev = $("rfsPrev");
const rfsNext = $("rfsNext");
const rfsExit = $("rfsExit");

let socket = null;
let sessionId = null;
let currentSlide = 1;
let totalSlides = 0;
let notesFontSize = 16;
let cursorActive = false;
let cursorEnabled = false;

// ── Auto-connect from URL param ───────────────────────────────────────────────
const params = new URLSearchParams(window.location.search);
const urlSession = params.get("session");
if (urlSession) {
  sessionInput.value = urlSession.toUpperCase();
  setTimeout(connectToSession, 300);
}

// ── Connect ───────────────────────────────────────────────────────────────────
connectBtn.addEventListener("click", connectToSession);
sessionInput.addEventListener("keydown", (e) => {
  sessionInput.value = sessionInput.value.toUpperCase();
  if (e.key === "Enter") connectToSession();
});

function connectToSession() {
  const id = sessionInput.value.trim().toUpperCase();
  if (!id || id.length < 4) {
    rcHint.textContent = "⚠ Enter a valid session ID";
    rcHint.style.color = "var(--danger)";
    return;
  }
  rcHint.textContent = "Connecting…";
  rcHint.style.color = "var(--text-3)";
  sessionId = id;

  socket = io({ transports: ["websocket", "polling"] });

  socket.on("connect", () => {
    // 🔒 Request access first - presenter must approve
    socket.emit("remote-request-access", { sessionId, deviceId: getDeviceId() });
  });

  // Waiting for presenter approval
  socket.on("remote-request-sent", ({ message }) => {
    rcHint.textContent = "⏳ Waiting for presenter approval...";
    rcHint.style.color = "var(--warning)";
  });

  // Access granted - server already joined us
  socket.on("remote-approved", ({ message }) => {
    rcHint.textContent = "✓ " + message;
    rcHint.style.color = "var(--success)";
    // Server already joined the session, no need to emit join-session
  });

  // Access denied
  socket.on("remote-rejected", ({ message }) => {
    rcHint.textContent = "✗ " + message;
    rcHint.style.color = "var(--danger)";
    setTimeout(() => disconnect(), 2000);
  });

  socket.on("session-state", ({ currentSlide: cs, totalSlides: ts, name }) => {
    currentSlide = cs || 1;
    totalSlides = ts || 0;
    updateSessionNameDisplay(name);
    showPad();
    updateSlideDisplay();
  });

  socket.on("slide-update", ({ currentSlide: cs }) => {
    currentSlide = cs;
    updateSlideDisplay();
    animateSlideChange();
  });
  socket.on("total-slides-update", ({ totalSlides: ts }) => {
    totalSlides = ts;
    updateSlideDisplay();
  });

  // ── Mid-session PDF swap notification ─────────────────────────────────────
  socket.on("pdf-loaded", ({ filename }) => {
    showToast("📄 New PDF: " + filename);
    showPdfSwapBanner(filename);
    // Reset slide counter display
    currentSlide = 1;
    updateSlideDisplay();
  });

  socket.on("connect_error", () => setStatus(false));
  socket.on("disconnect", () => setStatus(false));
  socket.on("reconnect", () => {
    setStatus(true);
    // Re-request access on reconnect if not already approved
    if (!socket.data?.approvedRemote) {
      socket.emit("remote-request-access", { sessionId, deviceId: getDeviceId() });
    }
  });

  // Session renamed - update display
  socket.on("session-renamed", ({ name }) => {
    updateSessionNameDisplay(name);
  });

  // Session ended - show message and redirect
  socket.on("session-ended", ({ message }) => {
    showToast(`⚠ ${message}`);
    setTimeout(() => {
      window.location.href = "/access.html";
    }, 3000);
  });
}

// ── PDF Swap Banner ───────────────────────────────────────────────────────────

function escapeHtml(text) {
  const div = document.createElement("div");
  div.textContent = text;
  return div.innerHTML;
}

function showPdfSwapBanner(filename) {
  const existing = document.getElementById("rcPdfSwapBanner");
  if (existing) existing.remove();

  const banner = document.createElement("div");
  banner.id = "rcPdfSwapBanner";
  banner.className = "rc-pdf-swap-banner";
  banner.innerHTML = `<span>🔄</span> <span>New PDF: <strong>${escapeHtml(filename)}</strong></span>`;

  // Insert just below the header
  const pad = document.getElementById("remotePad");
  const header = pad.querySelector(".rc-header");
  header.insertAdjacentElement("afterend", banner);

  requestAnimationFrame(() => banner.classList.add("show"));

  setTimeout(() => {
    banner.classList.remove("show");
    setTimeout(() => banner.remove(), 400);
  }, 4000);
}

function showPad() {
  connectScreen.style.display = "none";
  remotePad.style.display = "flex";
  rcSessionBadge.textContent = sessionId;
  setStatus(true);
}

function setStatus(online) {
  rcStatusDot.textContent = online ? "● Live" : "● Disconnected";
  rcStatusDot.className =
    "rc-status " + (online ? "connected" : "disconnected");
}

// ── Slide Commands ────────────────────────────────────────────────────────────
function sendSlideChange(dir) {
  if (!socket?.connected) {
    showToast("⚠ Not connected");
    return;
  }
  socket.emit("slide-change", { sessionId, direction: dir });
}
function sendJump(slide) {
  if (!socket?.connected) return;
  socket.emit("slide-change", { sessionId, slide });
}

rcPrev.addEventListener("click", () => sendSlideChange("prev"));
rcNext.addEventListener("click", () => sendSlideChange("next"));
jumpBtn.addEventListener("click", () => {
  const n = parseInt(jumpInput.value);
  if (n >= 1) {
    sendJump(n);
    jumpInput.value = "";
  }
});
jumpInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") jumpBtn.click();
});

// Bluetooth clicker keyboard support
document.addEventListener("keydown", (e) => {
  if (
    document.activeElement === jumpInput ||
    document.activeElement === notesArea
  )
    return;
  if (e.key === "ArrowRight" || e.key === " ") sendSlideChange("next");
  if (e.key === "ArrowLeft") sendSlideChange("prev");
});

// ── Session Name Display ─────────────────────────────────────────────────────
function updateSessionNameDisplay(name) {
  const nameEl = document.getElementById("rcSessionName");
  if (nameEl) {
    nameEl.textContent = name || "Untitled Session";
    nameEl.style.display = "inline";
  }
}

// ── Display ───────────────────────────────────────────────────────────────────
function updateSlideDisplay() {
  const ts = totalSlides || "?";
  rcSlideNum.textContent = currentSlide;
  rcTotalSlides.textContent = ts;
  rfsCounter.textContent = currentSlide + " / " + ts;
  if (jumpInput) jumpInput.max = totalSlides || 999;
}

function animateSlideChange() {
  rcSlideBox.style.transform = "scale(1.18)";
  rcSlideBox.style.color = "var(--accent-2)";
  setTimeout(() => {
    rcSlideBox.style.transform = "scale(1)";
    rcSlideBox.style.color = "var(--accent)";
  }, 180);
}

// ── Disconnect ────────────────────────────────────────────────────────────────
rcDisconnect.addEventListener("click", () => {
  socket?.disconnect();
  sessionId = null;
  remotePad.style.display = "none";
  connectScreen.style.display = "flex";
  sessionInput.value = "";
  rcHint.textContent = "";
});

// ── Notes Font ────────────────────────────────────────────────────────────────
notesFontDown.addEventListener("click", () => {
  notesFontSize = Math.max(10, notesFontSize - 2);
  notesArea.style.fontSize = notesFontSize + "px";
});
notesFontUp.addEventListener("click", () => {
  notesFontSize = Math.min(32, notesFontSize + 2);
  notesArea.style.fontSize = notesFontSize + "px";
});

// Persist notes
notesArea.addEventListener("input", () =>
  localStorage.setItem("presenter-notes", notesArea.value),
);
const savedNotes = localStorage.getItem("presenter-notes");
if (savedNotes) notesArea.value = savedNotes;

// ── Teleprompter ──────────────────────────────────────────────────────────────
let tpRunning = true;
let tpRaf = null;
let tpSpeedVal = 1.5;

notesTeleBtn.addEventListener("click", openTeleprompter);
tpClose.addEventListener("click", closeTeleprompter);

function openTeleprompter() {
  const text = notesArea.value.trim();
  if (!text) {
    showToast("⚠ Add some notes first");
    return;
  }
  tpText.innerHTML = text
    .split(/\n\n+/)
    .map((p) => "<p>" + p.replace(/\n/g, "<br>") + "</p>")
    .join("");
  tpTextWrap.scrollTop = 0;
  teleOverlay.style.display = "flex";
  tpRunning = true;
  tpPlayPause.textContent = "⏸ Pause";
  startTpScroll();
  teleOverlay.requestFullscreen?.().catch(() => {});
}

function closeTeleprompter() {
  stopTpScroll();
  teleOverlay.style.display = "none";
  if (document.fullscreenElement) document.exitFullscreen();
}

tpPlayPause.addEventListener("click", () => {
  tpRunning = !tpRunning;
  tpPlayPause.textContent = tpRunning ? "⏸ Pause" : "▶ Play";
  if (tpRunning) startTpScroll();
  else stopTpScroll();
});

tpSpeed.addEventListener("input", () => {
  tpSpeedVal = parseFloat(tpSpeed.value);
});

function startTpScroll() {
  stopTpScroll();
  function step() {
    if (!tpRunning) return;
    tpTextWrap.scrollTop += tpSpeedVal;
    if (
      tpTextWrap.scrollTop + tpTextWrap.clientHeight >=
      tpTextWrap.scrollHeight
    ) {
      tpRunning = false;
      tpPlayPause.textContent = "▶ Play";
      return;
    }
    tpRaf = requestAnimationFrame(step);
  }
  tpRaf = requestAnimationFrame(step);
}
function stopTpScroll() {
  if (tpRaf) {
    cancelAnimationFrame(tpRaf);
    tpRaf = null;
  }
}

tpTextWrap.addEventListener("click", () => {
  tpRunning = !tpRunning;
  tpPlayPause.textContent = tpRunning ? "⏸ Pause" : "▶ Play";
  if (tpRunning) startTpScroll();
  else stopTpScroll();
});

// ── Fullscreen Pad ────────────────────────────────────────────────────────────
rcFullscreen.addEventListener("click", () => {
  rcFsOverlay.style.display = "flex";
  rcFsOverlay.requestFullscreen?.().catch(() => {});
});

rcHeaderFullscreen.addEventListener("click", () => {
  rcFsOverlay.style.display = "flex";
  rcFsOverlay.requestFullscreen?.().catch(() => {});
});

rcCursorToggle.addEventListener("click", () => {
  cursorEnabled = !cursorEnabled;
  rcCursorToggle.classList.toggle("active", cursorEnabled);

  if (!cursorEnabled && cursorActive) {
    handleCursorEnd();
  }

  showToast(cursorEnabled ? "👆 Cursor enabled" : "👆 Cursor disabled");
});

rfsExit.addEventListener("click", () => {
  rcFsOverlay.style.display = "none";
  if (document.fullscreenElement) document.exitFullscreen();
});

document.addEventListener("fullscreenchange", () => {
  if (!document.fullscreenElement) {
    rcFsOverlay.style.display = "none";
    teleOverlay.style.display = "none";
    stopTpScroll();
  }
});

rfsPrev.addEventListener("click", () => sendSlideChange("prev"));
rfsNext.addEventListener("click", () => sendSlideChange("next"));

// ── Theme ─────────────────────────────────────────────────────────────────────
const savedTheme = localStorage.getItem("presenter-theme");
if (savedTheme) document.documentElement.dataset.theme = savedTheme;

// ── Toast ─────────────────────────────────────────────────────────────────────
let toastTimer;
function showToast(msg) {
  toast.textContent = msg;
  toast.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove("show"), 3000);
}

// ── Cursor Control ─────────────────────────────────────────────────────────────
function sendCursorMove(x, y, active) {
  if (socket && socket.connected) {
    socket.emit("cursor-move", { sessionId, x, y, active });
  }
}

// Generate or retrieve persistent device ID
function getDeviceId() {
  let deviceId = localStorage.getItem("pdf-presenter-device-id");
  if (!deviceId) {
    // Fallback for browsers without crypto.randomUUID()
    if (crypto && crypto.randomUUID) {
      deviceId = crypto.randomUUID();
    } else {
      // Generate a random hex string as fallback
      const array = new Uint8Array(16);
      crypto.getRandomValues(array);
      deviceId = Array.from(array, byte => byte.toString(16).padStart(2, '0')).join('');
    }
    localStorage.setItem("pdf-presenter-device-id", deviceId);
  }
  return deviceId;
}

function handleCursorInteraction(e) {
  if (!socket || !socket.connected || !cursorEnabled) return;

  const rect = e.currentTarget.getBoundingClientRect();
  // Simple proportional mapping: touch position directly maps to slide position
  // Full range of control panel maps to full range of slide
  const x = ((e.clientX || e.touches[0].clientX) - rect.left) / rect.width;
  const y = ((e.clientY || e.touches[0].clientY) - rect.top) / rect.height;

  // Clamp to valid range
  const normalizedX = Math.max(0, Math.min(1, x));
  const normalizedY = Math.max(0, Math.min(1, y));

  // Immediate send for maximum responsiveness
  sendCursorMove(normalizedX, normalizedY, true);
}

function handleCursorEnd() {
  cursorActive = false;
  sendCursorMove(0, 0, false);
}

const controlPanel = document.querySelector(".rc-tab-panel");
if (controlPanel) {
  controlPanel.addEventListener("mousedown", (e) => {
    if (e.target.closest("button, input, textarea")) return;
    cursorActive = true;
    handleCursorInteraction(e);
  });

  controlPanel.addEventListener("mousemove", (e) => {
    if (!cursorActive) return;
    if (e.target.closest("button, input, textarea")) {
      handleCursorEnd();
      return;
    }
    handleCursorInteraction(e);
  });

  controlPanel.addEventListener("mouseup", handleCursorEnd);
  controlPanel.addEventListener("mouseleave", handleCursorEnd);

  controlPanel.addEventListener("touchstart", (e) => {
    if (e.target.closest("button, input, textarea")) return;
    cursorActive = true;
    handleCursorInteraction(e);
    e.preventDefault();
  });

  controlPanel.addEventListener("touchmove", (e) => {
    if (!cursorActive) return;
    if (e.target.closest("button, input, textarea")) {
      handleCursorEnd();
      return;
    }
    handleCursorInteraction(e);
    e.preventDefault();
  });

  controlPanel.addEventListener("touchend", handleCursorEnd);
  controlPanel.addEventListener("touchcancel", handleCursorEnd);
}
