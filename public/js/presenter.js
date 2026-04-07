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
 */

// ─── PDF.js Worker ────────────────────────────────────────────────────────────
pdfjsLib.GlobalWorkerOptions.workerSrc = "/pdf.worker.min.js";

// ─── State ────────────────────────────────────────────────────────────────────
const state = {
  sessionId: null,
  pdfDoc: null,
  currentSlide: 1,
  totalSlides: 0,
  rendering: false,
  remoteUrl: null,
  connectedRemotes: 0,
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

// ─── Session Init ─────────────────────────────────────────────────────────────

async function initSession() {
  try {
    const res = await fetch("/api/session", { method: "POST" });
    const data = await res.json();

    state.sessionId = data.sessionId;
    state.remoteUrl = data.remoteUrl;

    // Update UI badges
    sessionBadge.textContent = data.sessionId;
    modalSessId.textContent = data.sessionId;

    // Initial QR draw using saved IP address
    const savedIp = localStorage.getItem("presenter-ip");
    refreshQR(savedIp || null);

    // Connect to WebSocket
    connectSocket();

    // Load PDF library (previously uploaded PDFs)
    loadPdfLibrary();
  } catch (err) {
    console.error("Session init failed:", err);
    showToast("⚠ Could not create session — is the server running?");
  }
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
    loadPdfFromUrl(pdfUrl, filename);
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
      const cursorX = x * rect.width;
      const cursorY = y * rect.height;

      // Use requestAnimationFrame for smoother updates
      requestAnimationFrame(() => {
        artificialCursor.style.left = cursorX + "px";
        artificialCursor.style.top = cursorY + "px";
        artificialCursor.classList.add("active");
      });
    } else {
      artificialCursor.classList.remove("active");
    }
  });

  // Track connected remote count
  socket.on("connect_error", () => showToast("⚠ WebSocket connection lost"));

  // Count remotes via our own tracking
  socket.on("remote-count", ({ count }) => {
    state.connectedRemotes = count;
    connCount.textContent = `${count} remote(s) connected`;
  });
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

  const formData = new FormData();
  formData.append("pdf", file);

  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", `/api/upload/${state.sessionId}`);

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
        reject();
      }
    };

    xhr.onerror = () => {
      showToast("⚠ Network error during upload");
      reject();
    };
    xhr.send(formData);
  });
}

// ─── PDF Rendering ────────────────────────────────────────────────────────────

async function loadPdfFromUrl(url, filename = "") {
  try {
    const loadingTask = pdfjsLib.getDocument(url);
    const pdfDoc = await loadingTask.promise;

    state.pdfDoc = pdfDoc;
    state.totalSlides = pdfDoc.numPages;
    state.currentSlide = 1;

    // Tell the server about total slides for this session
    if (socket?.connected) {
      socket.emit("set-total-slides", {
        sessionId: state.sessionId,
        totalSlides: pdfDoc.numPages,
      });
    }

    // Hide setup overlay
    setupOverlay.classList.add("hide");
    progressDiv.style.display = "none";

    // Render first slide
    await renderSlide(1);

    // Build thumbnail strip (async, non-blocking)
    buildThumbnailStrip();

    showToast(`📄 ${filename || "PDF"} loaded — ${pdfDoc.numPages} slides`);
  } catch (err) {
    console.error("PDF load error:", err);
    showToast("⚠ Failed to load PDF: " + err.message);
    progressDiv.style.display = "none";
  }
}

