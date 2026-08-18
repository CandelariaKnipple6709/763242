const $ = (id) => document.getElementById(id);
const statusEl = $('status');
const canvas = $('outputCanvas');
const ctx = canvas.getContext('2d', { alpha: false });
const WIDTH = canvas.width, HEIGHT = canvas.height;
const stageWrap = $('stageWrap');
const dropHint = $('dropHint');
const sceneListEl = $('sceneList');
const qrImg = $('qrImg');
const roomCodeText = $('roomCodeText');
const overrideServerInput = $('overrideServer');

// ---- pairing state (server URL / room come from the embedded server) ----
let pairing = { serverUrl: null, room: null };
let serverOverride = null; // if set, used instead of pairing.serverUrl

function effectiveServerUrl() {
  return serverOverride || pairing.serverUrl;
}

window.camswap.onPairingInfo((info) => {
  pairing = { serverUrl: info.serverUrl, room: info.room };
  qrImg.src = info.qrDataUrl;
  roomCodeText.textContent = info.room + '  (' + info.serverUrl + ')';
  // (Re)connect using the new room/server.
  connect();
});

$('regenBtn').onclick = async () => {
  disconnect();
  const info = await window.camswap.regenerateRoom();
  pairing = { serverUrl: info.serverUrl, room: info.room };
  qrImg.src = info.qrDataUrl;
  roomCodeText.textContent = info.room + '  (' + info.serverUrl + ')';
  connect();
};

$('applyOverride').onclick = () => {
  const v = overrideServerInput.value.trim();
  serverOverride = v || null;
  disconnect();
  connect();
};

// ---- scene model ---------------------------------------------------------
let scenes = [];
let liveSceneId = null;
let selectedSceneId = null;
let nextId = 1;

function fitScaleFor(img) {
  return Math.min(WIDTH / img.width, HEIGHT / img.height);
}

function addScene(img, name) {
  const scene = {
    id: nextId++,
    name,
    img,
    fitScale: fitScaleFor(img),
    scale: 1,
    rotationDeg: 0,
    flipH: false,
    flipV: false,
    offsetX: 0,
    offsetY: 0
  };
  scenes.push(scene);
  selectedSceneId = scene.id;
  if (liveSceneId === null) liveSceneId = scene.id;
  renderSceneList();
  syncToolbarFromSelected();
}

function getScene(id) { return scenes.find(s => s.id === id); }

function removeScene(id) {
  scenes = scenes.filter(s => s.id !== id);
  if (liveSceneId === id) liveSceneId = scenes.length ? scenes[0].id : null;
  if (selectedSceneId === id) selectedSceneId = liveSceneId;
  renderSceneList();
  syncToolbarFromSelected();
}

function setLive(id) {
  liveSceneId = id;
  selectedSceneId = id;
  renderSceneList();
  syncToolbarFromSelected();
}

// ---- rendering loop -------------------------------------------------------
function drawScene(scene) {
  ctx.save();
  ctx.translate(WIDTH / 2 + scene.offsetX, HEIGHT / 2 + scene.offsetY);
  ctx.rotate(scene.rotationDeg * Math.PI / 180);
  const sx = (scene.flipH ? -1 : 1) * scene.fitScale * scene.scale;
  const sy = (scene.flipV ? -1 : 1) * scene.fitScale * scene.scale;
  ctx.scale(sx, sy);
  ctx.drawImage(scene.img, -scene.img.width / 2, -scene.img.height / 2);
  ctx.restore();
}

function renderLoop() {
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, WIDTH, HEIGHT);
  const live = getScene(liveSceneId);
  if (live) drawScene(live);
  dropHint.style.display = scenes.length ? 'none' : 'flex';
  requestAnimationFrame(renderLoop);
}
requestAnimationFrame(renderLoop);

