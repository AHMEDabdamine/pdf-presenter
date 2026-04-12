/**
 * PDF Presenter — Presenter Logic
 * MIT License
 *
 * Handles:
 *  - Session creation & PDF upload
 *  - PDF.js rendering to canvas
 *  - Keyboard / touch / swipe navigation
 *  - WebSocket sync (Socket.io)
 *  - QR code modal
 *  - Theme toggle & fullscreen
 *  - Thumbnail strip generation
 *  - Mid-session PDF swap (without closing session)
 */

// ─── PDF.js Configuration ─────────────────────────────────────────────────────
pdfjsLib.GlobalWorkerOptions.workerSrc = "../vendor/pdf.worker.min.js";
pdfjsLib.GlobalWorkerOptions.standardFontDataUrl = "/vendor/standard_fonts/";

// ─── State ────────────────────────────────────────────────────────────────────
const state = {
  sessionId: null,
  pdfDoc: null,
  currentSlide: 1,
  totalSlides: 0,
  rendering: false,
  remoteUrl: null,
  viewerUrl: null,
  uploadToken: null, //  Secure token for API authorization
  connectedRemotes: 0,
  connectedViewers: 0,
  renderTask: null,
};

// ─── DOM References ───────────────────────────────────────────────────────────
const $ = (id) => document.getElementById(id);
const canvas = $("slideCanvas");
const ctx = canvas.getContext("2d");
const slideArea = $("slideArea");
const slideWrapper = $("slideWrapper");
const setupOverlay = $("setupOverlay");
const uploadZone = $("uploadZone");
const fileInput = $("fileInput");
const progressDiv = $("uploadProgress");
const progressFill = $("progressFill");
const progressLabel = $("progressLabel");
const slideCounter = $("slideCounter");
const sessionBadge = $("sessionBadge");
const topbar = $("topbar");
const prevBtn = $("prevBtn");
const nextBtn = $("nextBtn");
const slideStrip = $("slideStrip");
const transOverlay = $("transitionOverlay");
const laserDot = $("laserDot");
const artificialCursor = $("artificialCursor");
const remoteModal = $("remoteModal");
const modalSessId = $("modalSessionId");
const connCount = $("connectedCount");
const remoteUrlEl = $("remoteUrlDisplay");
const qrCanvas = $("qrCanvas");
const toast = $("toast");

// ─── Session Storage Helpers ──────────────────────────────────────────────────

function saveSessionToStorage() {
  if (state.sessionId && state.uploadToken) {
    sessionStorage.setItem("presenter-session-id", state.sessionId);
    sessionStorage.setItem("presenter-upload-token", state.uploadToken);
    // Store URLs for QR code regeneration on refresh
    if (state.remoteUrl) sessionStorage.setItem("presenter-remote-url", state.remoteUrl);
    if (state.viewerUrl) sessionStorage.setItem("presenter-viewer-url", state.viewerUrl);
  }
}

function clearSessionFromStorage() {
  sessionStorage.removeItem("presenter-session-id");
  sessionStorage.removeItem("presenter-upload-token");
  sessionStorage.removeItem("presenter-remote-url");
  sessionStorage.removeItem("presenter-viewer-url");
}

function getSessionFromStorage() {
  return {
    sessionId: sessionStorage.getItem("presenter-session-id"),
    uploadToken: sessionStorage.getItem("presenter-upload-token"),
    remoteUrl: sessionStorage.getItem("presenter-remote-url"),
    viewerUrl: sessionStorage.getItem("presenter-viewer-url"),
  };
}

// ─── Session Init ─────────────────────────────────────────────────────────────

async function initSession(name = null, password = null) {
  try {
    const res = await fetch("/api/session", {
      method: "POST",
      headers: {
        "X-Requested-With": "XMLHttpRequest",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ name, password }),
    });
    const data = await res.json();

    state.sessionId = data.sessionId;
    state.uploadToken = data.uploadToken; //  Store secure token
    state.remoteUrl = data.remoteUrl;
    state.viewerUrl = data.viewerUrl;

    // Persist to sessionStorage for refresh recovery
    saveSessionToStorage();

    // Update UI badges
    if (sessionBadge) sessionBadge.textContent = data.sessionId || "—";
    if (modalSessId) modalSessId.textContent = data.sessionId || "—";
    updateSessionNameDisplay(data.name);

    // Initial QR draw using saved IP address
    const savedIp = localStorage.getItem("presenter-ip");
    refreshQR(savedIp || null);

    // Connect to WebSocket
    connectSocket();

    //  SECURITY: PDF library disabled - shows all files on server, security risk
    // loadPdfLibrary();
  } catch (err) {
    console.error("Session init failed:", err);
    showToast("Could not create session — is the server running?", "warning");
  }
}

// ─── Session Restore ────────────────────────────────────────────────────────────

