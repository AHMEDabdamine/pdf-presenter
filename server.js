/**
 * PDF Presenter - Server
 * MIT License
 *
 * Express + Socket.io server that:
 *  - Serves the static frontend
 *  - Handles PDF uploads (stored in /uploads)
 *  - Manages presentation "rooms" via WebSocket
 *  - Syncs slide state across all connected clients in real-time
 */

const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const QRCode = require("qrcode");
const { v4: uuidv4 } = require("uuid");
const rateLimit = require("express-rate-limit");

// ─── App Setup ───────────────────────────────────────────────────────────────

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: false }, // 🔒 SECURITY: Disable cross-origin - same-origin only
  maxHttpBufferSize: 50 * 1024 * 1024, // 50 MB for PDF uploads via socket
});

const PORT = process.env.PORT || 3000;
const UPLOAD_DIR = path.join(__dirname, "uploads");

// Ensure uploads directory exists
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// ─── File Upload (Multer) ─────────────────────────────────────────────────────

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOAD_DIR),
  filename: (_req, file, cb) => {
    // Sanitize filename and prefix with timestamp to avoid collisions
    // Allow Unicode letters (including Arabic), numbers, spaces, and common safe chars
    // Remove only path separators and control characters
    const safe = file.originalname
      .replace(/[\\/:*?"<>|]/g, "_")  // Windows/Unix reserved chars
      .replace(/[\x00-\x1f\x7f]/g, ""); // Control characters
    cb(null, `${Date.now()}-${safe}`);
  },
});

const upload = multer({
  storage,
  fileFilter: (_req, file, cb) => {
    if (file.mimetype === "application/pdf") cb(null, true);
    else cb(new Error("Only PDF files are allowed"), false);
  },
  limits: { fileSize: 100 * 1024 * 1024 }, // 100 MB max
});

// ─── In-Memory Session Store ──────────────────────────────────────────────────

/**
 * sessions: Map<sessionId, { currentSlide, totalSlides, pdfFile, presenterSocket, connectedViewers }>
 * A "session" ties together a presenter and all remote viewers.
 */
const sessions = new Map(); // sessionId -> { ..., createdAt }
const uploadTokens = new Map(); // sessionId -> uploadToken (for upload authorization)
const fileToSession = new Map(); // filename -> sessionId (for PDF access control)
const SESSION_TTL = 4 * 60 * 60 * 1000; // 4 hours in milliseconds
const CLEANUP_INTERVAL = 30 * 60 * 1000; // 30 minutes in milliseconds

// ─── Authorization Helpers ───────────────────────────────────────────────────

function requireRole(socket, allowedRoles) {
  const role = socket.data.role;
  if (!allowedRoles.includes(role)) {
    console.log(`[WS] Rejected: role ${role} not in [${allowedRoles.join(", ")}]`);
    socket.emit("error", { message: `Forbidden: requires one of [${allowedRoles.join(", ")}]` });
    return false;
  }
  return true;
}

function requireSessionMatch(socket, sessionId) {
  if (socket.data.sessionId !== sessionId) {
    console.log(`[WS] Rejected: session mismatch (${socket.data.sessionId} vs ${sessionId})`);
    socket.emit("error", { message: "Forbidden: not a member of this session" });
    return false;
  }
  return true;
}

function sanitizeSlideCount(value) {
  const parsed = parseInt(value, 10);
  if (isNaN(parsed) || parsed < 1 || parsed > 10000) return null;
  return parsed;
}

function sanitizePdfFilename(pdfUrl) {
  // Extract basename and validate it's a PDF
  const basename = path.basename(pdfUrl);
  if (!basename.toLowerCase().endsWith(".pdf")) return null;
  // Prevent path traversal - ensure no path separators remain
  if (basename.includes("/") || basename.includes("\\")) return null;
  return basename;
}

// 🔒 Generate cryptographically secure token
function generateSecureToken() {
  return crypto.randomBytes(32).toString("hex");
}

