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

  socket.on("connect", () =>
    socket.emit("join-session", { sessionId, role: "remote" }),
  );

  socket.on("session-state", ({ currentSlide: cs, totalSlides: ts }) => {
    currentSlide = cs || 1;
    totalSlides = ts || 0;
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
  socket.on("pdf-loaded", ({ filename }) =>
    showToast("📄 " + filename + " loaded"),
  );
  socket.on("connect_error", () => setStatus(false));
  socket.on("disconnect", () => setStatus(false));
  socket.on("reconnect", () => {
    setStatus(true);
    socket.emit("join-session", { sessionId, role: "remote" });
  });
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

// ── Swipe ─────────────────────────────────────────────────────────────────────
let touchStartX = 0;
document.addEventListener(
  "touchstart",
  (e) => {
    if (e.target.closest("textarea,.teleprompter-overlay,.rc-fs-overlay"))
      return;
    touchStartX = e.touches[0].clientX;
  },
  { passive: true },
);
document.addEventListener(
  "touchend",
  (e) => {
    if (e.target.closest("textarea,.teleprompter-overlay,.rc-fs-overlay"))
      return;
    const dx = e.changedTouches[0].clientX - touchStartX;
    if (Math.abs(dx) > 60) {
      dx < 0 ? sendSlideChange("next") : sendSlideChange("prev");
      animateSlideChange();
    }
  },
  { passive: true },
);

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

// Header fullscreen button - same functionality
rcHeaderFullscreen.addEventListener("click", () => {
  rcFsOverlay.style.display = "flex";
  rcFsOverlay.requestFullscreen?.().catch(() => {});
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