async function restoreSession() {
  const { sessionId, uploadToken, remoteUrl, viewerUrl } = getSessionFromStorage();
  if (!sessionId || !uploadToken) return false;

  // Restore URLs first so QR generation works immediately
  if (remoteUrl) state.remoteUrl = remoteUrl;
  if (viewerUrl) state.viewerUrl = viewerUrl;

  try {
    // Try to fetch session state from server
    const res = await fetch(`/api/session/${sessionId}`, {
      headers: {
        "X-Requested-With": "XMLHttpRequest",
        "X-Upload-Token": uploadToken,
      },
    });

    if (res.status === 404) {
      // Session no longer exists
      clearSessionFromStorage();
      return false;
    }

    if (!res.ok) {
      clearSessionFromStorage();
      return false;
    }

    const data = await res.json();

    // Restore state
    state.sessionId = sessionId;
    state.uploadToken = uploadToken;
    state.currentSlide = data.currentSlide || 1;
    state.totalSlides = data.totalSlides || 0;
    // Rebuild URLs with current host if needed (for when hostname changed)
    if (!state.remoteUrl) {
      state.remoteUrl = `${window.location.origin}/remote.html?session=${sessionId}`;
    }
    if (!state.viewerUrl) {
      state.viewerUrl = `${window.location.origin}/viewer.html?session=${sessionId}`;
    }

    // Update UI
    if (sessionBadge) sessionBadge.textContent = sessionId || "—";
    if (modalSessId) modalSessId.textContent = sessionId || "—";
    updateSessionNameDisplay(data.name);
    updateCounterUI();

    // Regenerate QR codes with restored URLs
    const savedIp = localStorage.getItem("presenter-ip");
    refreshQR(savedIp || null);

    // Connect to WebSocket
    connectSocket();

    // If there's a PDF, load it
    if (data.pdfFile) {
      loadPdfFromUrl(data.pdfFile, null, { skipNotify: true });
    } else {
      // Show setup overlay for PDF upload only (session already exists)
      setupOverlay.style.display = "flex";
      // Hide session creation elements, show only upload
      const startBtn = $("startSessionBtn");
      const nameInput = $("sessionNameInput");
      const nameInputDiv = nameInput?.parentElement;
      const uploadZone = $("uploadZone");
      const subtitle = $("setupSubtitle");

      if (startBtn) startBtn.style.display = "none";
      if (nameInputDiv) nameInputDiv.style.display = "none";
      if (uploadZone) uploadZone.style.display = "block";
      if (subtitle) subtitle.textContent = "Session restored! Upload a PDF to continue presenting.";
    }

    //  SECURITY: PDF library disabled - shows all files on server, security risk
    // loadPdfLibrary();

    showToast("Session restored", "success");
    return true;
  } catch (err) {
    console.error("Session restore failed:", err);
    clearSessionFromStorage();
    return false;
  }
}

// ─── End Session ────────────────────────────────────────────────────────────────

function endSession() {
  if (!socket || !state.sessionId) return;

  // Emit end-session event to server
  socket.emit("end-session", { sessionId: state.sessionId });

  // Clear session storage
  clearSessionFromStorage();

  // Disconnect socket
  socket.disconnect();

  // Redirect to home/start screen
  window.location.href = "/";
}

// ─── Session Name UI ────────────────────────────────────────────────────────────

function updateSessionNameDisplay(name) {
  const nameEl = $("sessionNameDisplay");
  const endBtn = $("endSessionBtn");
  if (nameEl) {
    nameEl.textContent = name || "Untitled Session";
    nameEl.style.display = "inline";
  }
  if (endBtn) {
    endBtn.style.display = "inline-block";
  }
}

function renameSession(newName) {
  if (!socket || !state.sessionId) return;
  socket.emit("rename-session", { sessionId: state.sessionId, name: newName });
}

// ─── WebSocket ────────────────────────────────────────────────────────────────

let socket;

function connectSocket() {
  socket = io({ transports: ["websocket", "polling"] });

  socket.on("connect", () => {
    socket.emit("join-session", {
      sessionId: state.sessionId,
      role: "presenter",
    });
  });

  // Remote sent a slide change command
  socket.on("slide-update", ({ currentSlide }) => {
    if (currentSlide !== state.currentSlide) {
      goToSlide(currentSlide, "remote");
    }
  });

  // New PDF loaded (from another tab / device)
  socket.on("pdf-loaded", ({ pdfUrl, filename }) => {
    loadPdfFromUrl(pdfUrl, filename, { skipNotify: true });
  });

  // Laser pointer from remote
  socket.on("pointer-update", ({ x, y, active }) => {
    if (active) {
      const rect = canvas.getBoundingClientRect();
      laserDot.style.display = "block";
      laserDot.style.left = x * rect.width + "px";
      laserDot.style.top = y * rect.height + "px";
    } else {
      laserDot.style.display = "none";
    }
  });

  // Artificial cursor from remote
  socket.on("cursor-move", ({ x, y, active }) => {
    if (active) {
      const rect = canvas.getBoundingClientRect();
      // Clamp coordinates to keep cursor within slide boundaries (0-1 range)
      const clampedX = Math.max(0, Math.min(1, x));
      const clampedY = Math.max(0, Math.min(1, y));
      const cursorX = clampedX * rect.width;
      const cursorY = clampedY * rect.height;

      // Direct update for maximum responsiveness
      artificialCursor.style.left = cursorX + "px";
      artificialCursor.style.top = cursorY + "px";
      artificialCursor.classList.add("active");
    } else {
      artificialCursor.classList.remove("active");
    }
  });

  socket.on("connect_error", () => showToast("WebSocket connection lost", "warning"));

  socket.on("remote-count", ({ count }) => {
    state.connectedRemotes = count;
    connCount.textContent = `${count} remote(s) connected · ${state.connectedViewers} viewer(s)`;
  });

  socket.on("viewer-count", ({ count }) => {
    state.connectedViewers = count;
    connCount.textContent = `${state.connectedRemotes} remote(s) connected · ${count} viewer(s)`;
  });

  //  Remote approval system
  socket.on("remote-pending", ({ socketId, deviceId, count }) => {
    // Play notification sound
    const audio = new Audio("/notification.wav");
    audio.play().catch(() => {}); // Ignore autoplay restrictions
    showRemoteApprovalDialog(socketId, deviceId, count);
  });

  socket.on("remote-accepted", ({ remoteSocketId }) => {
    showToast(`✓ Remote ${remoteSocketId.slice(0, 8)}... accepted`);
  });

  socket.on("remote-rejected", ({ remoteSocketId }) => {
    showToast(`✗ Remote ${remoteSocketId.slice(0, 8)}... rejected`);
  });

  // Session renamed
  socket.on("session-renamed", ({ name }) => {
    updateSessionNameDisplay(name);
    showToast(`✓ Session renamed to "${name}"`);
  });

  // Session ended (from another tab or explicit end)
  socket.on("session-ended", ({ message }) => {
    clearSessionFromStorage();
    showToast(`⚠ ${message}`);
    setTimeout(() => {
      window.location.href = "/";
    }, 2000);
  });
}

// ─── Remote Approval UI ───────────────────────────────────────────────────────

