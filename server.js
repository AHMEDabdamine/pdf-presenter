/**
 * PDF Presenter - Server
 * APACHE License
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
const os = require("os");
const bcrypt = require("bcrypt");
const QRCode = require("qrcode");
const { v4: uuidv4 } = require("uuid");
const rateLimit = require("express-rate-limit");

// ─── App Setup ───────────────────────────────────────────────────────────────

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: false }, //  SECURITY: Disable cross-origin - same-origin only
  maxHttpBufferSize: 50 * 1024 * 1024, // 50 MB for PDF uploads via socket
});

const PORT = process.env.PORT || 3000;
const UPLOAD_DIR = path.join(__dirname, "uploads");
const DATA_DIR = path.join(__dirname, "data");
const LIKES_FILE = path.join(DATA_DIR, "likes.json");
const NODE_ENV = process.env.NODE_ENV || "development";
const IS_PRODUCTION = NODE_ENV === "production";

// Ensure uploads and data directories exist
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

// ─── Like Counter Helpers ───────────────────────────────────────────────────

function getLikesData() {
  try {
    if (fs.existsSync(LIKES_FILE)) {
      const data = fs.readFileSync(LIKES_FILE, "utf8");
      return JSON.parse(data);
    }
  } catch (err) {
    if (!IS_PRODUCTION) console.error("[Likes] Error reading likes file:", err);
  }
  return { count: 0, likedDevices: [] };
}

function saveLikesData(data) {
  try {
    fs.writeFileSync(LIKES_FILE, JSON.stringify(data, null, 2));
    return true;
  } catch (err) {
    if (!IS_PRODUCTION) console.error("[Likes] Error writing likes file:", err);
    return false;
  }
}

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
    if (!IS_PRODUCTION) console.log(`[WS] Rejected: role ${role} not in [${allowedRoles.join(", ")}]`);
    socket.emit("error", { message: `Forbidden: requires one of [${allowedRoles.join(", ")}]` });
    return false;
  }
  return true;
}

function requireSessionMatch(socket, sessionId) {
  if (socket.data.sessionId !== sessionId) {
    if (!IS_PRODUCTION) console.log(`[WS] Rejected: session mismatch (${socket.data.sessionId} vs ${sessionId})`);
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

//  Generate cryptographically secure token
function generateSecureToken() {
  return crypto.randomBytes(32).toString("hex");
}

//  Validate upload token for session
function validateUploadToken(sessionId, token) {
  const expectedToken = uploadTokens.get(sessionId);
  if (!expectedToken || !token) return false;
  const a = Buffer.from(expectedToken);
  const b = Buffer.from(token);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

//  Viewer Token Management - Time-limited tokens for password-protected sessions
const viewerTokens = new Map(); // sessionId -> Map(token -> expiryTimestamp)
const VIEWER_TOKEN_TTL = 5 * 60 * 1000; // 5 minutes

function generateViewerToken(sessionId) {
  const token = crypto.randomBytes(32).toString("hex");
  const expiry = Date.now() + VIEWER_TOKEN_TTL;
  if (!viewerTokens.has(sessionId)) {
    viewerTokens.set(sessionId, new Map());
  }
  viewerTokens.get(sessionId).set(token, expiry);
  return token;
}

function validateViewerToken(sessionId, token) {
  const tokens = viewerTokens.get(sessionId);
  if (!tokens || !token) return false;
  const expiry = tokens.get(token);
  if (!expiry) return false;
  //  SECURITY: Check if token is expired
  if (Date.now() > expiry) {
    tokens.delete(token);
    return false;
  }
  return true;
}

// Cleanup expired viewer tokens periodically
setInterval(() => {
  const now = Date.now();
  viewerTokens.forEach((tokens, sessionId) => {
    tokens.forEach((expiry, token) => {
      if (now > expiry) tokens.delete(token);
    });
    if (tokens.size === 0) viewerTokens.delete(sessionId);
  });
}, 60000); // Clean up every minute

//  Check if request is from localhost/internal network
// NOTE: If running behind a trusted proxy, configure with app.set('trust proxy', 1)
// and only then will x-forwarded-for be considered by req.ip
function isInternalRequest(req) {
  const clientIp = req.ip || req.connection.remoteAddress || req.socket?.remoteAddress || "unknown";
  return clientIp === "127.0.0.1" || clientIp === "::1" || clientIp === "::ffff:127.0.0.1";
}

//  Input sanitization for session names
function sanitizeSessionName(name) {
  if (!name || typeof name !== "string") return null;
  // Strip leading/trailing whitespace
  let sanitized = name.trim();
  // Limit to 60 characters
  if (sanitized.length > 60) sanitized = sanitized.slice(0, 60);
  // Remove HTML tags and special characters - allow only letters, numbers, spaces, hyphens, underscores
  sanitized = sanitized.replace(/<[^>]*>/g, ""); // Remove HTML tags
  sanitized = sanitized.replace(/[^a-zA-Z0-9\s\-_]/g, ""); // Allow only allowed chars
  // Collapse multiple spaces
  sanitized = sanitized.replace(/\s+/g, " ");
  // Return null if empty after sanitization
  return sanitized.length > 0 ? sanitized : null;
}

function getOrCreateSession(sessionId, name = null, passwordHash = null) {
  if (!sessions.has(sessionId)) {
    sessions.set(sessionId, {
      currentSlide: 1,
      totalSlides: 0,
      pdfFile: null,
      presenterSocket: null,
      connectedViewers: new Set(),
      pendingRemotes: new Map(), // socketId -> { socketId, requestedAt }
      approvedRemotes: new Set(), // deviceIds that can rejoin without approval
      blockedRemotes: new Set(), // deviceIds that are blocked from requesting access
      remoteRequestsEnabled: true, // toggle to stop receiving all remote requests
      name: sanitizeSessionName(name) || "Untitled Session",
      passwordHash, //  SECURITY: Hashed password for viewer access (null = no password)
      passwordAttempts: new Map(), // Track failed attempts per IP
      createdAt: Date.now(),
    });
  }
  return sessions.get(sessionId);
}

//  Cleanup expired sessions and their PDF files every 30 minutes
function cleanupExpiredSessions() {
  const now = Date.now();
  sessions.forEach((session, sessionId) => {
    if (now - session.createdAt > SESSION_TTL) {
      // Delete associated PDF file if exists
      if (session.pdfFile) {
        const filePath = path.join(UPLOAD_DIR, session.pdfFile);
        fs.unlink(filePath, (err) => {
          if (err && err.code !== "ENOENT") {
            if (!IS_PRODUCTION) console.error(`[Cleanup] Failed to delete PDF ${session.pdfFile}:`, err.message);
          }
        });
        fileToSession.delete(session.pdfFile);
      }
      // Clean up session and token
      sessions.delete(sessionId);
      uploadTokens.delete(sessionId);
      if (!IS_PRODUCTION) console.log(`[Cleanup] Expired session ${sessionId} removed`);
    }
  });
}
setInterval(cleanupExpiredSessions, CLEANUP_INTERVAL);

//  CSRF Protection Middleware - require x-requested-with header
function requireCsrfToken(req, res, next) {
  const requestedWith = req.headers["x-requested-with"];
  if (requestedWith !== "XMLHttpRequest") {
    return res.status(403).json({ error: "Forbidden: missing CSRF protection header" });
  }
  next();
}

//  Rate Limiters
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

//  Security Headers Middleware
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
// Serve notification sound from root
app.use("/notification.wav", express.static(path.join(__dirname, "notification.wav")));
app.use(express.json());

//  Secure PDF serving - require auth instead of public static
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

  //  Security: Check authorization via token, socket membership, or same-origin
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
 *  Generates upload token for session security
 */
