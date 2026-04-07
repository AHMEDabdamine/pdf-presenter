/**
 * PDF Presenter — Viewer Logic
 * MIT License
 *
 * Handles:
 *  - Session connection via QR or manual entry
 *  - PDF rendering via PDF.js
 *  - Real-time slide sync via WebSocket
 *  - Auto-reconnection handling
 */

// ─── PDF.js Worker ────────────────────────────────────────────────────────────
pdfjsLib.GlobalWorkerOptions.workerSrc = "/vendor/pdf.worker.min.js";

// ─── State ────────────────────────────────────────────────────────────────────
const state = {
  sessionId: null,
  pdfDoc: null,
  currentSlide: 1,
  totalSlides: 0,
  pdfUrl: null,
  renderTask: null,
  isConnected: false,
  reconnectAttempts: 0,
  maxReconnectAttempts: 10,
  orientation: "landscape", // 'landscape' or 'portrait'
  isFullscreen: false,
};

// ─── DOM References ───────────────────────────────────────────────────────────
const $ = (id) => document.getElementById(id);
const connectScreen = $("viewerConnect");
const viewerSlide = $("viewerSlide");
const sessionInput = $("sessionInput");
const connectBtn = $("connectBtn");
const vcHint = $("vcHint");
const vsSessionBadge = $("vsSessionBadge");
const vsStatusDot = $("vsStatusDot");
const canvas = $("viewerCanvas");
const ctx = canvas.getContext("2d");
const vsLoading = $("vsLoading");
const vsWaiting = $("vsWaiting");
const vsError = $("vsError");
const vsErrorText = $("vsErrorText");
const vsCounter = $("vsCounter");
const vsReconnecting = $("vsReconnecting");
const vsHeader = $("vsHeader");
const toast = $("toast");

// ─── Auto-connect from URL param ─────────────────────────────────────────────
const params = new URLSearchParams(window.location.search);
const urlSession = params.get("session");
const urlOrientation = params.get("orient");

// Set orientation from URL param if provided
if (urlOrientation === "portrait" || urlOrientation === "landscape") {
  state.orientation = urlOrientation;
  document.body.classList.add(`orient-${urlOrientation}`);
}

if (urlSession) {
  sessionInput.value = urlSession.toUpperCase();
  setTimeout(connectToSession, 300);
}

// ─── Connect ───────────────────────────────────────────────────────────────────
connectBtn.addEventListener("click", connectToSession);
sessionInput.addEventListener("keydown", (e) => {
  sessionInput.value = sessionInput.value.toUpperCase();
  if (e.key === "Enter") connectToSession();
});

let socket = null;
let reconnectInterval = null;

function connectToSession() {
  const id = sessionInput.value.trim().toUpperCase();
  if (!id || id.length < 4) {
    vcHint.textContent = "⚠ Enter a valid session ID";
    vcHint.style.color = "var(--danger)";
    return;
  }

  vcHint.textContent = "Connecting...";
  vcHint.style.color = "var(--text-3)";
  state.sessionId = id;

  initSocket();
}