let pendingRemotes = [];
let remoteRequestsEnabled = true; // Local state for toggle

function showRemoteApprovalDialog(socketId, deviceId, count) {
  pendingRemotes.push({ socketId, deviceId });

  // Create or update the approval dialog
  let dialog = $("remoteApprovalDialog");
  if (!dialog) {
    dialog = document.createElement("div");
    dialog.id = "remoteApprovalDialog";
    dialog.className = "remote-approval-dialog";
    document.body.appendChild(dialog);
  }

  // Show device ID for identification
  const displayId = deviceId ? deviceId.slice(0, 8) : socketId.slice(0, 12);

  // Escape HTML to prevent XSS
  const escapeHtml = (text) => {
    const div = document.createElement("div");
    div.textContent = text;
    return div.innerHTML;
  };

  const pending = pendingRemotes[0];

  dialog.innerHTML = `
    <div class="remote-approval-content">
      <div class="remote-approval-header">
        <h3>🔐 Remote Access Request</h3>
        <button class="btn-close" onclick="dismissRemoteDialog()" title="Dismiss">✕</button>
      </div>
      <p>${escapeHtml(String(count))} remote(s) waiting</p>
      <p class="remote-id">Device: ${escapeHtml(displayId)}...</p>
      <div class="remote-approval-buttons">
        <button class="btn-approve" onclick="approveRemote('${escapeHtml(pending.socketId)}')">Accept</button>
        <button class="btn-reject" onclick="rejectRemote('${escapeHtml(pending.socketId)}')">Reject</button>
        <button class="btn-block" onclick="blockRemote('${escapeHtml(pending.socketId)}', '${escapeHtml(pending.deviceId || "")}')" title="Block this device">Block</button>
      </div>
    </div>
  `;
  dialog.style.display = "block";
}

function approveRemote(socketId) {
  socket.emit("remote-accept", { sessionId: state.sessionId, remoteSocketId: socketId });
  hideRemoteApprovalDialog(socketId);
}

function rejectRemote(socketId) {
  socket.emit("remote-reject", { sessionId: state.sessionId, remoteSocketId: socketId });
  hideRemoteApprovalDialog(socketId);
}

function blockRemote(socketId, deviceId) {
  if (deviceId) {
    socket.emit("remote-block", { sessionId: state.sessionId, deviceId });
    showToast("✓ Device blocked from future requests");
  }
  // Also reject the current request
  socket.emit("remote-reject", { sessionId: state.sessionId, remoteSocketId: socketId });
  hideRemoteApprovalDialog(socketId);
}

function dismissRemoteDialog() {
  const dialog = $("remoteApprovalDialog");
  if (dialog) dialog.style.display = "none";
}

function hideRemoteApprovalDialog(socketId) {
  pendingRemotes = pendingRemotes.filter(r => r.socketId !== socketId);
  const dialog = $("remoteApprovalDialog");
  if (dialog && pendingRemotes.length === 0) {
    dialog.style.display = "none";
  } else if (dialog && pendingRemotes.length > 0) {
    // Show next pending remote
    showRemoteApprovalDialog(pendingRemotes[0].socketId, pendingRemotes[0].deviceId, pendingRemotes.length);
  }
}

// Toggle remote requests on/off
function toggleRemoteRequests() {
  remoteRequestsEnabled = !remoteRequestsEnabled;
  socket.emit("toggle-remote-requests", { sessionId: state.sessionId, enabled: remoteRequestsEnabled });
  showToast(remoteRequestsEnabled ? "✓ Remote requests enabled" : "✕ Remote requests disabled");
  // Update button if it exists
  const btn = $("toggleRemoteRequestsBtn");
  if (btn) {
    btn.textContent = remoteRequestsEnabled ? "Disable Remote Requests" : "Enable Remote Requests";
    btn.style.background = remoteRequestsEnabled ? "var(--danger)" : "var(--success)";
  }
}

// ─── PDF Upload ───────────────────────────────────────────────────────────────

// Drag & drop handlers
uploadZone.addEventListener("dragover", (e) => {
  e.preventDefault();
  uploadZone.classList.add("drag-over");
});
uploadZone.addEventListener("dragleave", () =>
  uploadZone.classList.remove("drag-over"),
);
uploadZone.addEventListener("drop", (e) => {
  e.preventDefault();
  uploadZone.classList.remove("drag-over");
  const files = Array.from(e.dataTransfer.files).filter(
    (f) => f.type === "application/pdf",
  );
  if (files.length) handleFileSelect(files[0]);
});
uploadZone.addEventListener("click", (e) => {
  if (e.target !== fileInput) fileInput.click();
});
fileInput.addEventListener("change", () => {
  if (fileInput.files[0]) handleFileSelect(fileInput.files[0]);
});

function handleFileSelect(file) {
  if (!file || file.type !== "application/pdf") {
    showToast("⚠ Please select a valid PDF file");
    return;
  }
  uploadFile(file);
}

async function uploadFile(file) {
  progressDiv.style.display = "block";
  progressFill.style.width = "0%";
  progressLabel.textContent = "Uploading…";

  // Show the setup overlay in swap mode (keeps session alive)
  showSwapOverlay();

  const formData = new FormData();
  formData.append("pdf", file);

  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", `/api/upload/${state.sessionId}`);
    xhr.setRequestHeader("X-Upload-Token", state.uploadToken); //  Auth header
    xhr.setRequestHeader("X-Requested-With", "XMLHttpRequest"); //  CSRF protection

    xhr.upload.onprogress = (e) => {
      const pct = Math.round((e.loaded / e.total) * 90);
      progressFill.style.width = pct + "%";
      progressLabel.textContent = `Uploading… ${pct}%`;
    };

    xhr.onload = async () => {
      if (xhr.status === 200) {
        const data = JSON.parse(xhr.responseText);
        progressFill.style.width = "100%";
        progressLabel.textContent = "Processing PDF…";
        await loadPdfFromUrl(data.pdfUrl, data.filename);
        resolve(data);
      } else {
        showToast(
          "⚠ Upload failed: " +
            (JSON.parse(xhr.responseText)?.error || "Unknown error"),
        );
        progressDiv.style.display = "none";
        hideSwapOverlay();
        reject();
      }
    };

    xhr.onerror = () => {
      showToast("⚠ Network error during upload");
      hideSwapOverlay();
      reject();
    };
    xhr.send(formData);
  });
}