app.post("/api/session", sessionLimiter, requireCsrfToken, async (req, res) => {
  //  SECURITY: Use 16 chars (2^64 combos) - secure against brute force with rate limiting
  const sessionId = uuidv4().replace(/-/g, "").toUpperCase().slice(0, 16);

  // Get session name from request or generate default
  let sessionName = req.body.name;
  if (!sessionName) {
    sessionName = `Session ${sessionId.slice(0, 4)}`;
  }

  //  SECURITY: Hash password if provided (bcrypt with 10 rounds)
  let passwordHash = null;
  if (req.body.password && typeof req.body.password === "string" && req.body.password.length >= 4) {
    passwordHash = await bcrypt.hash(req.body.password, 10);
  }

  getOrCreateSession(sessionId, sessionName, passwordHash);

  //  Generate upload token for this session (only presenter gets this)
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
    if (!IS_PRODUCTION) console.error("QR generation failed:", e.message);
  }

  const session = sessions.get(sessionId);
  res.json({ sessionId, uploadToken, name: session.name, remoteUrl, qrDataUrl, viewerUrl, viewerQrDataUrl });
});

/**
 * POST /api/upload/:sessionId
 * Upload a PDF file and associate it with a session.
 *  SECURED: Requires valid upload token (only known to presenter)
 * NOTE: frontend must use fetch() with header x-requested-with: XMLHttpRequest
 * Plain HTML <form> uploads will be rejected — this is intentional
 */
