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
const passwordRow = $("passwordRow");
const passwordInput = $("passwordInput");
const passwordBtn = $("passwordBtn");

let viewerToken = null; //  SECURITY: Token for password-protected sessions

// ─── Token Storage Helpers ───────────────────────────────────────────────────
function saveViewerToken(sessionId, token) {
  sessionStorage.setItem(`viewer-token-${sessionId}`, token);
  sessionStorage.setItem(`viewer-token-time-${sessionId}`, Date.now().toString());
}

function getViewerToken(sessionId) {
  const token = sessionStorage.getItem(`viewer-token-${sessionId}`);
  const timestamp = sessionStorage.getItem(`viewer-token-time-${sessionId}`);
  if (!token || !timestamp) return null;
  // Check if token is expired (> 5 minutes old)
  const age = Date.now() - parseInt(timestamp, 10);
  if (age > 5 * 60 * 1000) {
    clearViewerToken(sessionId);
    return null;
  }
  return token;
}

function clearViewerToken(sessionId) {
  sessionStorage.removeItem(`viewer-token-${sessionId}`);
  sessionStorage.removeItem(`viewer-token-time-${sessionId}`);
}

// ─── Auto-connect from URL param ─────────────────────────────────────────────
const params = new URLSearchParams(window.location.search);
const urlSession = params.get("session");
const urlOrientation = params.get("orient");

if (urlOrientation === "portrait" || urlOrientation === "landscape") {
  state.orientation = urlOrientation;
  document.body.classList.add(`orient-${urlOrientation}`);
}

//  SECURITY: Validate session ID format before using
if (urlSession && /^[A-Z0-9]{8,16}$/i.test(urlSession)) {
  sessionInput.value = urlSession.toUpperCase();
  setTimeout(connectToSession, 300);
}

// ─── Connect ───────────────────────────────────────────────────────────────────
connectBtn.addEventListener("click", connectToSession);
sessionInput.addEventListener("keydown", (e) => {
  sessionInput.value = sessionInput.value.toUpperCase();
  if (e.key === "Enter") connectToSession();
});

passwordBtn.addEventListener("click", verifyPassword);
passwordInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") verifyPassword();
});

// Password visibility toggle
const togglePasswordBtn = $("togglePassword");
if (togglePasswordBtn) {
  togglePasswordBtn.addEventListener("click", () => {
    if (passwordInput.type === "password") {
      passwordInput.type = "text";
      togglePasswordBtn.innerHTML = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>';
      togglePasswordBtn.title = "Hide password";
    } else {
      passwordInput.type = "password";
      togglePasswordBtn.innerHTML = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>';
      togglePasswordBtn.title = "Show password";
    }
  });
}

let socket = null;
let reconnectInterval = null;

async function connectToSession() {
  const id = sessionInput.value.trim().toUpperCase();
  if (!id || id.length < 4) {
    vcHint.innerHTML = '<span class="icon"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="vertical-align: middle; margin-right: 4px;"><path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg></span> Enter a valid session ID';
    vcHint.style.color = "var(--danger)";
    return;
  }

  vcHint.textContent = "Checking session...";
  vcHint.style.color = "var(--text-3)";
  state.sessionId = id;

  //  SECURITY: Check if session requires password
  // First, try to restore saved token for this session
  viewerToken = getViewerToken(id);

  try {
    const res = await fetch(`/api/session/${id}/requires-password`);
    if (!res.ok) {
      vcHint.innerHTML = '<span class="icon"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="vertical-align: middle; margin-right: 4px;"><path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg></span> Session not found';
      vcHint.style.color = "var(--danger)";
      return;
    }
    const data = await res.json();

    if (!data.requiresPassword) {
      // No password required, proceed with connection
      initSocket();
    } else if (viewerToken) {
      // Have a saved token, try to use it directly
      vcHint.textContent = "Reconnecting...";
      vcHint.style.color = "var(--text-3)";
      passwordRow.style.display = "none";
      initSocket();
    } else {
      // Show password input
      passwordRow.style.display = "flex";
      passwordInput.focus();
      vcHint.innerHTML = '<span class="icon"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="vertical-align: middle; margin-right: 4px;"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0110 0v4"/></svg></span> This session requires a password';
      vcHint.style.color = "var(--warning)";
      return; // Wait for password verification
    }
  } catch (err) {
    console.error("[Viewer] Failed to check password requirement:", err);
    vcHint.innerHTML = '<span class="icon"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="vertical-align: middle; margin-right: 4px;"><path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg></span> Connection failed';
    vcHint.style.color = "var(--danger)";
  }
}