// ─── Swap Overlay Helpers ─────────────────────────────────────────────────────

/**
 * Show the setup overlay in "swap" mode — the session stays alive,
 * we just let the presenter pick a new PDF.
 */
function showSwapOverlay() {
  setupOverlay.classList.remove("hide");
  setupOverlay.dataset.swapMode = "true";

  // Show a cancel button when swapping (not on first load)
  if (state.pdfDoc) {
    let cancelBtn = $("swapCancelBtn");
    if (!cancelBtn) {
      cancelBtn = document.createElement("button");
      cancelBtn.id = "swapCancelBtn";
      cancelBtn.className = "btn swap-cancel-btn";
      cancelBtn.textContent = "✕ Cancel";
      cancelBtn.addEventListener("click", hideSwapOverlay);
      setupOverlay.querySelector(".setup-card").appendChild(cancelBtn);
    }
    cancelBtn.style.display = "inline-flex";
  }
}

function hideSwapOverlay() {
  // Only hide if a PDF is already loaded
  if (state.pdfDoc) {
    setupOverlay.classList.add("hide");
    delete setupOverlay.dataset.swapMode;
    progressDiv.style.display = "none";
    const cancelBtn = $("swapCancelBtn");
    if (cancelBtn) cancelBtn.style.display = "none";
    // Reset file input so same file can be re-selected
    fileInput.value = "";
  }
}

// ─── PDF Rendering ────────────────────────────────────────────────────────────

async function loadPdfFromUrl(url, filename = "", { skipNotify = false } = {}) {
  try {
    const loadingTask = pdfjsLib.getDocument(url);
    const pdfDoc = await loadingTask.promise;

    state.pdfDoc = pdfDoc;
    state.totalSlides = pdfDoc.numPages;
    state.currentSlide = 1;

    if (socket?.connected && !skipNotify) {
      socket.emit("set-total-slides", {
        sessionId: state.sessionId,
        totalSlides: pdfDoc.numPages,
      });
      socket.emit("pdf-file-loaded", {
        sessionId: state.sessionId,
        pdfUrl: url,
        filename: filename || "Presentation.pdf",
      });
    }

    // Hide setup overlay and swap overlay
    setupOverlay.classList.add("hide");
    delete setupOverlay.dataset.swapMode;
    progressDiv.style.display = "none";
    const cancelBtn = $("swapCancelBtn");
    if (cancelBtn) cancelBtn.style.display = "none";
    fileInput.value = "";

    // Render first slide
    await renderSlide(1);

    // Build thumbnail strip (async, non-blocking)
    buildThumbnailStrip();

    showToast(`📄 ${filename || "PDF"} loaded — ${pdfDoc.numPages} slides`);
  } catch (err) {
    console.error("PDF load error:", err);
    showToast("⚠ Failed to load PDF: " + err.message);
    progressDiv.style.display = "none";
    hideSwapOverlay();
  }
}

async function renderSlide(pageNum) {
  if (!state.pdfDoc || state.rendering) return;
  if (pageNum < 1 || pageNum > state.totalSlides) return;

  state.rendering = true;

  try {
    const page = await state.pdfDoc.getPage(pageNum);
    const inFS = !!document.fullscreenElement;

    const maxW = inFS ? slideArea.clientWidth : slideArea.clientWidth - 60;
    const maxH = inFS ? slideArea.clientHeight : slideArea.clientHeight - 40;

    const viewport = page.getViewport({ scale: 1 });
    const scale = Math.min(maxW / viewport.width, maxH / viewport.height);
    const vp = page.getViewport({ scale });

    canvas.width = vp.width;
    canvas.height = vp.height;

    if (state.renderTask) state.renderTask.cancel();
    state.renderTask = page.render({ canvasContext: ctx, viewport: vp });

    await state.renderTask.promise;
    state.renderTask = null;

    await setupLinkHandlers(page, vp);

    state.currentSlide = pageNum;
    updateCounterUI();
    updateStripHighlight();
  } catch (err) {
    if (err?.name !== "RenderingCancelledException") {
      console.error("Render error:", err);
    }
  } finally {
    state.rendering = false;
  }
}

// ─── PDF Link Handling ────────────────────────────────────────────────────────

let currentLinks = [];
let linkHighlightCanvas = null;
let linkHighlightCtx = null;

function createLinkHighlightCanvas() {
  if (!linkHighlightCanvas) {
    linkHighlightCanvas = document.createElement("canvas");
    linkHighlightCanvas.style.position = "absolute";
    linkHighlightCanvas.style.top = "0";
    linkHighlightCanvas.style.left = "0";
    linkHighlightCanvas.style.pointerEvents = "none";
    linkHighlightCanvas.style.zIndex = "10";
    linkHighlightCtx = linkHighlightCanvas.getContext("2d");
    slideWrapper.appendChild(linkHighlightCanvas);
  }
}

async function setupLinkHandlers(page, viewport) {
  try {
    const annotations = await page.getAnnotations();
    currentLinks = [];

    for (const annotation of annotations) {
      if (annotation.subtype === "Link") {
        const rect = viewport.convertToViewportRectangle(annotation.rect);
        const [x1, y1, x2, y2] = rect;

        currentLinks.push({
          x: Math.min(x1, x2),
          y: Math.min(y1, y2),
          width: Math.abs(x2 - x1),
          height: Math.abs(y2 - y1),
          url: annotation.url || (annotation.action && annotation.action.url),
        });
      }
    }

    createLinkHighlightCanvas();
    updateLinkHighlight();
  } catch (err) {
    console.warn("Could not load link annotations:", err);
    currentLinks = [];
  }
}

