# ⬡ PDF Presenter

> Open-source PDF slide presenter with **real-time remote control** from any device.

![License: MIT](https://img.shields.io/badge/license-MIT-amber.svg)
![Node.js](https://img.shields.io/badge/node-%3E%3D16-green.svg)

---

## ✨ Features

| Feature | Details |
|---|---|
| 📄 PDF Rendering | Full-quality rendering via PDF.js |
| 📱 Remote Control | Control slides from a phone/tablet via QR code |
| 🔄 Real-time Sync | WebSocket sync — all viewers stay in step |
| ⌨️ Keyboard Nav | Arrow keys, Space, Page Up/Down |
| 👆 Touch & Swipe | Works on tablets and touch screens |
| 🌙 Dark / Light Mode | Toggle with one click |
| 🗂️ Multi-PDF | Upload multiple PDFs and switch between them |
| ⛶ Fullscreen | Distraction-free presentation mode |
| 🎞️ Transitions | Smooth flash transition between slides |
| 🖼️ Thumbnail Strip | Scrub through slides quickly |

---

## 🚀 Quick Start

### Prerequisites

- **Node.js 16+** — [Download here](https://nodejs.org)
- Works on **Linux**, **macOS**, and **Windows**

### 1. Clone or Download

```bash
git clone https://github.com/your-username/pdf-presenter
cd pdf-presenter
```

### 2. Install Dependencies

```bash
npm install
```

### 3. Start the Server

```bash
npm start
```

Server starts at **http://localhost:3000**

For development (auto-restart on changes):

```bash
npm run dev
```

---

## 📱 Using the Remote Control

1. Open `http://localhost:3000` in your **browser** (the presenter view)
2. Upload a PDF using the drag-and-drop zone
3. Click **📱 Remote** in the top bar
4. **Scan the QR code** with your phone, OR copy the link and open it on another device
5. Use the Prev / Next buttons on your phone to control slides in real-time

> **On your local network:** Share `http://YOUR_LOCAL_IP:3000/remote.html?session=XXXX` with others on the same Wi-Fi to let them control or follow along.

---

## 🗂️ Project Structure

```
pdf-presenter/
├── server.js           # Express + Socket.io server
├── package.json        # Dependencies
├── uploads/            # Auto-created; stores uploaded PDFs
└── public/
    ├── index.html      # Presenter view
    ├── remote.html     # Remote control (phone/tablet)
    ├── css/
    │   └── style.css   # All styles (dark/light themes)
    └── js/
        ├── presenter.js  # PDF rendering, navigation, upload logic
        └── remote.js     # Remote control WebSocket client
```

---

## ⚙️ Configuration

| Environment Variable | Default | Description |
|---|---|---|
| `PORT` | `3000` | HTTP server port |

```bash
PORT=8080 npm start
```

---

## 🌐 Network / Deployment

### Local Network (same Wi-Fi)

Find your machine's local IP:
- **Linux/macOS:** `ip addr` or `ifconfig`
- **Windows:** `ipconfig`

Then share: `http://192.168.x.x:3000`

### Deploying to the Cloud

The app runs on any Node.js host (Railway, Render, Fly.io, Heroku, VPS):

```bash
# Example with Railway
npm install -g railway
railway login && railway up
```

Make sure the host supports **WebSockets** (most modern PaaS do).

### Reverse Proxy (nginx)

```nginx
location / {
    proxy_pass http://localhost:3000;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
}
```

---

## ⌨️ Keyboard Shortcuts

| Key | Action |
|---|---|
| `→` / `↓` / `Space` / `Page Down` | Next slide |
| `←` / `↑` / `Page Up` | Previous slide |
| `F` | Toggle fullscreen |
| `Esc` | Close modal / exit fullscreen |

---

## 🛠️ Tech Stack

| Layer | Technology |
|---|---|
| Frontend | Vanilla HTML + CSS + JavaScript |
| PDF Rendering | [PDF.js](https://mozilla.github.io/pdf.js/) 3.x |
| Backend | [Express](https://expressjs.com/) 4.x |
| WebSockets | [Socket.io](https://socket.io/) 4.x |
| File Upload | [Multer](https://github.com/expressjs/multer) |
| QR Code | [qrcode](https://github.com/soldair/node-qrcode) (server) + [QRious](https://github.com/neocotic/qrious) (fallback) |

---

## 📄 License

MIT © 2024 — Free to use, modify, and distribute.