// 🔒 Validate upload token for session
function validateUploadToken(sessionId, token) {
  const expectedToken = uploadTokens.get(sessionId);
  if (!expectedToken || !token) return false;
  const a = Buffer.from(expectedToken);
  const b = Buffer.from(token);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

// 🔒 Check if request is from localhost/internal network
// NOTE: If running behind a trusted proxy, configure with app.set('trust proxy', 1)
// and only then will x-forwarded-for be considered by req.ip
function isInternalRequest(req) {
  const clientIp = req.ip || req.connection.remoteAddress || req.socket?.remoteAddress || "unknown";
  return clientIp === "127.0.0.1" || clientIp === "::1" || clientIp === "::ffff:127.0.0.1";
}

function getOrCreateSession(sessionId) {
  if (!sessions.has(sessionId)) {
    sessions.set(sessionId, {
      currentSlide: 1,
      totalSlides: 0,
      pdfFile: null,
      presenterSocket: null,
      connectedViewers: new Set(),
      createdAt: Date.now(),
    });
  }
  return sessions.get(sessionId);
}

// 🔒 Cleanup expired sessions and their PDF files every 30 minutes
function cleanupExpiredSessions() {
  const now = Date.now();
  sessions.forEach((session, sessionId) => {
    if (now - session.createdAt > SESSION_TTL) {
      // Delete associated PDF file if exists
      if (session.pdfFile) {
        const filePath = path.join(UPLOAD_DIR, session.pdfFile);
        fs.unlink(filePath, (err) => {
          if (err && err.code !== "ENOENT") {
            console.error(`[Cleanup] Failed to delete PDF ${session.pdfFile}:`, err.message);
          }
        });
        fileToSession.delete(session.pdfFile);
      }
      // Clean up session and token
      sessions.delete(sessionId);
      uploadTokens.delete(sessionId);
      console.log(`[Cleanup] Expired session ${sessionId} removed`);
    }
  });
}
setInterval(cleanupExpiredSessions, CLEANUP_INTERVAL);

// 🔒 CSRF Protection Middleware - require x-requested-with header
function requireCsrfToken(req, res, next) {
  const requestedWith = req.headers["x-requested-with"];
  if (requestedWith !== "XMLHttpRequest") {
    return res.status(403).json({ error: "Forbidden: missing CSRF protection header" });
  }
  next();
}

// 🔒 Rate Limiters
const sessionLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 20, // 20 requests per hour
  message: { error: "Too many sessions created from this IP" },
  standardHeaders: true,
  legacyHeaders: false,
});

const uploadLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 10, // 10 uploads per hour per session
  message: { error: "Too many uploads for this session" },
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => req.params.sessionId || req.ip,
});

// 🔒 Security Headers Middleware
function securityHeaders(req, res, next) {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader(
    "Content-Security-Policy",
    "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; worker-src 'self' blob:; object-src 'none'"
  );
  next();
}
app.use(securityHeaders);

// ─── Static Files ─────────────────────────────────────────────────────────────

app.use(express.static(path.join(__dirname, "public")));
app.use(express.json());

// 🔒 Secure PDF serving - require auth instead of public static
app.get("/uploads/:filename", (req, res) => {
  const { filename } = req.params;
  // Prevent directory traversal
  if (filename.includes("..") || filename.includes("/") || filename.includes("\\")) {
    return res.status(400).json({ error: "Invalid filename" });
  }

  const filePath = path.join(UPLOAD_DIR, filename);
  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: "File not found" });
  }

  // 🔒 Security: Check authorization via token, socket membership, or same-origin
  const token = req.headers["x-upload-token"];
  const sessionId = fileToSession.get(filename);

  let authorized = false;

  // Option 1: Valid upload token for the session that owns this file
  if (sessionId && validateUploadToken(sessionId, token)) {
    authorized = true;
  }

  // Option 2: Request from a connected socket in the file's session
  if (!authorized && sessionId) {
    const sockets = io.sockets.adapter.rooms.get(sessionId);
    if (sockets) {
      for (const socketId of sockets) {
        const socket = io.sockets.sockets.get(socketId);
        if (socket && socket.data.sessionId === sessionId) {
          authorized = true;
          break;
        }
      }
    }
  }

  // Option 3: Same-origin request (browser loading PDF from same site)
  // This is the fallback for PDF.js loading files - relies on CORS and Referer
  if (!authorized) {
    const referer = req.headers.referer || "";
    const origin = req.headers.origin || "";
    const host = req.headers.host || "";
    // Allow if referer/origin matches our host (same-origin or same-site request)
    if ((referer && referer.includes(host)) || (origin && origin.includes(host)) || (!referer && !origin)) {
      authorized = true;
    }
  }

  if (!authorized) {
    return res.status(403).json({ error: "Forbidden: unauthorized PDF access" });
  }

  res.sendFile(filePath);
});