function updateLinkHighlight(hoveredLink = null) {
  if (!linkHighlightCtx) return;

  linkHighlightCtx.clearRect(
    0,
    0,
    linkHighlightCanvas.width,
    linkHighlightCanvas.height,
  );

  if (hoveredLink === null || !currentLinks.length) return;

  linkHighlightCanvas.width = canvas.width;
  linkHighlightCanvas.height = canvas.height;

  const link = currentLinks[hoveredLink];

  linkHighlightCtx.fillStyle = "rgba(59, 130, 246, 0.3)";
  linkHighlightCtx.fillRect(link.x, link.y, link.width, link.height);

  linkHighlightCtx.strokeStyle = "rgba(59, 130, 246, 0.8)";
  linkHighlightCtx.lineWidth = 2;
  linkHighlightCtx.strokeRect(link.x, link.y, link.width, link.height);
}

canvas.addEventListener("click", (e) => {
  if (!currentLinks.length) return;

  const rect = canvas.getBoundingClientRect();
  const x = (e.clientX - rect.left) * (canvas.width / rect.width);
  const y = (e.clientY - rect.top) * (canvas.height / rect.height);

  for (const link of currentLinks) {
    if (
      x >= link.x &&
      x <= link.x + link.width &&
      y >= link.y &&
      y <= link.y + link.height
    ) {
      if (link.url) {
        window.open(link.url, "_blank", "noopener,noreferrer");
      }
      break;
    }
  }
});

canvas.addEventListener("mousemove", (e) => {
  if (!currentLinks.length) {
    canvas.style.cursor = "default";
    updateLinkHighlight();
    return;
  }

  const rect = canvas.getBoundingClientRect();
  const x = (e.clientX - rect.left) * (canvas.width / rect.width);
  const y = (e.clientY - rect.top) * (canvas.height / rect.height);

  let hoveredLinkIndex = -1;
  for (let i = 0; i < currentLinks.length; i++) {
    const link = currentLinks[i];
    if (
      x >= link.x &&
      x <= link.x + link.width &&
      y >= link.y &&
      y <= link.y + link.height
    ) {
      hoveredLinkIndex = i;
      break;
    }
  }

  canvas.style.cursor = hoveredLinkIndex >= 0 ? "pointer" : "default";
  updateLinkHighlight(hoveredLinkIndex >= 0 ? hoveredLinkIndex : null);
});

canvas.addEventListener("mouseleave", () => {
  updateLinkHighlight();
});

// ─── Navigation ───────────────────────────────────────────────────────────────

async function goToSlide(num, source = "local") {
  if (!state.pdfDoc) return;
  num = Math.max(1, Math.min(num, state.totalSlides));
  if (num === state.currentSlide) return;

  transOverlay.classList.add("flash");
  setTimeout(() => transOverlay.classList.remove("flash"), 180);

  await renderSlide(num);

  if (source === "local" && socket?.connected) {
    socket.emit("slide-change", {
      sessionId: state.sessionId,
      slide: num,
    });
  }
}

function nextSlide() {
  goToSlide(state.currentSlide + 1);
}
function prevSlide() {
  goToSlide(state.currentSlide - 1);
}

nextBtn.addEventListener("click", nextSlide);
prevBtn.addEventListener("click", prevSlide);

document.addEventListener("keydown", (e) => {
  if (remoteModal.style.display !== "none") return;
  // Don't intercept keys when swap overlay is open
  if (!setupOverlay.classList.contains("hide")) return;
  switch (e.key) {
    case "ArrowRight":
    case "ArrowDown":
    case " ":
    case "PageDown":
      e.preventDefault();
      nextSlide();
      break;
    case "ArrowLeft":
    case "ArrowUp":
    case "PageUp":
      e.preventDefault();
      prevSlide();
      break;
    case "f":
    case "F":
      toggleFullscreen();
      break;
    case "Escape":
      if (remoteModal.style.display !== "none") closeRemoteModal();
      else hideSwapOverlay();
      break;
  }
});

let touchStartX = 0;
slideArea.addEventListener(
  "touchstart",
  (e) => {
    touchStartX = e.touches[0].clientX;
  },
  { passive: true },
);
slideArea.addEventListener(
  "touchend",
  (e) => {
    const dx = e.changedTouches[0].clientX - touchStartX;
    if (Math.abs(dx) > 50) dx < 0 ? nextSlide() : prevSlide();
  },
  { passive: true },
);

// ─── Counter & Strip ──────────────────────────────────────────────────────────

function updateCounterUI() {
  slideCounter.textContent = `${state.currentSlide} / ${state.totalSlides}`;
  prevBtn.disabled = state.currentSlide <= 1;
  nextBtn.disabled = state.currentSlide >= state.totalSlides;
}

async function buildThumbnailStrip() {
  slideStrip.innerHTML = "";
  const doc = state.pdfDoc;
  if (!doc) return;

  for (let i = 1; i <= doc.numPages; i++) {
    const wrapper = document.createElement("div");
    wrapper.className = "strip-thumb" + (i === 1 ? " active" : "");
    wrapper.dataset.page = i;
    wrapper.title = `Slide ${i}`;

    const thumbCanvas = document.createElement("canvas");
    wrapper.appendChild(thumbCanvas);
    slideStrip.appendChild(wrapper);

    wrapper.addEventListener("click", () =>
      goToSlide(parseInt(wrapper.dataset.page)),
    );

    (async (pageNum, tc) => {
      try {
        const page = await doc.getPage(pageNum);
        const vp = page.getViewport({ scale: 0.2 });
        tc.width = vp.width;
        tc.height = vp.height;
        await page.render({ canvasContext: tc.getContext("2d"), viewport: vp })
          .promise;
      } catch {
        /* ignore cancelled renders */
      }
    })(i, thumbCanvas);
  }
}