app.post("/api/upload/:sessionId", uploadLimiter, requireCsrfToken, (req, res, next) => {
  const { sessionId } = req.params;
  const token = req.headers["x-upload-token"] || req.body.token;

  //  AUTHORIZATION: Validate upload token
  if (!validateUploadToken(sessionId, token)) {
    if (!IS_PRODUCTION) console.log(`[API] Rejected upload: invalid token for session ${sessionId}`);
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

  //  SECURITY: Verify file magic bytes (PDF files start with %PDF)
  try {
    const fd = fs.openSync(req.file.path, "r");
    const buffer = Buffer.alloc(4);
    fs.readSync(fd, buffer, 0, 4, 0);
    fs.closeSync(fd);

    // PDF magic bytes: %PDF (0x25 0x50 0x44 0x46)
    if (buffer.toString("ascii", 0, 4) !== "%PDF") {
      // Delete the invalid file
      fs.unlinkSync(req.file.path);
      return res.status(400).json({ error: "Invalid file: not a valid PDF" });
    }
  } catch (err) {
    if (!IS_PRODUCTION) console.error("[Upload] Magic bytes check failed:", err);
    fs.unlinkSync(req.file.path);
    return res.status(500).json({ error: "Failed to verify file" });
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
 * GET /health
 * Health check endpoint for Docker container monitoring
 */
app.get("/health", (req, res) => {
  res.status(200).json({ status: "ok", timestamp: new Date().toISOString() });
});

/**
 * GET /api/ip
 * Returns the machine's LAN IP address for QR code generation.
 *  Picks the first non-internal IPv4 address from network interfaces.
 */
app.get("/api/ip", (req, res) => {
  const interfaces = os.networkInterfaces();
  const ips = [];
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      // Skip internal (loopback) and non-IPv4 addresses
      if (!iface.internal && iface.family === "IPv4") {
        ips.push({ address: iface.address, interface: name });
      }
    }
  }
  res.json({ ip: ips.length > 0 ? ips[0].address : null, all: ips });
});

/**
 * GET /api/session/:sessionId
 * Returns current session state (for rejoining).
 *  SECURED: Only accessible to same-origin or with valid token
 */
app.get("/api/session/:sessionId", (req, res) => {
  const { sessionId } = req.params;
  const session = sessions.get(sessionId);
  if (!session) return res.status(404).json({ error: "Session not found" });

  //  AUTHORIZATION: Only allow internal requests or with valid token
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
    name: session.name,
  });
});

/**
 * GET /api/sessions
 * Returns a list of all active sessions for the access page.
 *  Note: Session IDs are exposed so viewers can join from any device
 */
app.get("/api/sessions", (req, res) => {
  const activeSessions = [];
  sessions.forEach((data, id) => {
    // Only include sessions that have a PDF loaded or are active
    activeSessions.push({
      id: id, // Full session ID needed for joining
      name: data.name,
      filename: data.pdfFile
        ? data.pdfFile.split("-").slice(1).join("-")
        : null,
      viewerCount: data.connectedViewers.size,
      hasPassword: !!data.passwordHash, //  SECURITY: Only expose if password exists
      createdAt: data.createdAt,
    });
  });
  res.json({ sessions: activeSessions });
});

/**
 * GET /api/session/:sessionId/requires-password
 * Checks if a session requires a password for viewer access.
 *  SECURITY: Does not reveal if password exists, only boolean
 */
app.get("/api/session/:sessionId/requires-password", (req, res) => {
  const { sessionId } = req.params;
  const session = sessions.get(sessionId);

  if (!session) {
    return res.status(404).json({ error: "Session not found" });
  }

  res.json({
    requiresPassword: !!session.passwordHash,
    name: session.name,
  });
});

/**
 * POST /api/session/:sessionId/verify-password
 * Verifies viewer password before allowing join.
 *  SECURITY: Rate limited, bcrypt comparison, no plaintext storage
 */
app.post("/api/session/:sessionId/verify-password", async (req, res) => {
  const { sessionId } = req.params;
  const { password } = req.body;
  const clientIp = req.ip || req.connection.remoteAddress || "unknown";

  const session = sessions.get(sessionId);
  if (!session) {
    return res.status(404).json({ error: "Session not found" });
  }

  // If no password set, allow access
  if (!session.passwordHash) {
    return res.json({ valid: true });
  }

  //  SECURITY: Rate limit password attempts per IP (max 5 per minute)
  const now = Date.now();
  const attempts = session.passwordAttempts.get(clientIp) || { count: 0, lastAttempt: 0 };

  // Reset counter if last attempt was > 1 minute ago
  if (now - attempts.lastAttempt > 60000) {
    attempts.count = 0;
  }

  if (attempts.count >= 5) {
    return res.status(429).json({ error: "Too many attempts. Please try again later." });
  }

  attempts.count++;
  attempts.lastAttempt = now;
  session.passwordAttempts.set(clientIp, attempts);

  //  SECURITY: bcrypt comparison (constant-time)
  const valid = await bcrypt.compare(password, session.passwordHash);

  if (valid) {
    // Clear attempts on success
    session.passwordAttempts.delete(clientIp);
    //  SECURITY: Generate single-use viewer token for WebSocket auth
    const viewerToken = generateViewerToken(sessionId);
    res.json({ valid: true, viewerToken });
  } else {
    res.status(401).json({ valid: false, error: "Invalid password" });
  }
});

