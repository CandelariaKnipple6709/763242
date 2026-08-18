const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const QRCode = require('qrcode');
const { startSignalingServer } = require('./signaling');

const PORT = 8081;
let server = null;
let mainWindow = null;
let currentRoom = null;

function isLinkLocal(address) {
  // 169.254.0.0/16 — Windows self-assigns these (APIPA) to adapters that
  // aren't actually connected to anything (disabled NICs, unplugged
  // Ethernet, some virtual adapters). They're never reachable from a
  // phone, so must never be offered up for QR pairing.
  return address.startsWith('169.254.');
}

function candidateInterfaces() {
  const ifaces = os.networkInterfaces();
  const candidates = [];
  for (const name of Object.keys(ifaces)) {
    for (const iface of ifaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal && !isLinkLocal(iface.address)) {
        candidates.push({ name, address: iface.address });
      }
    }
  }
  return candidates;
}

function getLocalIPv4() {
  const candidates = candidateInterfaces();
  if (candidates.length === 0) {
    return '127.0.0.1'; // fallback — QR pairing won't work off-device, but
                         // the app still runs for local debugging.
  }

  // Prefer adapters that look like a real Wi-Fi/Ethernet connection over
  // VPN/virtual/container adapters, which commonly show up alongside the
  // real one and would otherwise win by being listed first.
  const preferredNamePattern = /wi-?fi|wlan|ethernet|en0|eth0/i;
  const preferred = candidates.find(c => preferredNamePattern.test(c.name));
  if (preferred) return preferred.address;

  // Otherwise avoid obviously-virtual adapters if any real-looking one
  // exists among the remaining candidates.
  const avoidPattern = /virtual|vmware|virtualbox|hyper-v|vethernet|tailscale|zerotier|loopback|docker|wsl/i;
  const nonVirtual = candidates.find(c => !avoidPattern.test(c.name));
  if (nonVirtual) return nonVirtual.address;

  return candidates[0].address;
}

function randomRoom() {
  return 'cam-' + crypto.randomBytes(4).toString('hex');
}

async function buildPairingPayload(room) {
  const ip = getLocalIPv4();
  const serverUrl = `ws://${ip}:${PORT}`;
  const payload = JSON.stringify({ v: 1, server: serverUrl, room });
  const qrDataUrl = await QRCode.toDataURL(payload, { margin: 1, scale: 6 });
  return { serverUrl, room, ip, port: PORT, qrDataUrl };
}

async function sendPairingInfo() {
  if (!mainWindow) return;
  const info = await buildPairingPayload(currentRoom);
  mainWindow.webContents.send('camswap-pairing', info);
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 960,
    minHeight: 640,
    backgroundColor: '#111111',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      // Needed for canvas.captureStream()/getUserMedia-free WebRTC sending
      // and for the local <-> phone media flow in general.
      backgroundThrottling: false
    }
  });

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  mainWindow.webContents.on('did-finish-load', () => {
    sendPairingInfo();
  });
}

app.whenReady().then(() => {
  currentRoom = randomRoom();
  server = startSignalingServer({ port: PORT, log: console.log });

  ipcMain.handle('camswap:get-pairing-info', async () => {
    return buildPairingPayload(currentRoom);
  });

  ipcMain.handle('camswap:regenerate-room', async () => {
    currentRoom = randomRoom();
    const info = await buildPairingPayload(currentRoom);
    return info;
  });

  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (server) server.close();
  if (process.platform !== 'darwin') app.quit();
});