function updateStripHighlight() {
  document.querySelectorAll(".strip-thumb").forEach((el) => {
    el.classList.toggle(
      "active",
      parseInt(el.dataset.page) === state.currentSlide,
    );
  });
  const active = slideStrip.querySelector(".strip-thumb.active");
  if (active)
    active.scrollIntoView({
      behavior: "smooth",
      inline: "center",
      block: "nearest",
    });
}

// ─── PDF Library ──────────────────────────────────────────────────────────────

async function loadPdfLibrary() {
  try {
    const res = await fetch("/api/pdfs", {
      headers: {
        "X-Requested-With": "XMLHttpRequest",
        "X-Session-Id": state.sessionId,
        "X-Upload-Token": state.uploadToken, //  Auth headers
      },
    });
    const pdfs = await res.json();
    const libList = $("libraryList");
    
    if (!pdfs.length) {
      $("pdfLibrary").style.display = "none";
      return;
    }

    // Escape HTML helper
    const escapeHtml = (text) => {
      const div = document.createElement("div");
      div.textContent = text;
      return div.innerHTML;
    };
    
    $("pdfLibrary").style.display = "block";
    libList.innerHTML = pdfs
      .slice(0, 5)
      .map(
        (p) =>
          `<div class="library-item" data-url="${escapeHtml(p.url)}" data-filename="${escapeHtml(p.name)}">
        <span class="library-name">${escapeHtml(decodeURIComponent(p.name.replace(/^\d+-/, "")))}</span>
        <div class="library-actions">
          <span class="library-load">Load →</span>
          <button class="library-delete" title="Delete file">🗑️</button>
        </div>
      </div>`,
      )
      .join("");

    libList.querySelectorAll(".library-item").forEach((el) => {
      el.addEventListener("click", (e) => {
        if (e.target.closest(".library-delete")) return;
        loadPdfFromUrl(el.dataset.url);
      });
    });

    libList.querySelectorAll(".library-delete").forEach((btn) => {
      btn.addEventListener("click", async (e) => {
        e.stopPropagation();
        const item = btn.closest(".library-item");
        const filename = item.dataset.filename;
        if (!confirm(`Delete "${decodeURIComponent(filename.replace(/^\d+-/, ""))}"?`)) return;
        
        try {
          const res = await fetch(`/api/pdfs/${encodeURIComponent(filename)}`, {
            method: "DELETE",
            headers: {
              "X-Requested-With": "XMLHttpRequest",
              "X-Session-Id": state.sessionId,
              "X-Upload-Token": state.uploadToken, //  Auth headers
            },
          });
          if (res.ok) {
            item.remove();
            showToast("✓ File deleted");
            // Hide library if empty
            if (!libList.querySelectorAll(".library-item").length) {
              $("pdfLibrary").style.display = "none";
            }
          } else {
            showToast("⚠ Failed to delete file");
          }
        } catch {
          showToast("⚠ Failed to delete file");
        }
      });
    });
  } catch {
    /* ignore */
  }
}

// ─── Change PDF Button ────────────────────────────────────────────────────────

const changePdfBtn = $("changePdfBtn");
if (changePdfBtn) {
  changePdfBtn.addEventListener("click", () => {
    //  SECURITY: PDF library disabled - shows all files on server, security risk
    // loadPdfLibrary();
    showSwapOverlay();
  });
}

// ─── Remote Modal & QR ───────────────────────────────────────────────────────

$("showRemoteBtn").addEventListener("click", async () => {
  remoteModal.style.display = "flex";

  const savedIp = localStorage.getItem("presenter-ip");
  if (savedIp) {
    $("ipInput").value = savedIp;
  } else {
    // Auto-detect machine LAN IP and pre-fill input (without applying to QR)
    try {
      const res = await fetch("/api/ip");
      if (res.ok) {
        const data = await res.json();
        const selector = $("ipSelector");
        if (data.all && data.all.length > 1) {
          // Multiple interfaces — show dropdown
          selector.innerHTML = "";
          data.all.forEach(({ address, interface: iface }) => {
            const opt = document.createElement("option");
            opt.value = address;
            opt.textContent = `${address} (${iface})`;
            selector.appendChild(opt);
          });
          selector.style.display = "block";
          $("ipInput").value = data.all[0].address;
          $("ipNote").textContent = "Multiple networks detected — select or type IP, then Apply";
          $("ipNote").style.color = "var(--text-3)";
        } else if (data.ip) {
          $("ipInput").value = data.ip;
          $("ipNote").textContent = "Detected LAN IP — click Apply to update QR";
          $("ipNote").style.color = "var(--text-3)";
        }
      }
    } catch {}
  }

  // Regenerate QR when modal opens (canvas needs to be visible)
  refreshQR(savedIp || null);
});
$("closeRemoteModal").addEventListener("click", closeRemoteModal);
remoteModal.addEventListener("click", (e) => {
  if (e.target === remoteModal) closeRemoteModal();
});

function closeRemoteModal() {
  remoteModal.style.display = "none";
}

function buildRemoteUrl(ipOverride, urlType = "remote") {
  const base = urlType === "viewer" ? state.viewerUrl : state.remoteUrl;
  if (!ipOverride) return base;
  try {
    const u = new URL(base);
    u.hostname = ipOverride.trim();
    return u.toString();
  } catch {
    return base;
  }
}

function refreshQR(ipOverride) {
  const remoteUrl = buildRemoteUrl(ipOverride, "remote");
  state.remoteUrl = remoteUrl;

  const viewerUrl = buildRemoteUrl(ipOverride, "viewer");
  state.viewerUrl = viewerUrl;

  if (remoteUrlEl) remoteUrlEl.textContent = remoteUrl || "—";

  // Only generate QR if canvas is visible (has dimensions)
  if (!qrCanvas || qrCanvas.offsetWidth === 0 || qrCanvas.offsetHeight === 0) {
    return; // Canvas not visible, skip generation (will retry when modal opens)
  }

  if (!remoteUrl) return; // No URL to encode

  try {
    new QRious({
      element: qrCanvas,
      value: remoteUrl,
      size: 200,
      background: "#ffffff",
      foreground: "#1a1a2e",
    });

    const viewerQrCanvas = $("viewerQrCanvas");
    if (viewerQrCanvas && state.viewerUrl && viewerQrCanvas.offsetWidth > 0) {
      new QRious({
        element: viewerQrCanvas,
        value: viewerUrl,
        size: 200,
        background: "#ffffff",
        foreground: "#1a1a2e",
      });
    }
  } catch (e) {
    console.error("QR generation failed:", e);
  }
}

