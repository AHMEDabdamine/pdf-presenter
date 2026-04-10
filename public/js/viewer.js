/**
 * PDF Presenter — Viewer Logic
 * MIT License
 *
 * Handles:
 *  - Session connection via QR or manual entry
 *  - PDF rendering via PDF.js
 *  - Real-time slide sync via WebSocket
 *  - Auto-reconnection handling
 *  - Mid-session PDF swap (presenter changes PDF without closing session)
 */

// ─── PDF.js Configuration ───────────────────────────────────────────────────
pdfjsLib.GlobalWorkerOptions.workerSrc = "/vendor/pdf.worker.min.js";
pdfjsLib.GlobalWorkerOptions.standardFontDataUrl = "/vendor/standard_fonts/";

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
  orientation: "landscape",
  isFullscreen: false,
  rendering: false,
  // Cache for rendered slides: Map<pageNum, ImageBitmap>
  slideCache: new Map(),
  maxCacheSize: 5, // Keep last 5 slides in memory
  // Preload state
  preloadTask: null,
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
const remoteCursor = $("remoteCursor");

// ─── Auto-connect from URL param ─────────────────────────────────────────────
const params = new URLSearchParams(window.location.search);
const urlSession = params.get("session");
const urlOrientation = params.get("orient");

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
  });

  socket.on("reconnect", (attemptNumber) => {
    console.log("[Viewer] Reconnected after", attemptNumber, "attempts");
    state.isConnected = true;
    state.reconnectAttempts = 0;
    hideReconnecting();
    showToast("✓ Reconnected!");

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

  socket.on("session-state", ({ currentSlide, totalSlides, pdfFile, name }) => {
    console.log("[Viewer] Session state:", { currentSlide, totalSlides, pdfFile, name });

    state.currentSlide = currentSlide || 1;
    state.totalSlides = totalSlides || 0;
    state.pdfUrl = pdfFile;

    // Update session name display
    updateSessionNameDisplay(name);

    showViewer();
    updateCounter();

    if (pdfFile) {
      console.log("[Viewer] Loading PDF from session state:", pdfFile);
      vsWaiting.style.display = "none";
      loadPdf(pdfFile);
    } else {
      console.log("[Viewer] No PDF in session state yet");
      vsWaiting.style.display = "flex";
      vsLoading.style.display = "none";
    }
  });

  socket.on("slide-update", ({ currentSlide }) => {
    console.log("[Viewer] Slide update:", currentSlide);
    state.currentSlide = currentSlide;
    updateCounter();

    if (!state.pdfDoc && state.pdfUrl) {
      console.log("[Viewer] Have PDF URL but doc not loaded, reloading...");
      loadPdf(state.pdfUrl);
    } else if (!state.pdfDoc && !state.pdfUrl) {
      console.log("[Viewer] No PDF at all, requesting session state refresh");
      socket.emit("request-session-state", { sessionId: state.sessionId });
    } else {
      // Quick render from cache if available, then trigger proper render
      renderCurrentSlideFast();
    }

    flashSlideChange();
  });

  socket.on("total-slides-update", ({ totalSlides }) => {
    state.totalSlides = totalSlides;
    updateCounter();
  });

  // ─── Mid-session PDF swap ─────────────────────────────────────────────────
  socket.on("pdf-loaded", ({ pdfUrl, filename }) => {
    console.log("[Viewer] New PDF loaded mid-session:", filename);

    // Clear previous PDF state
    state.pdfDoc = null;
    state.renderTask = null;
    state.currentSlide = 1;
    state.pdfUrl = pdfUrl;

    // Clear slide cache - old slides belong to previous PDF
    clearSlideCache();

    // Clear the canvas visually
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    // Show a brief swap notification
    showToast(`📄 New PDF: ${filename}`);
    showPdfSwapBanner(filename);

    // Hide waiting/error, show loading
    vsWaiting.style.display = "none";
    vsError.style.display = "none";

    updateCounter();
    loadPdf(pdfUrl);
  });

  // ─── Remote Cursor (Optimized) ────────────────────────────────────────────
  socket.on("cursor-move", ({ x, y, active }) => {
    // Direct update for maximum responsiveness
    updateRemoteCursor(x, y, active);
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

// ─── Session Name Display ─────────────────────────────────────────────────────

function updateSessionNameDisplay(name) {
  const nameEl = document.getElementById("vsSessionName");
  if (nameEl) {
    nameEl.textContent = name || "Untitled Session";
    nameEl.style.display = "inline";
  }
}

// ─── PDF Swap Banner ──────────────────────────────────────────────────────────

function escapeHtml(text) {
  const div = document.createElement("div");
  div.textContent = text;
  return div.innerHTML;
}

function showPdfSwapBanner(filename) {
  // Remove any existing banner
  const existing = document.getElementById("pdfSwapBanner");
  if (existing) existing.remove();

  const banner = document.createElement("div");
  banner.id = "pdfSwapBanner";
  banner.className = "pdf-swap-banner";
  banner.innerHTML = `<span>🔄</span> <span>Presenter switched to: <strong>${escapeHtml(filename)}</strong></span>`;
  document.body.appendChild(banner);

  // Animate in
  requestAnimationFrame(() => {
    banner.classList.add("show");
  });

  // Auto-remove after 4s
  setTimeout(() => {
    banner.classList.remove("show");
    setTimeout(() => banner.remove(), 400);
  }, 4000);
}

// ─── Remote Cursor Rendering (Optimized) ────────────────────────────────────

/**
 * Update remote cursor position using RAF and CSS transforms
 * Optimizations:
 * - requestAnimationFrame for 60fps sync with display refresh
 * - CSS transforms for GPU acceleration (no layout thrashing)
 * - Single source of truth from state.cursor
 */
function updateRemoteCursor(x, y, active) {
  if (!remoteCursor) return;

  // Hide cursor if inactive
  if (!active) {
    remoteCursor.classList.remove("active");
    return;
  }

  // Get canvas dimensions for coordinate mapping
  const rect = canvas.getBoundingClientRect();
  const containerRect = canvas.parentElement.getBoundingClientRect();
  // Account for canvas offset within its container (due to centering/padding)
  const offsetX = rect.left - containerRect.left;
  const offsetY = rect.top - containerRect.top;

  // Clamp coordinates to keep cursor within slide boundaries (0-1 range)
  const clampedX = Math.max(0, Math.min(1, x));
  const clampedY = Math.max(0, Math.min(1, y));
  const cursorX = offsetX + clampedX * rect.width;
  const cursorY = offsetY + clampedY * rect.height;

  // Position like presenter (centered on point)
  remoteCursor.style.left = cursorX + "px";
  remoteCursor.style.top = cursorY + "px";
  remoteCursor.classList.add("active");
}

// ─── PDF Loading & Rendering ──────────────────────────────────────────────────

async function loadPdf(url) {
  console.log("[Viewer] loadPdf called with URL:", url);
  vsLoading.style.display = "flex";
  vsWaiting.style.display = "none";
  vsError.style.display = "none";

  try {
    if (state.renderTask) {
      await state.renderTask.cancel();
      state.renderTask = null;
    }

    console.log("[Viewer] Fetching PDF document...");
    const pdf = await pdfjsLib.getDocument(url).promise;
    console.log("[Viewer] PDF loaded, pages:", pdf.numPages);
    state.pdfDoc = pdf;

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

function clearSlideCache() {
  // Close all ImageBitmaps to free GPU memory
  for (const [pageNum, cached] of state.slideCache) {
    if (cached.bitmap) cached.bitmap.close();
  }
  state.slideCache.clear();
  console.log("[Viewer] Slide cache cleared");
}

async function renderCurrentSlideFast() {
  const pageNum = Math.max(1, Math.min(state.currentSlide, state.totalSlides));
  
  // Check cache first - but skip preview-quality cached slides
  if (state.slideCache.has(pageNum)) {
    const cached = state.slideCache.get(pageNum);
    // Don't use preview-quality cached slides for display
    if (cached.isPreview) {
      console.log("[Viewer] Cache hit for page:", pageNum, "(preview only, doing full render)");
      renderCurrentSlide(false);
      return;
    }
    console.log("[Viewer] Cache hit for page:", pageNum, "(full quality)");
    ctx.drawImage(cached.bitmap, 0, 0, canvas.width, canvas.height);
    vsLoading.style.display = "none";
    // Already full quality, no need to re-render
    return;
  }
  
  // No cache - do full render
  renderCurrentSlide(false);
}

async function renderCurrentSlide(skipIfCached = false) {
  console.log("[Viewer] renderCurrentSlide called, pdfDoc:", !!state.pdfDoc, "rendering:", state.rendering);
  if (!state.pdfDoc || state.rendering) return;

  const pageNum = Math.max(1, Math.min(state.currentSlide, state.totalSlides));
  
  // Skip if already cached and flag set
  if (skipIfCached && state.slideCache.has(pageNum)) return;
  
  console.log("[Viewer] Rendering page:", pageNum, "of", state.pdfDoc.numPages);
  if (pageNum < 1 || pageNum > state.pdfDoc.numPages) return;

  state.rendering = true;
  vsLoading.style.display = "flex";

  try {
    if (state.renderTask) {
      await state.renderTask.cancel();
    }

    const page = await state.pdfDoc.getPage(pageNum);
    console.log("[Viewer] Got page:", pageNum);

    const container = canvas.parentElement;
    const containerWidth = container.clientWidth;
    const containerHeight = container.clientHeight;

    const baseViewport = page.getViewport({ scale: 1 });
    const pageAspect = baseViewport.width / baseViewport.height;
    const containerAspect = containerWidth / containerHeight;

    let scale;

    if (state.orientation === "portrait") {
      scale = (containerWidth / baseViewport.width) * 0.98;
    } else {
      if (pageAspect > containerAspect) {
        scale = (containerWidth / baseViewport.width) * 0.98;
      } else {
        scale = (containerHeight / baseViewport.height) * 0.98;
      }
    }

    if (state.isFullscreen) {
      scale *= 1.5;
    }

    const scaledViewport = page.getViewport({ scale });

    canvas.width = scaledViewport.width;
    canvas.height = scaledViewport.height;

    canvas.style.maxWidth = "100%";
    canvas.style.maxHeight = "100%";
    canvas.style.objectFit = "contain";

    const renderCtx = {
      canvasContext: ctx,
      viewport: scaledViewport,
      // Disable unnecessary layers for faster rendering
      annotationMode: pdfjsLib.AnnotationMode.DISABLE,
      renderInteractiveForms: false,
    };

    state.renderTask = page.render(renderCtx);
    await state.renderTask.promise;
    state.renderTask = null;

    // Cache the rendered slide as ImageBitmap
    await cacheRenderedSlide(pageNum);
    
    // Preload next slide in background
    preloadNextSlide(pageNum);

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

async function cacheRenderedSlide(pageNum) {
  try {
    // Create ImageBitmap from canvas for fast reuse
    const bitmap = await createImageBitmap(canvas);
    state.slideCache.set(pageNum, { bitmap, width: canvas.width, height: canvas.height });
    
    // Evict old cache entries if too many
    if (state.slideCache.size > state.maxCacheSize) {
      const firstKey = state.slideCache.keys().next().value;
      const old = state.slideCache.get(firstKey);
      if (old) old.bitmap.close(); // Free GPU memory
      state.slideCache.delete(firstKey);
    }
  } catch (err) {
    console.warn("[Viewer] Cache failed:", err);
  }
}

async function preloadNextSlide(currentPageNum) {
  const nextPage = currentPageNum + 1;
  if (nextPage > state.totalSlides || state.slideCache.has(nextPage)) return;
  
  // Cancel any existing preload
  if (state.preloadTask) {
    await state.preloadTask.cancel().catch(() => {});
    state.preloadTask = null;
  }
  
  // Preload in background with lower priority
  setTimeout(async () => {
    try {
      const page = await state.pdfDoc.getPage(nextPage);
      const baseViewport = page.getViewport({ scale: 1 });
      
      // Use lower scale for preloaded slides (faster)
      const container = canvas.parentElement;
      const scale = (container.clientWidth / baseViewport.width) * 0.5; // Half res for preload
      const viewport = page.getViewport({ scale });
      
      // Offscreen canvas for preload
      const offCanvas = document.createElement("canvas");
      offCanvas.width = viewport.width;
      offCanvas.height = viewport.height;
      const offCtx = offCanvas.getContext("2d", { alpha: false });
      
      state.preloadTask = page.render({
        canvasContext: offCtx,
        viewport: viewport,
        annotationMode: pdfjsLib.AnnotationMode.DISABLE,
      });
      
      await state.preloadTask.promise;
      state.preloadTask = null;
      
      // Store in cache
      const bitmap = await createImageBitmap(offCanvas);
      state.slideCache.set(nextPage, { 
        bitmap, 
        width: offCanvas.width, 
        height: offCanvas.height,
        isPreview: true // Flag to know this is lower quality
      });
      
      console.log("[Viewer] Preloaded page:", nextPage);
    } catch (err) {
      // Silent fail for preload - it's just optimization
      console.log("[Viewer] Preload failed:", err.message);
    }
  }, 100); // Small delay to not interfere with current slide rendering
}

// ─── UI Helpers ───────────────────────────────────────────────────────────────

function showViewer() {
  connectScreen.style.display = "none";
  viewerSlide.style.display = "block";
  vsSessionBadge.textContent = state.sessionId;

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

// ─── Resize Handling ────────────────────────────────────────────────────────────

let resizeTimeout = null;
window.addEventListener("resize", () => {
  if (!state.pdfDoc) return;
  clearTimeout(resizeTimeout);
  resizeTimeout = setTimeout(() => {
    renderCurrentSlide();
  }, 150);
});

// ─── Visibility API ──────────────────────────────────────────────────────────────

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && state.pdfDoc) {
    setTimeout(() => renderCurrentSlide(), 100);
  }
});

// ─── Fullscreen ─────────────────────────────────────────────────────────────────

const vsFullscreenBtn = $("vsFullscreenBtn");

function toggleFullscreen() {
  const viewerSlideEl = $("viewerSlide");

  if (!state.isFullscreen) {
    if (viewerSlideEl.requestFullscreen) {
      viewerSlideEl.requestFullscreen().catch(() => {});
    } else if (viewerSlideEl.webkitRequestFullscreen) {
      viewerSlideEl.webkitRequestFullscreen();
    }
    state.isFullscreen = true;
    viewerSlideEl.classList.add("fs-mode");
    vsFullscreenBtn.textContent = "⊠";
  } else {
    if (document.exitFullscreen) {
      document.exitFullscreen().catch(() => {});
    } else if (document.webkitExitFullscreen) {
      document.webkitExitFullscreen();
    }
    state.isFullscreen = false;
    viewerSlideEl.classList.remove("fs-mode");
    vsFullscreenBtn.textContent = "⛶";
  }

  setTimeout(() => {
    if (state.pdfDoc) renderCurrentSlide();
  }, 100);
}

vsFullscreenBtn.addEventListener("click", toggleFullscreen);

document.addEventListener("fullscreenchange", () => {
  const viewerSlideEl = $("viewerSlide");
  const isFS = !!document.fullscreenElement;

  state.isFullscreen = isFS;
  viewerSlideEl.classList.toggle("fs-mode", isFS);
  vsFullscreenBtn.textContent = isFS ? "⊠" : "⛶";

  setTimeout(() => {
    if (state.pdfDoc) renderCurrentSlide();
  }, 100);
});

console.log("[Viewer] Script loaded");