// ---- scene list UI ----------------------------------------------------
function renderSceneList() {
  sceneListEl.innerHTML = '';
  scenes.forEach(scene => {
    const div = document.createElement('div');
    div.className = 'scene-thumb' +
      (scene.id === liveSceneId ? ' live' : '') +
      (scene.id === selectedSceneId ? ' selected' : '');

    const imgEl = document.createElement('img');
    imgEl.src = scene.img.src;
    div.appendChild(imgEl);

    if (scene.id === liveSceneId) {
      const badge = document.createElement('div');
      badge.className = 'badge';
      badge.textContent = 'В ЭФИРЕ';
      div.appendChild(badge);
    }

    const rm = document.createElement('button');
    rm.className = 'remove';
    rm.textContent = '×';
    rm.onclick = (e) => { e.stopPropagation(); removeScene(scene.id); };
    div.appendChild(rm);

    const name = document.createElement('div');
    name.className = 'name';
    name.textContent = scene.name;
    div.appendChild(name);

    div.onclick = () => setLive(scene.id);

    sceneListEl.appendChild(div);
  });
}

// ---- adding images (file picker + drag&drop) ---------------------------
function loadImageFile(file) {
  const reader = new FileReader();
  reader.onload = () => {
    const img = new Image();
    img.onload = () => addScene(img, file.name);
    img.src = reader.result;
  };
  reader.readAsDataURL(file);
}

$('addSceneBtn').onclick = () => $('fileInput').click();
$('fileInput').onchange = (e) => {
  Array.from(e.target.files || []).forEach(loadImageFile);
  e.target.value = '';
};

['dragenter', 'dragover'].forEach(evt =>
  window.addEventListener(evt, (e) => { e.preventDefault(); })
);
window.addEventListener('drop', (e) => {
  e.preventDefault();
  const files = Array.from(e.dataTransfer.files || []).filter(f => f.type.startsWith('image/'));
  files.forEach(loadImageFile);
});

// ---- transform toolbar --------------------------------------------------
function withSelected(fn) {
  const s = getScene(selectedSceneId);
  if (!s) return;
  fn(s);
  syncToolbarFromSelected();
}

function syncToolbarFromSelected() {
  const s = getScene(selectedSceneId);
  $('rotSlider').value = s ? s.rotationDeg : 0;
  $('scaleSlider').value = s ? Math.round(s.scale * 100) : 100;
  renderSceneList();
}

function normalizeDeg(d) {
  d = d % 360;
  if (d > 180) d -= 360;
  if (d < -180) d += 360;
  return d;
}
$('rotL').onclick = () => withSelected(s => s.rotationDeg = normalizeDeg(s.rotationDeg - 90));
$('rotR').onclick = () => withSelected(s => s.rotationDeg = normalizeDeg(s.rotationDeg + 90));
$('flipH').onclick = () => withSelected(s => s.flipH = !s.flipH);
$('flipV').onclick = () => withSelected(s => s.flipV = !s.flipV);
$('resetTransform').onclick = () => withSelected(s => {
  s.scale = 1; s.rotationDeg = 0; s.flipH = false; s.flipV = false; s.offsetX = 0; s.offsetY = 0;
});
$('rotSlider').oninput = (e) => withSelected(s => s.rotationDeg = Number(e.target.value));
$('scaleSlider').oninput = (e) => withSelected(s => s.scale = Number(e.target.value) / 100);

let dragging = false, dragStartX = 0, dragStartY = 0, dragOrigOffsetX = 0, dragOrigOffsetY = 0;
stageWrap.addEventListener('mousedown', (e) => {
  const s = getScene(selectedSceneId);
  if (!s) return;
  dragging = true;
  stageWrap.classList.add('dragging');
  dragStartX = e.clientX; dragStartY = e.clientY;
  dragOrigOffsetX = s.offsetX; dragOrigOffsetY = s.offsetY;
});
window.addEventListener('mousemove', (e) => {
  if (!dragging) return;
  const s = getScene(selectedSceneId);
  if (!s) return;
  const rect = stageWrap.getBoundingClientRect();
  const scaleFactor = WIDTH / rect.width;
  s.offsetX = dragOrigOffsetX + (e.clientX - dragStartX) * scaleFactor;
  s.offsetY = dragOrigOffsetY + (e.clientY - dragStartY) * scaleFactor;
});
window.addEventListener('mouseup', () => { dragging = false; stageWrap.classList.remove('dragging'); });