async function renderSlide(pageNum) {
  if (!state.pdfDoc || state.rendering) return;
  if (pageNum < 1 || pageNum > state.totalSlides) return;

  state.rendering = true;

  try {
    const page = await state.pdfDoc.getPage(pageNum);
    const inFS = !!document.fullscreenElement;

    // In fullscreen: fill the entire viewport edge-to-edge
    // Normal mode: leave minimal room for nav arrows and thumbnail strip
    const maxW = inFS ? slideArea.clientWidth : slideArea.clientWidth - 60;
    const maxH = inFS ? slideArea.clientHeight : slideArea.clientHeight - 40;

    const viewport = page.getViewport({ scale: 1 });
    const scale = Math.min(maxW / viewport.width, maxH / viewport.height);
    const vp = page.getViewport({ scale });

    canvas.width = vp.width;
    canvas.height = vp.height;

    // Abort any ongoing render task
    if (state.renderTask) state.renderTask.cancel();
    state.renderTask = page.render({ canvasContext: ctx, viewport: vp });

    await state.renderTask.promise;
    state.renderTask = null;

    // Handle link annotations
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

// Create link highlight canvas
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
    // Get link annotations from the page
    const annotations = await page.getAnnotations();
    currentLinks = [];

    for (const annotation of annotations) {
      if (annotation.subtype === "Link") {
        // Convert PDF coordinates to canvas coordinates
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

    // Create and setup highlight canvas
    createLinkHighlightCanvas();
    updateLinkHighlight();
  } catch (err) {
    console.warn("Could not load link annotations:", err);
    currentLinks = [];
  }
}

function updateLinkHighlight(hoveredLink = null) {
  if (!linkHighlightCtx) return;

  // Clear canvas
  linkHighlightCtx.clearRect(
    0,
    0,
    linkHighlightCanvas.width,
    linkHighlightCanvas.height,
  );

  // Only show highlights if there's a hovered link
  if (hoveredLink === null || !currentLinks.length) return;

  // Set canvas size to match main canvas
  linkHighlightCanvas.width = canvas.width;
  linkHighlightCanvas.height = canvas.height;

  // Draw highlight only for the hovered link
  const link = currentLinks[hoveredLink];

  // Draw semi-transparent rectangle for hovered link
  linkHighlightCtx.fillStyle = "rgba(59, 130, 246, 0.3)";
  linkHighlightCtx.fillRect(link.x, link.y, link.width, link.height);

  // Draw border for better visibility
  linkHighlightCtx.strokeStyle = "rgba(59, 130, 246, 0.8)";
  linkHighlightCtx.lineWidth = 2;
  linkHighlightCtx.strokeRect(link.x, link.y, link.width, link.height);
}

// Canvas click handler for links
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

// Change cursor to pointer when hovering over links
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

// Hide highlight when mouse leaves canvas
canvas.addEventListener("mouseleave", () => {
  updateLinkHighlight();
});

// ─── Navigation ───────────────────────────────────────────────────────────────

async function goToSlide(num, source = "local") {
  if (!state.pdfDoc) return;
  num = Math.max(1, Math.min(num, state.totalSlides));
  if (num === state.currentSlide) return;

  // Trigger transition flash
  transOverlay.classList.add("flash");
  setTimeout(() => transOverlay.classList.remove("flash"), 180);

  await renderSlide(num);

  // Emit to server (only if change came from local input)
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

// UI Buttons
nextBtn.addEventListener("click", nextSlide);
prevBtn.addEventListener("click", prevSlide);

// Keyboard navigation
document.addEventListener("keydown", (e) => {
  if (remoteModal.style.display !== "none") return; // modal open
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
      break;
  }
});

// Touch / Swipe support
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

    // Render thumbnail async
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
  // Scroll active thumb into view
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
    const res = await fetch("/api/pdfs");
    const pdfs = await res.json();
    if (!pdfs.length) return;

    // Show quick list in setup card
    const libList = $("libraryList");
    $("pdfLibrary").style.display = "block";
    libList.innerHTML = pdfs
      .slice(0, 5)
      .map(
        (p) =>
          `<div class="library-item" data-url="${p.url}">
        <span>${decodeURIComponent(p.name.replace(/^\d+-/, ""))}</span>
        <span>Load →</span>
      </div>`,
      )
      .join("");

    libList.querySelectorAll(".library-item").forEach((el) => {
      el.addEventListener("click", () => loadPdfFromUrl(el.dataset.url));
    });
  } catch {
    /* ignore */
  }
}

// ─── Remote Modal & QR ───────────────────────────────────────────────────────