function initSocket() {
  // Clear any existing reconnect interval
  if (reconnectInterval) {
    clearInterval(reconnectInterval);
    reconnectInterval = null;
  }

  socket = io({
    transports: ["websocket", "polling"],
    reconnection: true,
    reconnectionAttempts: state.maxReconnectAttempts,
    reconnectionDelay: 1000,
    reconnectionDelayMax: 5000,
  });

  socket.on("connect", () => {
    console.log("[Viewer] Connected:", socket.id);
    state.isConnected = true;
    state.reconnectAttempts = 0;
    hideReconnecting();

    socket.emit("join-session", {
      sessionId: state.sessionId,
      role: "viewer",
    });

    // Update status indicator
    vsStatusDot.textContent = "● Live";
    vsStatusDot.classList.remove("disconnected");
    vsStatusDot.classList.add("connected");
  });

  socket.on("connect_error", (err) => {
    console.error("[Viewer] Connection error:", err.message);
    state.isConnected = false;
    vsStatusDot.textContent = "○ Offline";
    vsStatusDot.classList.remove("connected");
    vsStatusDot.classList.add("disconnected");
    showReconnecting();
  });

  socket.on("disconnect", (reason) => {
    console.log("[Viewer] Disconnected:", reason);
    state.isConnected = false;
    vsStatusDot.textContent = "○ Offline";
    vsStatusDot.classList.remove("connected");
    vsStatusDot.classList.add("disconnected");
    showReconnecting();

    // Socket.io handles reconnection automatically
    // We just show the UI feedback
  });

  socket.on("reconnect", (attemptNumber) => {
    console.log("[Viewer] Reconnected after", attemptNumber, "attempts");
    state.isConnected = true;
    state.reconnectAttempts = 0;
    hideReconnecting();
    showToast("✓ Reconnected!");

    // Re-join the session after reconnect
    socket.emit("join-session", {
      sessionId: state.sessionId,
      role: "viewer",
    });
  });

  socket.on("reconnect_failed", () => {
    console.error("[Viewer] Reconnection failed");
    showToast("⚠ Connection lost. Tap to retry.");
    hideReconnecting();
  });

  // ─── Session Events ───────────────────────────────────────────────────────

  socket.on("session-state", ({ currentSlide, totalSlides, pdfFile }) => {
    console.log("[Viewer] Session state:", { currentSlide, totalSlides, pdfFile });

    state.currentSlide = currentSlide || 1;
    state.totalSlides = totalSlides || 0;
    state.pdfUrl = pdfFile;

    showViewer();
    updateCounter();

    // Load PDF if provided
    if (pdfFile) {
      console.log("[Viewer] Loading PDF from session state:", pdfFile);
      vsWaiting.style.display = "none";
      loadPdf(pdfFile);
    } else {
      console.log("[Viewer] No PDF in session state yet");
      vsWaiting.style.display = "flex";
      vsLoading.style.display = "none";
      // Check if we're getting slide updates but no PDF - likely wrong session
      if (currentSlide > 1) {
        vsError.style.display = "flex";
        vsErrorText.textContent = "Session mismatch: Presenter has slides but no PDF. Scan the current QR code from the presenter.";
      }
    }
  });

  socket.on("slide-update", ({ currentSlide }) => {
    console.log("[Viewer] Slide update:", currentSlide);
    state.currentSlide = currentSlide;
    updateCounter();
    
    // If we don't have PDF loaded but are getting slide updates,
    // try to re-fetch session state to get the PDF URL
    if (!state.pdfDoc && state.pdfUrl) {
      console.log("[Viewer] Have PDF URL but doc not loaded, reloading...");
      loadPdf(state.pdfUrl);
    } else if (!state.pdfDoc && !state.pdfUrl) {
      console.log("[Viewer] No PDF at all, requesting session state refresh");
      socket.emit("request-session-state", { sessionId: state.sessionId });
    } else {
      renderCurrentSlide();
    }

    // Visual feedback for slide change
    flashSlideChange();
  });

  socket.on("total-slides-update", ({ totalSlides }) => {
    state.totalSlides = totalSlides;
    updateCounter();
  });

  socket.on("pdf-loaded", ({ pdfUrl, filename }) => {
    console.log("[Viewer] PDF loaded:", filename);
    state.pdfUrl = pdfUrl;
    state.currentSlide = 1;
    loadPdf(pdfUrl);
    showToast(`📄 ${filename} loaded`);
  });
}

// ─── PDF Loading & Rendering ──────────────────────────────────────────────────

async function loadPdf(url) {
  console.log("[Viewer] loadPdf called with URL:", url);
  vsLoading.style.display = "flex";
  vsWaiting.style.display = "none";
  vsError.style.display = "none";

  try {
    // Cancel any previous render
    if (state.renderTask) {
      await state.renderTask.cancel();
      state.renderTask = null;
    }

    console.log("[Viewer] Fetching PDF document...");
    const pdf = await pdfjsLib.getDocument(url).promise;
    console.log("[Viewer] PDF loaded, pages:", pdf.numPages);
    state.pdfDoc = pdf;

    // If totalSlides wasn't set yet, update it
    if (state.totalSlides !== pdf.numPages) {
      state.totalSlides = pdf.numPages;
      updateCounter();
    }

    vsLoading.style.display = "none";
    renderCurrentSlide();
  } catch (err) {
    console.error("[Viewer] PDF load failed:", err);
    vsLoading.style.display = "none";
    vsError.style.display = "flex";
    vsErrorText.textContent = "Failed to load PDF: " + (err.message || "Unknown error");
    showToast("⚠ Failed to load PDF: " + err.message);
  }
}