stageWrap.addEventListener('wheel', (e) => {
  const s = getScene(selectedSceneId);
  if (!s) return;
  e.preventDefault();
  const delta = e.deltaY > 0 ? -0.05 : 0.05;
  s.scale = Math.max(0.1, Math.min(4, s.scale + delta));
  syncToolbarFromSelected();
}, { passive: false });

// ---- WebRTC sender --------------------------------------------------------
let ws = null;
let pc = null;
let outputStream = null;

function setStatus(text, kind) {
  statusEl.textContent = text;
  statusEl.className = kind || '';
}

function iceServers() {
  return [{ urls: 'stun:stun.l.google.com:19302' }];
}

function getOutputStream() {
  if (!outputStream) outputStream = canvas.captureStream(30);
  return outputStream;
}

function connect() {
  const url = effectiveServerUrl();
  const room = pairing.room;
  if (!url || !room) { setStatus('нет данных для подключения', 'err'); return; }

  disconnect(); // ensure a clean slate if called while already connected

  setStatus('соединяюсь...', 'warn');

  ws = new WebSocket(url);
  ws.onopen = () => ws.send(JSON.stringify({ type: 'join', room, role: 'sender' }));
  ws.onclose = () => setStatus('соединение с сервером закрыто', 'warn');
  ws.onerror = () => setStatus('ошибка WebSocket-соединения', 'err');

  ws.onmessage = async (ev) => {
    const msg = JSON.parse(ev.data);

    if (msg.type === 'error') { setStatus('сервер: ' + msg.message, 'err'); return; }

    if (msg.type === 'joined') {
      setStatus('в комнате «' + room + '». Ждём телефон...', 'warn');
      return;
    }

    if (msg.type === 'peer-joined') {
      setStatus('телефон подключился, устанавливаю канал...', 'warn');
      await startPeerConnection();
      return;
    }

    if (msg.type === 'peer-left') {
      setStatus('телефон отключился. Ждём переподключения...', 'warn');
      if (pc) { pc.close(); pc = null; }
      return;
    }

    if (msg.type === 'answer' && pc) {
      await pc.setRemoteDescription(new RTCSessionDescription(msg.sdp));
      setStatus('трансляция активна', 'ok');
      return;
    }

    if (msg.type === 'ice-candidate' && pc && msg.candidate) {
      try { await pc.addIceCandidate(msg.candidate); } catch (e) {}
      return;
    }
  };
}

async function startPeerConnection() {
  pc = new RTCPeerConnection({ iceServers: iceServers() });
  getOutputStream().getTracks().forEach(track => pc.addTrack(track, outputStream));

  pc.onicecandidate = (ev) => {
    if (ev.candidate) ws.send(JSON.stringify({ type: 'ice-candidate', candidate: ev.candidate }));
  };
  pc.onconnectionstatechange = () => {
    if (pc.connectionState === 'connected') setStatus('трансляция активна', 'ok');
    if (pc.connectionState === 'failed' || pc.connectionState === 'disconnected') {
      setStatus('соединение потеряно (' + pc.connectionState + ')', 'err');
    }
  };

  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  ws.send(JSON.stringify({ type: 'offer', sdp: offer }));
}

function disconnect() {
  if (pc) { pc.close(); pc = null; }
  if (ws) { ws.close(); ws = null; }
}

// Kick things off once the main process tells us the local server is up
// (see window.camswap.onPairingInfo above) — no button to press, the
// desktop side is ready and waiting as soon as the app opens.