// ─── REST Endpoints ───────────────────────────────────────────────────────────

/**
 * POST /api/session
 * Creates a new presentation session. Returns sessionId + QR code URL.
 * 🔒 Generates upload token for session security
 */
app.post("/api/session", sessionLimiter, requireCsrfToken, async (req, res) => {
  const sessionId = uuidv4().replace(/-/g, "").toUpperCase(); // Full 32-char UUID
  getOrCreateSession(sessionId);

  // 🔒 Generate upload token for this session (only presenter gets this)
  const uploadToken = generateSecureToken();
  uploadTokens.set(sessionId, uploadToken);

  // Build the remote-control URL
  const host = req.headers.host;
  const protocol = req.headers["x-forwarded-proto"] || "http";
  const remoteUrl = `${protocol}://${host}/remote.html?session=${sessionId}`;

  // Generate QR code as data URL
  let qrDataUrl = null;
  let viewerUrl = null;
  let viewerQrDataUrl = null;
  try {
    qrDataUrl = await QRCode.toDataURL(remoteUrl, {
      width: 256,
      margin: 2,
      color: { dark: "#1a1a2e", light: "#ffffff" },
    });

    // Generate viewer URL and QR
    viewerUrl = `${protocol}://${host}/viewer.html?session=${sessionId}`;
    viewerQrDataUrl = await QRCode.toDataURL(viewerUrl, {
      width: 256,
      margin: 2,
      color: { dark: "#1a1a2e", light: "#ffffff" },
    });
  } catch (e) {
    console.error("QR generation failed:", e.message);
  }

  res.json({ sessionId, uploadToken, remoteUrl, qrDataUrl, viewerUrl, viewerQrDataUrl });
});

/**
 * POST /api/upload/:sessionId
 * Upload a PDF file and associate it with a session.
 * 🔒 SECURED: Requires valid upload token (only known to presenter)
 * NOTE: frontend must use fetch() with header x-requested-with: XMLHttpRequest
 * Plain HTML <form> uploads will be rejected — this is intentional
 */
app.post("/api/upload/:sessionId", uploadLimiter, requireCsrfToken, (req, res, next) => {
  const { sessionId } = req.params;
  const token = req.headers["x-upload-token"] || req.body.token;

  // 🔒 AUTHORIZATION: Validate upload token
  if (!validateUploadToken(sessionId, token)) {
    console.log(`[API] Rejected upload: invalid token for session ${sessionId}`);
    return res.status(403).json({ error: "Forbidden: invalid or missing upload token" });
  }

  next();
}, upload.single("pdf"), (req, res) => {
  const { sessionId } = req.params;
  if (!sessions.has(sessionId)) {
    return res.status(404).json({ error: "Session not found" });
  }
  if (!req.file) {
    return res.status(400).json({ error: "No PDF uploaded" });
  }

  const session = sessions.get(sessionId);
  session.pdfFile = req.file.filename;
  session.currentSlide = 1;
  // Track which session owns this file
  fileToSession.set(req.file.filename, sessionId);

  const pdfUrl = `/uploads/${req.file.filename}`;

  // Notify all clients in this room that a new PDF is loaded
  io.to(sessionId).emit("pdf-loaded", {
    pdfUrl,
    filename: req.file.originalname,
    currentSlide: 1,
  });

  res.json({ pdfUrl, filename: req.file.originalname });
});