async function renderCurrentSlide() {
  console.log("[Viewer] renderCurrentSlide called, pdfDoc:", !!state.pdfDoc, "rendering:", state.rendering);
  if (!state.pdfDoc || state.rendering) return;

  const pageNum = Math.max(1, Math.min(state.currentSlide, state.totalSlides));
  console.log("[Viewer] Rendering page:", pageNum, "of", state.pdfDoc.numPages);
  if (pageNum < 1 || pageNum > state.pdfDoc.numPages) return;

  state.rendering = true;
  vsLoading.style.display = "flex";

  try {
    // Cancel previous render if exists
    if (state.renderTask) {
      await state.renderTask.cancel();
    }

    const page = await state.pdfDoc.getPage(pageNum);
    console.log("[Viewer] Got page:", pageNum);

    // Get the container dimensions
    const container = canvas.parentElement;
    const containerWidth = container.clientWidth;
    const containerHeight = container.clientHeight;
    console.log("[Viewer] Container size:", containerWidth, "x", containerHeight);

    // Get page viewport at scale 1 to get original dimensions
    const baseViewport = page.getViewport({ scale: 1 });
    const pageAspect = baseViewport.width / baseViewport.height;
    const containerAspect = containerWidth / containerHeight;
    
    // Determine scale based on orientation preference
    let scale;
    
    if (state.orientation === "portrait") {
      // Portrait mode: prioritize width, let height overflow if needed
      scale = (containerWidth / baseViewport.width) * 0.98;
    } else {
      // Landscape mode (default): fit entire page in container
      if (pageAspect > containerAspect) {
        // Page is wider than container - fit to width
        scale = (containerWidth / baseViewport.width) * 0.98;
      } else {
        // Page is taller than container - fit to height
        scale = (containerHeight / baseViewport.height) * 0.98;
      }
    }
    
    // Increase scale for fullscreen mode
    if (state.isFullscreen) {
      scale *= 1.5; // Make it bigger in fullscreen
    }

    const scaledViewport = page.getViewport({ scale });
    console.log("[Viewer] Render scale:", scale, "viewport:", scaledViewport.width, "x", scaledViewport.height);

    // Set canvas dimensions
    canvas.width = scaledViewport.width;
    canvas.height = scaledViewport.height;

    // Center the canvas with CSS
    canvas.style.maxWidth = "100%";
    canvas.style.maxHeight = "100%";
    canvas.style.objectFit = "contain";

    // Render
    const renderCtx = {
      canvasContext: ctx,
      viewport: scaledViewport,
    };

    state.renderTask = page.render(renderCtx);
    await state.renderTask.promise;
    state.renderTask = null;

    console.log("[Viewer] Page rendered successfully");
    vsLoading.style.display = "none";
  } catch (err) {
    if (err.name === "RenderingCancelledException") {
      console.log("[Viewer] Render cancelled");
    } else {
      console.error("[Viewer] Render error:", err);
      showToast("⚠ Render error: " + err.message);
    }
    vsLoading.style.display = "none";
  } finally {
    state.rendering = false;
  }
}

// ─── UI Helpers ───────────────────────────────────────────────────────────────

function showViewer() {
  connectScreen.style.display = "none";
  viewerSlide.style.display = "block";
  vsSessionBadge.textContent = state.sessionId;
  
  // Initial render after layout settles
  if (state.pdfDoc) {
    setTimeout(() => {
      console.log("[Viewer] Initial render after showViewer");
      renderCurrentSlide();
    }, 100);
  }
}

function updateCounter() {
  vsCounter.textContent = `${state.currentSlide} / ${state.totalSlides || "—"}`;
}