async function verifyPassword() {
  const password = passwordInput.value.trim();
  if (!password) {
    vcHint.innerHTML = '<span class="icon"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="vertical-align: middle; margin-right: 4px;"><path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg></span> Enter a password';
    vcHint.style.color = "var(--danger)";
    return;
  }

  vcHint.textContent = "Verifying...";
  vcHint.style.color = "var(--text-3)";
  passwordBtn.disabled = true;

  try {
    const res = await fetch(`/api/session/${state.sessionId}/verify-password`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Requested-With": "XMLHttpRequest",
      },
      body: JSON.stringify({ password }),
    });

    const data = await res.json();

    if (data.valid) {
      //  SECURITY: Store viewer token for WebSocket auth
      viewerToken = data.viewerToken;
      // Persist token for refresh recovery
      saveViewerToken(state.sessionId, viewerToken);
      vcHint.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="vertical-align: middle; margin-right: 4px;"><polyline points="20 6 9 17 4 12"/></svg> ' + escapeHtml("Access granted!");
      vcHint.style.color = "var(--success)";
      passwordRow.style.display = "none";
      initSocket();
    } else {
      vcHint.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="vertical-align: middle; margin-right: 4px;"><path d="M18 6L6 18M6 6l12 12"/></svg> ' + escapeHtml(data.error || "Invalid password");
      vcHint.style.color = "var(--danger)";
      passwordInput.value = "";
      passwordInput.focus();
    }
  } catch (err) {
    console.error("[Viewer] Password verification failed:", err);
    vcHint.innerHTML = '<span class="icon"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="vertical-align: middle; margin-right: 4px;"><path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg></span> Verification failed';
    vcHint.style.color = "var(--danger)";
  } finally {
    passwordBtn.disabled = false;
  }
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
      viewerToken, //  SECURITY: Include token for password-protected sessions
    });

    vsStatusDot.innerHTML = '<span class="status-dot" style="display: inline-block; width: 8px; height: 8px; border-radius: 50%; background: currentColor; margin-right: 6px;"></span>Live';
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
    showToast("Reconnected!", "success");

    socket.emit("join-session", {
      sessionId: state.sessionId,
      role: "viewer",
      viewerToken, //  SECURITY: Include token for password-protected sessions
    });
  });

  socket.on("reconnect_failed", () => {
    console.error("[Viewer] Reconnection failed");
    showToast("Connection lost. Tap to retry.", "warning");
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
    showToast(message, "warning");
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
  banner.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="vertical-align: middle; margin-right: 6px;"><path d="M23 4v6h-6M1 20v-6h6M3.51 9a9 9 0 0114.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0020.49 15"/></svg> <span>Presenter switched to: <strong>${escapeHtml(filename)}</strong></span>`;
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
    showToast("Failed to load PDF: " + err.message, "warning");
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
      showToast("Render error: " + err.message, "warning");
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

function showToast(msg, type) {
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
    vsFullscreenBtn.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M8 3v3a2 2 0 01-2 2H3m18 0h-3a2 2 0 01-2-2V3m0 18v-3a2 2 0 012-2h3M3 16h3a2 2 0 012 2v3"/></svg>';
  } else {
    if (document.exitFullscreen) {
      document.exitFullscreen().catch(() => {});
    } else if (document.webkitExitFullscreen) {
      document.webkitExitFullscreen();
    }
    state.isFullscreen = false;
    viewerSlideEl.classList.remove("fs-mode");
    vsFullscreenBtn.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M8 3H5a2 2 0 00-2 2v3m18 0V5a2 2 0 00-2-2h-3m0 18h3a2 2 0 002-2v-3M3 16v3a2 2 0 002 2h3"/></svg>';
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
  vsFullscreenBtn.innerHTML = isFS ? '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M8 3v3a2 2 0 01-2 2H3m18 0h-3a2 2 0 01-2-2V3m0 18v-3a2 2 0 012-2h3M3 16h3a2 2 0 012 2v3"/></svg>' : '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M8 3H5a2 2 0 00-2 2v3m18 0V5a2 2 0 00-2-2h-3m0 18h3a2 2 0 002-2v-3M3 16v3a2 2 0 002 2h3"/></svg>';

  setTimeout(() => {
    if (state.pdfDoc) renderCurrentSlide();
  }, 100);
});

// ─── Dhikr Toast Notifications ────────────────────────────────────────────────

const dhikrList = [
  "الْحَمْدُ لِلَّهِ",
  "لَا إِلٰهَ إِلَّا اللَّهُ",
  "اللَّهُ أَكْبَرُ",
  "سُبْحَانَ اللَّه",
  "اللَّهُمَّ صَلِّ عَلَىٰ مُحَمَّدٍ ﷺ",
  "اللَّهُمَّ إِنِّي أَسْأَلُكَ الْجَنَّةَ",
  "اللَّهُ أَكْبَرُ كَبِيرًا",
  "الْحَمْدُ لِلَّهِ كَثِيرًا",
  "سُبْحَانَ اللَّهِ بُكْرَةً وَأَصِيلًا",
  "اللَّهُمَّ يَسِّرْ لِي أَمْرِي",
  "اللَّهُمَّ اغْفِرْ لِي",
  "اللَّهُمَّ اشْرَحْ لِي صَدْرِي"
];

let dhikrToastElement = null;
let dhikrInterval = null;

function showDhikrToast() {
  const randomDhikr = dhikrList[Math.floor(Math.random() * dhikrList.length)];
  
  if (!dhikrToastElement) {
    dhikrToastElement = document.createElement("div");
    dhikrToastElement.className = "dhikr-toast";
    dhikrToastElement.addEventListener("click", hideDhikrToast);
    document.body.appendChild(dhikrToastElement);
  }
  
  dhikrToastElement.textContent = randomDhikr;
  dhikrToastElement.classList.add("visible");
  
  // Auto hide after 8 seconds
  setTimeout(() => {
    hideDhikrToast();
  }, 8000);
}

function hideDhikrToast() {
  if (dhikrToastElement) {
    dhikrToastElement.classList.remove("visible");
  }
}

function startDhikrNotifications() {
  // Show one immediately on load
  setTimeout(() => {
    showDhikrToast();
  }, 2000);
  
  // Then show at random intervals between 2-5 minutes
  const scheduleNextDhikr = () => {
    const randomDelay = Math.floor(Math.random() * 180000) + 120000; // 2-5 minutes
    dhikrInterval = setTimeout(() => {
      showDhikrToast();
      scheduleNextDhikr();
    }, randomDelay);
  };
  
  scheduleNextDhikr();
}

function stopDhikrNotifications() {
  if (dhikrInterval) {
    clearTimeout(dhikrInterval);
    dhikrInterval = null;
  }
  hideDhikrToast();
}

// Start dhikr notifications (not tied to session)
startDhikrNotifications();

console.log("[Viewer] Script loaded");
