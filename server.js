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
const QRCode = require("qrcode");
const { v4: uuidv4 } = require("uuid");

// ─── App Setup ───────────────────────────────────────────────────────────────

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*" },
  maxHttpBufferSize: 50 * 1024 * 1024, // 50 MB for PDF uploads via socket
});

const PORT = process.env.PORT || 3000;
const UPLOAD_DIR = path.join(__dirname, "uploads");

// Ensure uploads directory exists
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// ─── File Upload (Multer) ─────────────────────────────────────────────────────

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOAD_DIR),
  destination: (_req, _file, cb) => cb(null, UPLOAD_DIR),
  filename: (_req, file, cb) => {
    // Sanitize filename and prefix with timestamp to avoid collisions
    const safe = file.originalname.replace(/[^a-zA-Z0-9._-]/g, "_");
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
 * sessions: Map<sessionId, { currentSlide, totalSlides, pdfFile, connectedClients }>
 * A "session" ties together a presenter and all remote viewers.
 */
const sessions = new Map();

function getOrCreateSession(sessionId) {
  if (!sessions.has(sessionId)) {
    sessions.set(sessionId, {
      currentSlide: 1,
      totalSlides: 0,
      pdfFile: null,
      presenterSocket: null,
    });
  }
  return sessions.get(sessionId);
}

// ─── Static Files ─────────────────────────────────────────────────────────────

app.use(express.static(path.join(__dirname, "public")));
app.use(express.json());

// Serve uploaded PDFs (by session, so clients can load the same file)
app.use("/uploads", express.static(UPLOAD_DIR));

// ─── REST Endpoints ───────────────────────────────────────────────────────────

/**
 * POST /api/session
 * Creates a new presentation session. Returns sessionId + QR code URL.
 */
app.post("/api/session", async (req, res) => {
  const sessionId = uuidv4().slice(0, 8).toUpperCase();
  getOrCreateSession(sessionId);

  // Build the remote-control URL
  const host = req.headers.host;
  const protocol = req.headers["x-forwarded-proto"] || "http";
  const remoteUrl = `${protocol}://${host}/remote.html?session=${sessionId}`;

  // Generate QR code as data URL
  let qrDataUrl = null;
  try {
    qrDataUrl = await QRCode.toDataURL(remoteUrl, {
      width: 256,
      margin: 2,
      color: { dark: "#1a1a2e", light: "#ffffff" },
    });
  } catch (e) {
    console.error("QR generation failed:", e.message);
  }

  res.json({ sessionId, remoteUrl, qrDataUrl });
});

/**
 * POST /api/upload/:sessionId
 * Upload a PDF file and associate it with a session.
 */
app.post("/api/upload/:sessionId", upload.single("pdf"), (req, res) => {
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
 */
app.get("/api/session/:sessionId", (req, res) => {
  const { sessionId } = req.params;
  const session = sessions.get(sessionId);
  if (!session) return res.status(404).json({ error: "Session not found" });

  res.json({
    currentSlide: session.currentSlide,
    totalSlides: session.totalSlides,
    pdfFile: session.pdfFile ? `/uploads/${session.pdfFile}` : null,
  });
});

/**
 * GET /api/pdfs
 * Lists all uploaded PDFs available on the server.
 */
app.get("/api/pdfs", (_req, res) => {
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

// ─── WebSocket (Socket.io) ────────────────────────────────────────────────────

io.on("connection", (socket) => {
  console.log(`[WS] Client connected: ${socket.id}`);

  /**
   * join-session: Called by both presenter and remote clients.
   * role: "presenter" | "remote"
   */
  socket.on("join-session", ({ sessionId, role }) => {
    if (!sessionId) return;

    socket.join(sessionId);
    socket.data.sessionId = sessionId;
    socket.data.role = role;

    const session = getOrCreateSession(sessionId);

    if (role === "presenter") {
      session.presenterSocket = socket.id;
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
   */
  socket.on("slide-change", ({ sessionId, direction, slide }) => {
    const session = sessions.get(sessionId);
    if (!session) return;

    if (typeof slide === "number") {
      session.currentSlide = Math.max(
        1,
        Math.min(slide, session.totalSlides || slide),
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
   */
  socket.on("set-total-slides", ({ sessionId, totalSlides }) => {
    const session = sessions.get(sessionId);
    if (!session) return;
    session.totalSlides = totalSlides;
    io.to(sessionId).emit("total-slides-update", { totalSlides });
  });

  /**
   * pointer-event: Presenter broadcasts laser pointer position to all remotes.
   */
  socket.on("pointer-event", ({ sessionId, x, y, active }) => {
    socket.to(sessionId).emit("pointer-update", { x, y, active });
  });

  /**
   * cursor-move: Remote broadcasts cursor position to presenter.
   */
  socket.on("cursor-move", ({ sessionId, x, y, active }) => {
    socket.to(sessionId).emit("cursor-move", { x, y, active });
  });

  socket.on("disconnect", () => {
    const { sessionId, role } = socket.data;
    console.log(
      `[WS] ${role || "client"} disconnected from session ${sessionId}`,
    );
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