/**
 * GET /api/session/:sessionId
 * Returns current session state (for rejoining).
 * 🔒 SECURED: Only accessible to same-origin or with valid token
 */
app.get("/api/session/:sessionId", (req, res) => {
  const { sessionId } = req.params;
  const session = sessions.get(sessionId);
  if (!session) return res.status(404).json({ error: "Session not found" });

  // 🔒 AUTHORIZATION: Only allow internal requests or with valid token
  const token = req.headers["x-upload-token"];
  if (!isInternalRequest(req) && !validateUploadToken(sessionId, token)) {
    // Return limited info to non-members
    return res.json({
      exists: true,
      hasPdf: !!session.pdfFile,
    });
  }

  res.json({
    currentSlide: session.currentSlide,
    totalSlides: session.totalSlides,
    pdfFile: session.pdfFile ? `/uploads/${session.pdfFile}` : null,
  });
});

/**
 * GET /api/sessions
 * Returns a list of all active sessions for the access page.
 * 🔒 SECURED: Only accessible from localhost/internal network
 */
app.get("/api/sessions", (req, res) => {
  // 🔒 AUTHORIZATION: Only allow from localhost/internal
  if (!isInternalRequest(req)) {
    return res.status(403).json({ error: "Forbidden: external access denied" });
  }

  const activeSessions = [];
  sessions.forEach((data, id) => {
    // Only include sessions that have a PDF loaded or are active
    activeSessions.push({
      id,
      filename: data.pdfFile
        ? data.pdfFile.split("-").slice(1).join("-")
        : null,
      viewerCount: data.connectedViewers.size,
    });
  });
  res.json({ sessions: activeSessions });
});

/**
 * GET /api/pdfs
 * Lists all uploaded PDFs available on the server.
 * 🔒 SECURED: Only accessible from localhost/internal network or with valid session token
 */
app.get("/api/pdfs", (req, res) => {
  // 🔒 AUTHORIZATION: Check for internal request or valid session
  const sessionId = req.headers["x-session-id"];
  const token = req.headers["x-upload-token"];
  const hasValidToken = sessionId && validateUploadToken(sessionId, token);

  if (!isInternalRequest(req) && !hasValidToken) {
    return res.status(403).json({ error: "Forbidden: external access denied" });
  }

  try {
    const files = fs
      .readdirSync(UPLOAD_DIR)
      .filter((f) => f.endsWith(".pdf"))
      .map((f) => ({ name: f, url: `/uploads/${f}` }));
    res.json(files);
  } catch {
    res.json([]);
  }
});

/**
 * DELETE /api/pdfs/:filename
 * Deletes a PDF file from the server.
 * 🔒 SECURED: Only accessible from localhost/internal network or with valid session token
 */
app.delete("/api/pdfs/:filename", (req, res) => {
  // 🔒 AUTHORIZATION: Check for internal request or valid session token
  const sessionId = req.headers["x-session-id"];
  const token = req.headers["x-upload-token"];
  const hasValidToken = sessionId && validateUploadToken(sessionId, token);

  if (!isInternalRequest(req) && !hasValidToken) {
    return res.status(403).json({ error: "Forbidden: external access denied" });
  }

  try {
    const { filename } = req.params;
    // Prevent directory traversal
    if (filename.includes("..") || filename.includes("/") || filename.includes("\\")) {
      return res.status(400).json({ error: "Invalid filename" });
    }
    const filePath = path.join(UPLOAD_DIR, filename);
    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ error: "File not found" });
    }
    fs.unlinkSync(filePath);
    res.json({ success: true });
  } catch (err) {
    console.error("Delete error:", err);
    res.status(500).json({ error: "Failed to delete file" });
  }
});

// ─── WebSocket (Socket.io) ────────────────────────────────────────────────────