$("applyIpBtn").addEventListener("click", () => {
  const ip = $("ipInput").value.trim();
  const ipNote = $("ipNote");

  if (ip && !/^[\d.a-zA-Z:-]+$/.test(ip)) {
    ipNote.textContent = "⚠ Invalid IP address";
    ipNote.style.color = "var(--danger)";
    return;
  }

  if (ip) {
    localStorage.setItem("presenter-ip", ip);
  } else {
    localStorage.removeItem("presenter-ip");
  }

  refreshQR(ip || null);
  ipNote.textContent = ip
    ? `✓ QR now points to ${ip}`
    : "Using localhost (LAN devices won't reach this)";
  ipNote.style.color = ip ? "var(--success)" : "var(--text-3)";
  showToast(ip ? `✓ QR updated to ${ip}` : "✓ Reset to localhost");
});

$("ipInput").addEventListener("keydown", (e) => {
  if (e.key === "Enter") $("applyIpBtn").click();
});

$("ipSelector").addEventListener("change", (e) => {
  $("ipInput").value = e.target.value;
});

$("copyUrlBtn").addEventListener("click", () => {
  if (!state.remoteUrl) return;
  
  // Check if clipboard API is available (requires secure context - HTTPS)
  if (!navigator.clipboard || !navigator.clipboard.writeText) {
    // Fallback for HTTP/non-secure contexts - copy manually
    const textArea = document.createElement("textarea");
    textArea.value = state.remoteUrl;
    textArea.style.position = "fixed";
    textArea.style.left = "-9999px";
    document.body.appendChild(textArea);
    textArea.select();
    try {
      document.execCommand("copy");
      showToast("✓ Link copied to clipboard");
    } catch (err) {
      showToast("⚠ Copy failed — select the URL manually");
    }
    document.body.removeChild(textArea);
    return;
  }
  
  navigator.clipboard
    .writeText(state.remoteUrl)
    .then(() => showToast("✓ Link copied to clipboard"))
    .catch(() => showToast("⚠ Copy failed — select the URL manually"));
});

// ─── Viewer Modal & QR ───────────────────────────────────────────────────────

const viewerModal = $("viewerModal");
let currentOrientation = localStorage.getItem("presenter-orientation") || "landscape";

function updateOrientationButtons() {
  const landscapeBtn = $("orientLandscape");
  const portraitBtn = $("orientPortrait");
  if (landscapeBtn && portraitBtn) {
    landscapeBtn.classList.toggle("active", currentOrientation === "landscape");
    portraitBtn.classList.toggle("active", currentOrientation === "portrait");
  }
}

$("showViewerBtn").addEventListener("click", () => {
  viewerModal.style.display = "flex";
  updateOrientationButtons();
  const savedIp = localStorage.getItem("presenter-ip");
  refreshViewerQR(savedIp || null);
});

$("closeViewerModal").addEventListener("click", closeViewerModal);
viewerModal.addEventListener("click", (e) => {
  if (e.target === viewerModal) closeViewerModal();
});

function closeViewerModal() {
  viewerModal.style.display = "none";
}

$("orientLandscape").addEventListener("click", () => {
  currentOrientation = "landscape";
  localStorage.setItem("presenter-orientation", currentOrientation);
  updateOrientationButtons();
  showToast("✓ Orientation set to Landscape");
  const savedIp = localStorage.getItem("presenter-ip");
  refreshViewerQR(savedIp || null);
});

$("orientPortrait").addEventListener("click", () => {
  currentOrientation = "portrait";
  localStorage.setItem("presenter-orientation", currentOrientation);
  updateOrientationButtons();
  showToast("✓ Orientation set to Portrait");
  const savedIp = localStorage.getItem("presenter-ip");
  refreshViewerQR(savedIp || null);
});

function refreshViewerQR(ipOverride) {
  if (!state.viewerUrl) return;

  let viewerUrl = buildRemoteUrl(ipOverride, "viewer");
  const url = new URL(viewerUrl);
  url.searchParams.set("orient", currentOrientation);
  viewerUrl = url.toString();

  const viewerUrlDisplay = $("viewerUrlDisplay");
  if (viewerUrlDisplay) viewerUrlDisplay.textContent = viewerUrl;

  const viewerCountEl = $("viewerCount");
  if (viewerCountEl) {
    viewerCountEl.textContent = `${state.connectedViewers} viewer(s) connected`;
  }

  const viewerModalSessionId = $("viewerModalSessionId");
  if (viewerModalSessionId) viewerModalSessionId.textContent = state.sessionId || "—";

  const viewerQrCanvas = $("viewerQrCanvas");
  if (viewerQrCanvas) {
    try {
      new QRious({
        element: viewerQrCanvas,
        value: viewerUrl,
        size: 200,
        background: "#ffffff",
        foreground: "#1a1a2e",
      });
    } catch (e) {
      console.error("Viewer QR generation failed:", e);
    }
  }
}

$("copyViewerUrlBtn").addEventListener("click", () => {
  if (!state.viewerUrl) return;
  const url = new URL(buildRemoteUrl(null, "viewer"));
  url.searchParams.set("orient", currentOrientation);
  const urlString = url.toString();
  
  if (navigator.clipboard && window.isSecureContext) {
    navigator.clipboard
      .writeText(urlString)
      .then(() => showToast("✓ Viewer link copied"))
      .catch(() => showToast("⚠ Copy failed"));
  } else {
    // Fallback for non-secure contexts (HTTP)
    const textArea = document.createElement("textarea");
    textArea.value = urlString;
    textArea.style.position = "fixed";
    textArea.style.left = "-9999px";
    document.body.appendChild(textArea);
    textArea.focus();
    textArea.select();
    try {
      document.execCommand("copy");
      showToast("✓ Viewer link copied");
    } catch (err) {
      showToast("⚠ Copy failed - please copy manually");
      console.error("Copy failed:", err);
    }
    document.body.removeChild(textArea);
  }
});