$("showRemoteBtn").addEventListener("click", () => {
  remoteModal.style.display = "flex";

  // Restore saved IP address
  const savedIp = localStorage.getItem("presenter-ip");
  if (savedIp) {
    $("ipInput").value = savedIp;
  }
});
$("closeRemoteModal").addEventListener("click", closeRemoteModal);
remoteModal.addEventListener("click", (e) => {
  if (e.target === remoteModal) closeRemoteModal();
});

function closeRemoteModal() {
  remoteModal.style.display = "none";
}

/**
 * Build the remote URL, optionally swapping the host with a user-supplied IP.
 * This lets the QR code point to the machine's LAN IP instead of localhost.
 */
function buildRemoteUrl(ipOverride) {
  const base = state.remoteUrl; // e.g. http://localhost:3000/remote.html?session=XXXX
  if (!ipOverride) return base;
  try {
    const u = new URL(base);
    // Keep the port, replace only the hostname
    u.hostname = ipOverride.trim();
    return u.toString();
  } catch {
    return base;
  }
}

function refreshQR(ipOverride) {
  const url = buildRemoteUrl(ipOverride);
  state.remoteUrl = url; // update so copy button uses the right URL
  remoteUrlEl.textContent = url;

  // Regenerate QR via QRious (client-side, always available)
  try {
    new QRious({
      element: qrCanvas,
      value: url,
      size: 200,
      background: "#ffffff",
      foreground: "#1a1a2e",
    });
  } catch (e) {
    console.error("QR generation failed:", e);
  }
}

// Apply IP button
$("applyIpBtn").addEventListener("click", () => {
  const ip = $("ipInput").value.trim();
  const ipNote = $("ipNote");

  if (ip && !/^[\d.a-zA-Z:-]+$/.test(ip)) {
    ipNote.textContent = "⚠ Invalid IP address";
    ipNote.style.color = "var(--danger)";
    return;
  }

  // Save IP to localStorage
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

// Allow pressing Enter in IP field
$("ipInput").addEventListener("keydown", (e) => {
  if (e.key === "Enter") $("applyIpBtn").click();
});

$("copyUrlBtn").addEventListener("click", () => {
  if (!state.remoteUrl) return;
  navigator.clipboard
    .writeText(state.remoteUrl)
    .then(() => showToast("✓ Link copied to clipboard"))
    .catch(() => showToast("⚠ Copy failed — select the URL manually"));
});

// ─── Theme Toggle ─────────────────────────────────────────────────────────────

const themeToggle = $("themeToggle");
let isDark = true;

themeToggle.addEventListener("click", () => {
  isDark = !isDark;
  document.documentElement.dataset.theme = isDark ? "dark" : "light";
  themeToggle.textContent = isDark ? "☀" : "☾";
  localStorage.setItem("presenter-theme", isDark ? "dark" : "light");
});

// Restore saved theme
const savedTheme = localStorage.getItem("presenter-theme");
if (savedTheme === "light") {
  isDark = false;
  document.documentElement.dataset.theme = "light";
  themeToggle.textContent = "☾";
}

// ─── Fullscreen ───────────────────────────────────────────────────────────────

const fullscreenBtn = $("fullscreenBtn");

function toggleFullscreen() {
  if (!document.fullscreenElement) {
    document.documentElement.requestFullscreen().catch(() => {});
    fullscreenBtn.textContent = "⛶";
  } else {
    document.exitFullscreen();
  }
}

fullscreenBtn.addEventListener("click", toggleFullscreen);

document.addEventListener("fullscreenchange", () => {
  const inFS = !!document.fullscreenElement;
  fullscreenBtn.textContent = inFS ? "⊠" : "⛶";
  // Hide topbar in fullscreen
  topbar.classList.toggle("hidden", inFS);
  // Hide thumbnail strip in fullscreen (auto-hide via class)
  slideStrip.classList.toggle("fs-hidden", inFS);
  // Remove wrapper border/shadow in fullscreen for edge-to-edge look
  slideWrapper.classList.toggle("fs-mode", inFS);
  // Re-render at new dimensions
  if (state.pdfDoc) renderSlide(state.currentSlide);
});

// Re-render on window resize
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

initSession();