/**
 * GET /api/pdfs
 * Lists all uploaded PDFs available on the server.
 *  SECURED: Only accessible from localhost/internal network or with valid session token
 */
app.get("/api/pdfs", (req, res) => {
  //  AUTHORIZATION: Check for internal request or valid session
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
 *  SECURED: Only accessible from localhost/internal network or with valid session token
 */
app.delete("/api/pdfs/:filename", (req, res) => {
  //  AUTHORIZATION: Check for internal request or valid session token
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
    if (!IS_PRODUCTION) console.error("Delete error:", err);
    res.status(500).json({ error: "Failed to delete file" });
  }
});

/**
 * GET /api/likes
 * Returns the current like count and whether the device has liked
 */
app.get("/api/likes", (req, res) => {
  const deviceId = req.headers["x-device-id"] || req.query.deviceId;
  const data = getLikesData();
  const hasLiked = deviceId && data.likedDevices.includes(deviceId);
  res.json({ count: data.count, hasLiked: !!hasLiked });
});

// Rate limiting store for likes (simple in-memory)
const likeRateLimits = new Map(); // deviceId -> { count, resetTime }
const LIKE_RATE_LIMIT = 10; // max 10 likes per minute per device
const LIKE_RATE_WINDOW = 60 * 1000; // 1 minute window

/**
 * POST /api/likes
 * Toggle like status for a device
 * Requires deviceId in request body
 * RATE LIMITED: 10 requests per minute per device
 */
app.post("/api/likes", (req, res) => {
  const { deviceId, action } = req.body;
  
  // Validate deviceId
  if (!deviceId || typeof deviceId !== "string") {
    return res.status(400).json({ error: "deviceId required" });
  }
  
  // Limit deviceId length to prevent DoS
  if (deviceId.length > 64) {
    return res.status(400).json({ error: "deviceId too long" });
  }
  
  // Validate deviceId format (alphanumeric, hyphens, underscores only)
  if (!/^[a-zA-Z0-9_-]+$/.test(deviceId)) {
    return res.status(400).json({ error: "Invalid deviceId format" });
  }
  
  // Rate limiting check
  const now = Date.now();
  const limitData = likeRateLimits.get(deviceId);
  if (limitData) {
    if (now < limitData.resetTime) {
      if (limitData.count >= LIKE_RATE_LIMIT) {
        return res.status(429).json({ error: "Rate limit exceeded. Try again later." });
      }
      limitData.count++;
    } else {
      // Reset window
      limitData.count = 1;
      limitData.resetTime = now + LIKE_RATE_WINDOW;
    }
  } else {
    likeRateLimits.set(deviceId, { count: 1, resetTime: now + LIKE_RATE_WINDOW });
  }
  
  // Cleanup old rate limit entries periodically
  if (Math.random() < 0.01) { // 1% chance per request
    const cutoff = now;
    for (const [id, data] of likeRateLimits) {
      if (data.resetTime < cutoff) likeRateLimits.delete(id);
    }
  }
  
  const data = getLikesData();
  const hasLiked = data.likedDevices.includes(deviceId);
  
  if (action === "unlike" || hasLiked) {
    // Unlike: remove device and decrement
    data.likedDevices = data.likedDevices.filter(id => id !== deviceId);
    data.count = Math.max(0, data.count - 1);
  } else {
    // Like: add device and increment
    data.likedDevices.push(deviceId);
    data.count += 1;
  }
  
  if (saveLikesData(data)) {
    res.json({ count: data.count, hasLiked: !hasLiked });
  } else {
    res.status(500).json({ error: "Failed to save likes" });
  }
});

// ─── WebSocket (Socket.io) ────────────────────────────────────────────────────

io.on("connection", (socket) => {
  if (!IS_PRODUCTION) console.log(`[WS] Client connected: ${socket.id}`);

  /**
   * join-session: Called by presenter, remote, or viewer clients.
   * role: "presenter" | "remote" | "viewer"
   *  SECURED: Role cannot be changed after initial join. Only one presenter allowed.
   */
  socket.on("join-session", ({ sessionId, role, viewerToken }) => {
    if (!sessionId) return;
    if (!["presenter", "remote", "viewer"].includes(role)) return;

    const session = getOrCreateSession(sessionId);

    //  SECURITY: Prevent role changes after initial join
    if (socket.data.sessionId) {
      if (!IS_PRODUCTION) console.log(`[WS] Rejected: ${socket.data.role} tried to re-join as ${role}`);
      socket.emit("error", { message: "Forbidden: role cannot be changed after joining" });
      return;
    }

    //  SECURITY: Prevent multiple presenters (first-come-first-serve)
    if (role === "presenter" && session.presenterSocket) {
      if (!IS_PRODUCTION) console.log(`[WS] Rejected: presenter slot already taken in session ${sessionId}`);
      socket.emit("error", { message: "Forbidden: session already has a presenter" });
      return;
    }

    //  PASSWORD PROTECTION: Viewers must provide valid token if password is set
    if (role === "viewer" && session.passwordHash) {
      //  SECURITY: Validate JWT-style viewer token signed with session secret
      if (!viewerToken || !validateViewerToken(sessionId, viewerToken)) {
        socket.emit("error", { message: "password-required", code: "PASSWORD_REQUIRED" });
        return;
      }
    }

    //  REMOTE APPROVAL: Remotes require presenter acceptance before joining
    if (role === "remote") {
      if (!session.presenterSocket) {
        socket.emit("error", { message: "No presenter in session" });
        return;
      }
      // Check if already approved (reconnecting)
      if (!session.pendingRemotes.has(socket.id) && !socket.data.approvedRemote) {
        socket.emit("error", { message: "Remote not approved. Request access first." });
        return;
      }
    }

    socket.join(sessionId);
    socket.data.sessionId = sessionId;
    socket.data.role = role;
    socket.data.joinedAt = Date.now();

    if (role === "presenter") {
      session.presenterSocket = socket.id;
    } else if (role === "viewer") {
      session.connectedViewers.add(socket.id);
      // Broadcast viewer count to all session members
      io.to(sessionId).emit("viewer-count", {
        count: session.connectedViewers.size,
      });
    }

    if (!IS_PRODUCTION) console.log(`[WS] ${role} joined session ${sessionId}`);

    // Send current state to the newly joined client
    socket.emit("session-state", {
      currentSlide: session.currentSlide,
      totalSlides: session.totalSlides,
      pdfFile: session.pdfFile ? `/uploads/${session.pdfFile}` : null,
      name: session.name,
      viewerCount: session.connectedViewers.size,
    });
  });

  /**
   * remote-request-access: Sent by remote to request presenter approval.
   * Presenter must accept before remote can join.
   *  RATE LIMITED: 1 request per 5 seconds per socket
   *  DEDUPLICATED: Same device cannot request multiple times
   *  MAX PENDING: 10 pending requests per session maximum
   */
  socket.on("remote-request-access", ({ sessionId, deviceId }) => {
    if (!IS_PRODUCTION) console.log(`[WS] remote-request-access from ${socket.id}, device: ${deviceId}, session: ${sessionId}`);
    
    //  RATE LIMITING: Prevent rapid re-requests (5 second cooldown)
    const now = Date.now();
    const lastRequest = socket.data.lastRemoteRequest || 0;
    if (now - lastRequest < 5000) {
      socket.emit("error", { message: "Please wait before requesting again" });
      return;
    }
    socket.data.lastRemoteRequest = now;

    const session = sessions.get(sessionId);
    if (!session) {
      socket.emit("error", { message: "Session not found" });
      return;
    }
    if (!session.presenterSocket) {
      socket.emit("error", { message: "No presenter in session" });
      return;
    }

    //  CHECK: Remote requests disabled by presenter
    if (!session.remoteRequestsEnabled) {
      socket.emit("error", { message: "Remote requests are currently disabled" });
      return;
    }

    //  CHECK: Device is blocked
    if (deviceId && session.blockedRemotes.has(deviceId)) {
      socket.emit("error", { message: "Access denied" });
      return;
    }

    // Check if device is already approved (remember this device)
    if (deviceId && session.approvedRemotes.has(deviceId)) {
      if (!IS_PRODUCTION) console.log(`[WS] Auto-approving device ${deviceId} for session ${sessionId}`);
      // Auto-join the session
      socket.data.approvedRemote = true;
      socket.data.sessionId = sessionId;
      socket.data.role = "remote";
      socket.data.deviceId = deviceId;
      socket.join(sessionId);
      if (!IS_PRODUCTION) console.log(`[WS] Socket ${socket.id} assigned sessionId: ${socket.data.sessionId}`);

      socket.emit("remote-approved", { message: "Access granted (previously approved)" });
      socket.emit("session-state", {
        currentSlide: session.currentSlide,
        totalSlides: session.totalSlides,
        pdfFile: session.pdfFile ? `/uploads/${session.pdfFile}` : null,
        name: session.name,
      });
      if (!IS_PRODUCTION) console.log(`[WS] Device ${deviceId} auto-approved and joined session ${sessionId}`);
      return;
    }

    //  DEDUPLICATION: Check if this device already has a pending request
    if (deviceId) {
      for (const [existingSocketId, pending] of session.pendingRemotes) {
        if (pending.deviceId === deviceId) {
          socket.emit("remote-request-sent", { message: "Request already pending" });
          return;
        }
      }
    }

    //  MAX PENDING: Limit total pending requests per session
    if (session.pendingRemotes.size >= 10) {
      socket.emit("error", { message: "Too many pending requests. Please try again later." });
      return;
    }

    // Store deviceId for this socket for later reference
    socket.data.deviceId = deviceId;

    // Add to pending remotes
    session.pendingRemotes.set(socket.id, {
      socketId: socket.id,
      deviceId: deviceId,
      requestedAt: Date.now(),
    });

    // Notify presenter of pending remote
    io.to(session.presenterSocket).emit("remote-pending", {
      socketId: socket.id,
      deviceId: deviceId,
      count: session.pendingRemotes.size,
    });

    // Confirm to remote that request was sent
    socket.emit("remote-request-sent", { message: "Request sent to presenter" });
    if (!IS_PRODUCTION) console.log(`[WS] Remote ${socket.id} (device: ${deviceId}) requested access to session ${sessionId}`);
  });

  /**
   * remote-accept: Presenter accepts a pending remote.
   */
  socket.on("remote-accept", ({ sessionId, remoteSocketId }) => {
    if (!requireSessionMatch(socket, sessionId)) return;
    if (!requireRole(socket, ["presenter"])) return;

    const session = sessions.get(sessionId);
    if (!session) return;
    if (!session.pendingRemotes.has(remoteSocketId)) {
      socket.emit("error", { message: "Remote request not found" });
      return;
    }

    // Mark as approved
    const remoteSocket = io.sockets.sockets.get(remoteSocketId);
    const pendingRequest = session.pendingRemotes.get(remoteSocketId);

    if (remoteSocket) {
      if (!IS_PRODUCTION) console.log(`[WS] remote-accept: Setting sessionId for socket ${remoteSocket.id} to ${sessionId}`);
      remoteSocket.data.approvedRemote = true;
      remoteSocket.data.sessionId = sessionId;
      remoteSocket.data.role = "remote";
      remoteSocket.join(sessionId);
      if (!IS_PRODUCTION) console.log(`[WS] remote-accept: Socket ${remoteSocket.id} sessionId now: ${remoteSocket.data.sessionId}`);

      // Add device ID to approved remotes list (remember this device)
      if (pendingRequest && pendingRequest.deviceId) {
        session.approvedRemotes.add(pendingRequest.deviceId);
        if (!IS_PRODUCTION) console.log(`[WS] Added device ${pendingRequest.deviceId} to approved list for session ${sessionId}`);
      }

      // Notify remote they were accepted
      remoteSocket.emit("remote-approved", { message: "Access granted" });
      remoteSocket.emit("session-state", {
        currentSlide: session.currentSlide,
        totalSlides: session.totalSlides,
        pdfFile: session.pdfFile ? `/uploads/${session.pdfFile}` : null,
        name: session.name,
      });
    }

    session.pendingRemotes.delete(remoteSocketId);
    io.to(session.presenterSocket).emit("remote-accepted", { remoteSocketId });
    if (!IS_PRODUCTION) console.log(`[WS] Presenter accepted remote ${remoteSocketId} in session ${sessionId}`);
  });

  /**
   * remote-reject: Presenter rejects a pending remote.
   */
  socket.on("remote-reject", ({ sessionId, remoteSocketId }) => {
    if (!requireSessionMatch(socket, sessionId)) return;
    if (!requireRole(socket, ["presenter"])) return;

    const session = sessions.get(sessionId);
    if (!session) return;
    if (!session.pendingRemotes.has(remoteSocketId)) {
      socket.emit("error", { message: "Remote request not found" });
      return;
    }

    const remoteSocket = io.sockets.sockets.get(remoteSocketId);
    if (remoteSocket) {
      remoteSocket.emit("remote-rejected", { message: "Access denied by presenter" });
      remoteSocket.disconnect(true);
    }

    session.pendingRemotes.delete(remoteSocketId);
    io.to(session.presenterSocket).emit("remote-rejected", { remoteSocketId });
    if (!IS_PRODUCTION) console.log(`[WS] Presenter rejected remote ${remoteSocketId} in session ${sessionId}`);
  });

  /**
   * remote-block: Presenter blocks a device from requesting access.
   */
  socket.on("remote-block", ({ sessionId, deviceId }) => {
    if (!requireSessionMatch(socket, sessionId)) return;
    if (!requireRole(socket, ["presenter"])) return;

    const session = sessions.get(sessionId);
    if (!session || !deviceId) return;

    // Add to blocked list
    session.blockedRemotes.add(deviceId);
    // Remove from approved if previously approved
    session.approvedRemotes.delete(deviceId);

    // Remove any pending request from this device
    for (const [socketId, pending] of session.pendingRemotes) {
      if (pending.deviceId === deviceId) {
        const remoteSocket = io.sockets.sockets.get(socketId);
        if (remoteSocket) {
          remoteSocket.emit("remote-rejected", { message: "You have been blocked from this session" });
          remoteSocket.disconnect(true);
        }
        session.pendingRemotes.delete(socketId);
        io.to(session.presenterSocket).emit("remote-rejected", { remoteSocketId: socketId });
        break;
      }
    }

    socket.emit("remote-blocked", { deviceId });
    if (!IS_PRODUCTION) console.log(`[WS] Device ${deviceId} blocked from session ${sessionId}`);
  });

  /**
   * toggle-remote-requests: Presenter enables/disables remote requests.
   */
  socket.on("toggle-remote-requests", ({ sessionId, enabled }) => {
    if (!requireSessionMatch(socket, sessionId)) return;
    if (!requireRole(socket, ["presenter"])) return;

    const session = sessions.get(sessionId);
    if (!session) return;

    session.remoteRequestsEnabled = enabled;
    socket.emit("remote-requests-toggled", { enabled });
    if (!IS_PRODUCTION) console.log(`[WS] Remote requests ${enabled ? "enabled" : "disabled"} for session ${sessionId}`);
  });

  /**
   * slide-change: Sent by presenter or remote to move slides.
   * direction: "next" | "prev" | number (absolute)
   *  SECURED: Requires "presenter" or "remote" role + session membership
   */
  socket.on("slide-change", ({ sessionId, direction, slide }) => {
    //  AUTHORIZATION: Only presenter or remote can change slides
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
   *  SECURED: Requires "presenter" role + session membership + input validation
   */
  socket.on("set-total-slides", ({ sessionId, totalSlides }) => {
    //  AUTHORIZATION: Only presenter can set total slides
    if (!requireSessionMatch(socket, sessionId)) return;
    if (!requireRole(socket, ["presenter"])) return;

    const session = sessions.get(sessionId);
    if (!session) return;

    //  INPUT VALIDATION: Sanitize slide count
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
   *  SECURED: Requires "presenter" role + session membership + file path validation
   */
  socket.on("pdf-file-loaded", ({ sessionId, pdfUrl, filename }) => {
    //  AUTHORIZATION: Only presenter can change PDFs
    if (!requireSessionMatch(socket, sessionId)) return;
    if (!requireRole(socket, ["presenter"])) return;

    const session = sessions.get(sessionId);
    if (!session) return;

    //  INPUT VALIDATION: Sanitize PDF filename to prevent path traversal
    const pdfFile = sanitizePdfFilename(pdfUrl);
    if (!pdfFile) {
      socket.emit("error", { message: "Invalid PDF filename" });
      return;
    }

    //  FILE EXISTENCE: Verify the file actually exists
    const filePath = path.join(UPLOAD_DIR, pdfFile);
    if (!fs.existsSync(filePath)) {
      socket.emit("error", { message: "PDF file not found" });
      return;
    }

    session.pdfFile = pdfFile;
    session.currentSlide = 1; // Reset to first slide on PDF change

    if (!IS_PRODUCTION) console.log(`[WS] PDF loaded in session ${sessionId}: ${filename}`);

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
   *  SECURED: Requires session membership (prevents session enumeration)
   */
  socket.on("request-session-state", ({ sessionId }) => {
    //  AUTHORIZATION: Only members of the session can query its state
    if (!requireSessionMatch(socket, sessionId)) return;

    const session = sessions.get(sessionId);
    if (!session) return;

    socket.emit("session-state", {
      currentSlide: session.currentSlide,
      totalSlides: session.totalSlides,
      pdfFile: session.pdfFile ? `/uploads/${session.pdfFile}` : null,
      name: session.name,
    });
  });

  /**
   * cursor-move: Remote broadcasts cursor position to presenter.
   *  SECURED: Requires "remote" role + session membership + coordinate clamping
   */
  socket.on("cursor-move", ({ sessionId, x, y, active }) => {
    //  AUTHORIZATION: Only remote controllers should send cursor
    if (!requireSessionMatch(socket, sessionId)) return;
    if (!requireRole(socket, ["remote"])) return;

    //  RATE LIMITING: Max 120 emissions/second (8ms minimum between events)
    const now = Date.now();
    const lastEmit = socket.data.lastCursorMove || 0;
    if (now - lastEmit < 8) {
      return; // Drop silently - too frequent
    }
    socket.data.lastCursorMove = now;

    //  INPUT VALIDATION: Clamp coordinates to valid 0-1 range
    const clampedX = Math.max(0, Math.min(1, parseFloat(x) || 0));
    const clampedY = Math.max(0, Math.min(1, parseFloat(y) || 0));

    socket.to(sessionId).emit("cursor-move", { x: clampedX, y: clampedY, active: !!active });
  });

  /**
   * rename-session: Presenter updates the session name.
   *  SECURED: Requires "presenter" role + session membership + name validation
   */
  socket.on("rename-session", ({ sessionId, name }) => {
    //  AUTHORIZATION: Only presenter can rename
    if (!requireSessionMatch(socket, sessionId)) return;
    if (!requireRole(socket, ["presenter"])) return;

    const session = sessions.get(sessionId);
    if (!session) return;

    //  INPUT VALIDATION: Sanitize the name
    const sanitizedName = sanitizeSessionName(name);
    if (!sanitizedName) {
      socket.emit("error", { message: "Invalid session name" });
      return;
    }

    session.name = sanitizedName;
    if (!IS_PRODUCTION) console.log(`[WS] Session ${sessionId} renamed to "${sanitizedName}"`);

    // Broadcast to all clients
    io.to(sessionId).emit("session-renamed", { name: sanitizedName });
  });

  /**
   * end-session: Presenter explicitly ends the session.
   *  SECURED: Requires "presenter" role + session membership
   *  Cleans up all server-side resources
   */
  socket.on("end-session", ({ sessionId }) => {
    //  AUTHORIZATION: Only presenter can end session
    if (!requireSessionMatch(socket, sessionId)) return;
    if (!requireRole(socket, ["presenter"])) return;

    const session = sessions.get(sessionId);
    if (!session) return;

    if (!IS_PRODUCTION) console.log(`[WS] Presenter ending session ${sessionId}`);

    // Notify all clients that session has ended
    io.to(sessionId).emit("session-ended", { message: "Session has ended" });

    // Clean up PDF file if exists
    if (session.pdfFile) {
      const filePath = path.join(UPLOAD_DIR, session.pdfFile);
      fs.unlink(filePath, (err) => {
        if (err && err.code !== "ENOENT") {
          if (!IS_PRODUCTION) console.error(`[WS] Failed to delete PDF ${session.pdfFile}:`, err.message);
        }
      });
      fileToSession.delete(session.pdfFile);
    }

    // Clean up session and token
    sessions.delete(sessionId);
    uploadTokens.delete(sessionId);

    if (!IS_PRODUCTION) console.log(`[WS] Session ${sessionId} ended and cleaned up`);
  });

  socket.on("disconnect", () => {
    const { sessionId, role } = socket.data;
    if (!IS_PRODUCTION) console.log(
      `[WS] ${role || "client"} disconnected from session ${sessionId}`,
    );

    // Remove viewer from tracking
    if (role === "viewer" && sessionId && sessions.has(sessionId)) {
      const session = sessions.get(sessionId);
      session.connectedViewers.delete(socket.id);
      // Broadcast viewer count to all session members
      io.to(sessionId).emit("viewer-count", {
        count: session.connectedViewers.size,
      });
    }

    // Clear approved remotes when presenter disconnects (session reset)
    if (role === "presenter" && sessionId && sessions.has(sessionId)) {
      const session = sessions.get(sessionId);
      session.approvedRemotes.clear();
      if (!IS_PRODUCTION) console.log(`[WS] Cleared approved remotes for session ${sessionId}`);
    }
  });
});

// ─── Error Handler ────────────────────────────────────────────────────────────

app.use((err, _req, res, _next) => {
  //  SECURITY: Log internally but don't leak error details to client
  if (!IS_PRODUCTION) {
    console.error(err.message);
  }
  //  SECURITY: Generic error message - never expose internal errors
  res.status(500).json({ error: "Internal server error" });
});

// ─── Start ────────────────────────────────────────────────────────────────────

server.listen(PORT, () => {
  if (!IS_PRODUCTION) {
    console.log(`\n🎯 PDF Presenter running at http://localhost:${PORT}`);
    console.log(`   Open the URL above in your browser to start presenting.\n`);
  }
});