// ─── Theme Toggle ─────────────────────────────────────────────────────────────

const themeToggle = $("themeToggle");
let isDark = true;

themeToggle.addEventListener("click", () => {
  isDark = !isDark;
  document.documentElement.dataset.theme = isDark ? "dark" : "light";
  themeToggle.innerHTML = isDark ? '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="5"/><path d="M12 1v2m0 18v2M4.22 4.22l1.42 1.42m12.72 12.72l1.42 1.42M1 12h2m18 0h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42"/></svg>' : '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 12.79A9 9 0 1111.21 3 7 7 0 0021 12.79z"/></svg>';
  localStorage.setItem("presenter-theme", isDark ? "dark" : "light");
});

const savedTheme = localStorage.getItem("presenter-theme");
if (savedTheme === "light") {
  isDark = false;
  document.documentElement.dataset.theme = "light";
  themeToggle.innerHTML = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 12.79A9 9 0 1111.21 3 7 7 0 0021 12.79z"/></svg>';
}

// ─── Fullscreen ───────────────────────────────────────────────────────────────

const fullscreenBtn = $("fullscreenBtn");

function toggleFullscreen() {
  if (!document.fullscreenElement) {
    document.documentElement.requestFullscreen().catch(() => {});
    fullscreenBtn.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M8 3H5a2 2 0 00-2 2v3m18 0V5a2 2 0 00-2-2h-3m0 18h3a2 2 0 002-2v-3M3 16v3a2 2 0 002 2h3"/></svg>';
  } else {
    document.exitFullscreen();
  }
}

fullscreenBtn.addEventListener("click", toggleFullscreen);

document.addEventListener("fullscreenchange", () => {
  const inFS = !!document.fullscreenElement;
  fullscreenBtn.innerHTML = inFS ? '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M8 3v3a2 2 0 01-2 2H3m18 0h-3a2 2 0 01-2-2V3m0 18v-3a2 2 0 012-2h3M3 16h3a2 2 0 012 2v3"/></svg>' : '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M8 3H5a2 2 0 00-2 2v3m18 0V5a2 2 0 00-2-2h-3m0 18h3a2 2 0 002-2v-3M3 16v3a2 2 0 002 2h3"/></svg>';
  topbar.classList.toggle("hidden", inFS);
  slideStrip.classList.toggle("fs-hidden", inFS);
  slideWrapper.classList.toggle("fs-mode", inFS);
  if (state.pdfDoc) renderSlide(state.currentSlide);
});

let resizeTimer;
window.addEventListener("resize", () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    if (state.pdfDoc) renderSlide(state.currentSlide);
  }, 200);
});

// ─── Toast Helper ─────────────────────────────────────────────────────────────

let toastTimer;
function showToast(msg) {
  toast.textContent = msg;
  toast.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove("show"), 3200);
}

// ─── Boot ─────────────────────────────────────────────────────────────────────

// Try to restore existing session, otherwise create new
async function bootstrap() {
  const restored = await restoreSession();
  if (!restored) {
    // No existing session - show setup overlay for new session creation
    setupOverlay.style.display = "flex";
  }
}

bootstrap();

// ─── Start Session Button Handler ─────────────────────────────────────────────

// Allow Enter key to submit from name or password input
$("sessionNameInput")?.addEventListener("keydown", (e) => {
  if (e.key === "Enter") $("startSessionBtn")?.click();
});
$("sessionPasswordInput")?.addEventListener("keydown", (e) => {
  if (e.key === "Enter") $("startSessionBtn")?.click();
});

// Password visibility toggle
$("toggleSessionPassword")?.addEventListener("click", () => {
  const input = $("sessionPasswordInput");
  const btn = $("toggleSessionPassword");
  if (input.type === "password") {
    input.type = "text";
    btn.innerHTML = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17.94 17.94A10.07 10.07 0 0112 20c-7 0-11-8-11-8a18.45 18.45 0 015.06-5.94M9.9 4.24A9.12 9.12 0 0112 4c7 0 11 8 11 8a18.5 18.5 0 01-2.16 3.19m-6.72-1.07a3 3 0 11-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>';
    btn.title = "Hide password";
  } else {
    input.type = "password";
    btn.innerHTML = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>';
    btn.title = "Show password";
  }
});

$("startSessionBtn")?.addEventListener("click", async () => {
  const nameInput = $("sessionNameInput");
  const sessionName = nameInput?.value?.trim() || null;

  //  SECURITY: Get optional viewer password (min 4 chars if provided)
  const passwordInput = $("sessionPasswordInput");
  const password = passwordInput?.value?.trim() || null;
  if (password && password.length < 4) {
    showToast("⚠ Password must be at least 4 characters");
    return;
  }

  await initSession(sessionName, password);

  // Show upload zone after session created
  const uploadZone = $("uploadZone");
  const startBtn = $("startSessionBtn");
  const nameInputDiv = nameInput?.parentElement;
  const passwordInputDiv = passwordInput?.parentElement;

  if (uploadZone) uploadZone.style.display = "block";
  if (startBtn) startBtn.style.display = "none";
  if (nameInputDiv) nameInputDiv.style.display = "none";
  if (passwordInputDiv) passwordInputDiv.style.display = "none";

  // Update subtitle
  const subtitle = $("setupSubtitle");
  if (subtitle) subtitle.textContent = "Session created! Upload a PDF to start presenting.";
});

// ─── End Session Button Handler ───────────────────────────────────────────────

$("endSessionBtn")?.addEventListener("click", () => {
  if (confirm("Are you sure you want to end this session? All viewers and remotes will be disconnected.")) {
    endSession();
  }
});