function showReconnecting() {
  vsReconnecting.style.display = "flex";
}

function hideReconnecting() {
  vsReconnecting.style.display = "none";
}

function flashSlideChange() {
  // Subtle flash effect to indicate slide change
  const flash = document.createElement("div");
  flash.className = "vs-flash";
  flash.style.cssText = `
    position: fixed;
    top: 0;
    left: 0;
    right: 0;
    bottom: 0;
    background: rgba(240, 165, 0, 0.1);
    pointer-events: none;
    z-index: 100;
    opacity: 0;
    transition: opacity 0.15s ease;
  `;
  document.body.appendChild(flash);

  requestAnimationFrame(() => {
    flash.style.opacity = "1";
    setTimeout(() => {
      flash.style.opacity = "0";
      setTimeout(() => flash.remove(), 150);
    }, 100);
  });
}

function showToast(msg) {
  toast.textContent = msg;
  toast.style.opacity = "1";
  toast.style.transform = "translateY(0)";
  setTimeout(() => {
    toast.style.opacity = "0";
    toast.style.transform = "translateY(10px)";
  }, 2500);
}

// ─── Touch / Swipe for Manual Navigation (Optional) ───────────────────────────

let touchStartX = 0;
let touchEndX = 0;

document.addEventListener("touchstart", (e) => {
  touchStartX = e.changedTouches[0].screenX;
});

document.addEventListener("touchend", (e) => {
  touchEndX = e.changedTouches[0].screenX;
  handleSwipe();
});

function handleSwipe() {
  // Optional: Swipe could show previous/next slide locally
  // But for a pure viewer, we sync from presenter only
  // Left for future enhancement if needed
}

// ─── Resize Handling ────────────────────────────────────────────────────────────

let resizeTimeout = null;
window.addEventListener("resize", () => {
  if (!state.pdfDoc) return;
  clearTimeout(resizeTimeout);
  resizeTimeout = setTimeout(() => {
    renderCurrentSlide();
  }, 150);
});

// ─── Visibility API (Pause/Resume) ──────────────────────────────────────────────

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && state.pdfDoc) {
    // Re-render when tab becomes visible (handles context loss)
    setTimeout(() => renderCurrentSlide(), 100);
  }
});

// ─── Fullscreen ─────────────────────────────────────────────────────────────────

const vsFullscreenBtn = $("vsFullscreenBtn");

function toggleFullscreen() {
  const viewerSlideEl = $("viewerSlide");
  
  if (!state.isFullscreen) {
    // Enter fullscreen
    if (viewerSlideEl.requestFullscreen) {
      viewerSlideEl.requestFullscreen().catch(() => {});
    } else if (viewerSlideEl.webkitRequestFullscreen) {
      viewerSlideEl.webkitRequestFullscreen();
    }
    state.isFullscreen = true;
    viewerSlideEl.classList.add("fs-mode");
    vsFullscreenBtn.textContent = "⊠";
  } else {
    // Exit fullscreen
    if (document.exitFullscreen) {
      document.exitFullscreen().catch(() => {});
    } else if (document.webkitExitFullscreen) {
      document.webkitExitFullscreen();
    }
    state.isFullscreen = false;
    viewerSlideEl.classList.remove("fs-mode");
    vsFullscreenBtn.textContent = "⛶";
  }
  
  // Re-render after fullscreen transition
  setTimeout(() => {
    if (state.pdfDoc) renderCurrentSlide();
  }, 100);
}

vsFullscreenBtn.addEventListener("click", toggleFullscreen);

// Handle fullscreen change events (from browser/OS)
document.addEventListener("fullscreenchange", () => {
  const viewerSlideEl = $("viewerSlide");
  const isFS = !!document.fullscreenElement;
  
  state.isFullscreen = isFS;
  viewerSlideEl.classList.toggle("fs-mode", isFS);
  vsFullscreenBtn.textContent = isFS ? "⊠" : "⛶";
  
  // Re-render at new dimensions
  setTimeout(() => {
    if (state.pdfDoc) renderCurrentSlide();
  }, 100);
});

console.log("[Viewer] Script loaded");