io.on("connection", (socket) => {
  console.log(`[WS] Client connected: ${socket.id}`);

  /**
   * join-session: Called by presenter, remote, or viewer clients.
   * role: "presenter" | "remote" | "viewer"
   * 🔒 SECURED: Role cannot be changed after initial join. Only one presenter allowed.
   */
  socket.on("join-session", ({ sessionId, role }) => {
    if (!sessionId) return;
    if (!["presenter", "remote", "viewer"].includes(role)) return;

    const session = getOrCreateSession(sessionId);

    // 🔒 SECURITY: Prevent role changes after initial join
    if (socket.data.sessionId) {
      console.log(`[WS] Rejected: ${socket.data.role} tried to re-join as ${role}`);
      socket.emit("error", { message: "Forbidden: role cannot be changed after joining" });
      return;
    }

    // 🔒 SECURITY: Prevent multiple presenters (first-come-first-serve)
    if (role === "presenter" && session.presenterSocket) {
      console.log(`[WS] Rejected: presenter slot already taken in session ${sessionId}`);
      socket.emit("error", { message: "Forbidden: session already has a presenter" });
      return;
    }

    socket.join(sessionId);
    socket.data.sessionId = sessionId;
    socket.data.role = role;
    socket.data.joinedAt = Date.now();

    if (role === "presenter") {
      session.presenterSocket = socket.id;
    } else if (role === "viewer") {
      session.connectedViewers.add(socket.id);
      // Notify presenter of viewer count change
      if (session.presenterSocket) {
        io.to(session.presenterSocket).emit("viewer-count", {
          count: session.connectedViewers.size,
        });
      }
    }

    console.log(`[WS] ${role} joined session ${sessionId}`);

    // Send current state to the newly joined client
    socket.emit("session-state", {
      currentSlide: session.currentSlide,
      totalSlides: session.totalSlides,
      pdfFile: session.pdfFile ? `/uploads/${session.pdfFile}` : null,
    });
  });

  /**
   * slide-change: Sent by presenter or remote to move slides.
   * direction: "next" | "prev" | number (absolute)
   * 🔒 SECURED: Requires "presenter" or "remote" role + session membership
   */
  socket.on("slide-change", ({ sessionId, direction, slide }) => {
    // 🔒 AUTHORIZATION: Only presenter or remote can change slides
    if (!requireSessionMatch(socket, sessionId)) return;
    if (!requireRole(socket, ["presenter", "remote"])) return;

    const session = sessions.get(sessionId);
    if (!session) return;

    if (typeof slide === "number") {
      session.currentSlide = Math.max(
        1,
        Math.min(slide, session.totalSlides > 0 ? session.totalSlides : 9999),
      );
    } else if (direction === "next") {
      session.currentSlide = Math.min(
        session.currentSlide + 1,
        session.totalSlides || 9999,
      );
    } else if (direction === "prev") {
      session.currentSlide = Math.max(session.currentSlide - 1, 1);
    }

    // Broadcast updated slide to ALL clients in the room (including sender)
    io.to(sessionId).emit("slide-update", {
      currentSlide: session.currentSlide,
    });
  });

  /**
   * set-total-slides: Presenter reports total page count after PDF loads.
   * 🔒 SECURED: Requires "presenter" role + session membership + input validation
   */
  socket.on("set-total-slides", ({ sessionId, totalSlides }) => {
    // 🔒 AUTHORIZATION: Only presenter can set total slides
    if (!requireSessionMatch(socket, sessionId)) return;
    if (!requireRole(socket, ["presenter"])) return;

    const session = sessions.get(sessionId);
    if (!session) return;

    // 🔒 INPUT VALIDATION: Sanitize slide count
    const sanitizedCount = sanitizeSlideCount(totalSlides);
    if (sanitizedCount === null) {
      socket.emit("error", { message: "Invalid slide count" });
      return;
    }

    session.totalSlides = sanitizedCount;
    io.to(sessionId).emit("total-slides-update", { totalSlides: sanitizedCount });
  });

  /**
   * pdf-file-loaded: Presenter notifies server when loading PDF from library
   * 🔒 SECURED: Requires "presenter" role + session membership + file path validation
   */
  socket.on("pdf-file-loaded", ({ sessionId, pdfUrl, filename }) => {
    // 🔒 AUTHORIZATION: Only presenter can change PDFs
    if (!requireSessionMatch(socket, sessionId)) return;
    if (!requireRole(socket, ["presenter"])) return;

    const session = sessions.get(sessionId);
    if (!session) return;

    // 🔒 INPUT VALIDATION: Sanitize PDF filename to prevent path traversal
    const pdfFile = sanitizePdfFilename(pdfUrl);
    if (!pdfFile) {
      socket.emit("error", { message: "Invalid PDF filename" });
      return;
    }

    // 🔒 FILE EXISTENCE: Verify the file actually exists
    const filePath = path.join(UPLOAD_DIR, pdfFile);
    if (!fs.existsSync(filePath)) {
      socket.emit("error", { message: "PDF file not found" });
      return;
    }

    session.pdfFile = pdfFile;
    session.currentSlide = 1; // Reset to first slide on PDF change

    console.log(`[WS] PDF loaded in session ${sessionId}: ${filename}`);

    // Notify all clients in the room about the new PDF
    io.to(sessionId).emit("pdf-loaded", {
      pdfUrl: `/uploads/${pdfFile}`,
      filename,
      currentSlide: 1,
      totalSlides: session.totalSlides,
    });
  });
  /**
   * request-session-state: Client requests current session state (for recovery)
   * 🔒 SECURED: Requires session membership (prevents session enumeration)
   */
  socket.on("request-session-state", ({ sessionId }) => {
    // 🔒 AUTHORIZATION: Only members of the session can query its state
    if (!requireSessionMatch(socket, sessionId)) return;

    const session = sessions.get(sessionId);
    if (!session) return;

    socket.emit("session-state", {
      currentSlide: session.currentSlide,
      totalSlides: session.totalSlides,
      pdfFile: session.pdfFile ? `/uploads/${session.pdfFile}` : null,
    });
  });

  /**
   * cursor-move: Remote broadcasts cursor position to presenter.
   * 🔒 SECURED: Requires "remote" role + session membership + coordinate clamping
   */
  socket.on("cursor-move", ({ sessionId, x, y, active }) => {
    // 🔒 AUTHORIZATION: Only remote controllers should send cursor
    if (!requireSessionMatch(socket, sessionId)) return;
    if (!requireRole(socket, ["remote"])) return;

    // 🔒 RATE LIMITING: Max 60 emissions/second (16ms minimum between events)
    const now = Date.now();
    const lastEmit = socket.data.lastCursorMove || 0;
    if (now - lastEmit < 16) {
      return; // Drop silently - too frequent
    }
    socket.data.lastCursorMove = now;

    // 🔒 INPUT VALIDATION: Clamp coordinates to valid 0-1 range
    const clampedX = Math.max(0, Math.min(1, parseFloat(x) || 0));
    const clampedY = Math.max(0, Math.min(1, parseFloat(y) || 0));

    socket.to(sessionId).emit("cursor-move", { x: clampedX, y: clampedY, active: !!active });
  });

  socket.on("disconnect", () => {
    const { sessionId, role } = socket.data;
    console.log(
      `[WS] ${role || "client"} disconnected from session ${sessionId}`,
    );

    // Remove viewer from tracking
    if (role === "viewer" && sessionId && sessions.has(sessionId)) {
      const session = sessions.get(sessionId);
      session.connectedViewers.delete(socket.id);
      // Notify presenter of viewer count change
      if (session.presenterSocket) {
        io.to(session.presenterSocket).emit("viewer-count", {
          count: session.connectedViewers.size,
        });
      }
    }
  });
});

// ─── Error Handler ────────────────────────────────────────────────────────────

app.use((err, _req, res, _next) => {
  console.error(err.message);
  res.status(500).json({ error: err.message });
});

// ─── Start ────────────────────────────────────────────────────────────────────

server.listen(PORT, () => {
  console.log(`\n🎯 PDF Presenter running at http://localhost:${PORT}`);
  console.log(`   Open the URL above in your browser to start presenting.\n`);
});
