/**
 * camswap.js — injected into the WKWebView at document-start, in the
 * main JS world, BEFORE the target site's own scripts run.
 *
 * What it does:
 *   1. Connects to the signaling server as the "receiver" and pulls
 *      in the WebRTC video track being published by the desktop
 *      sender (sender.html, which is fed by "OBS Virtual Camera").
 *   2. Renders that incoming video into a hidden <canvas> at a fixed
 *      frame rate.
 *   3. Overrides navigator.mediaDevices.getUserMedia (and
 *      enumerateDevices) so that when the site loaded in this
 *      WKWebView asks for the camera, it transparently receives
 *      canvas.captureStream() instead of the phone's real camera.
 *      The real microphone is still used for audio, so the
 *      streamer's live voice goes through normally.
 *
 * Configuration is provided by the native app via a small script
 * injected immediately before this one:
 *
 *   window.__CAMSWAP_CONFIG__ = {
 *     serverUrl: "wss://your-server.example.com",
 *     room: "stream-1234",
 *     videoWidth: 1280,
 *     videoHeight: 720,
 *     fps: 30,
 *     showStatusBadge: true
 *   };
 *
 * If no config is present, this script does nothing (site behaves
 * like a stock browser with the real camera).
 */
(function () {
  const cfg = window.__CAMSWAP_CONFIG__;
  if (!cfg || !cfg.serverUrl || !cfg.room) {
    console.warn('[camswap] no config found, real camera will be used');
    return;
  }

  const WIDTH = cfg.videoWidth || 1280;
  const HEIGHT = cfg.videoHeight || 720;
  const FPS = cfg.fps || 30;

  const nativeGetUserMedia = navigator.mediaDevices.getUserMedia
    ? navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices)
    : null;
  const nativeEnumerateDevices = navigator.mediaDevices.enumerateDevices
    ? navigator.mediaDevices.enumerateDevices.bind(navigator.mediaDevices)
    : null;

  // ---- hidden video + canvas plumbing ----------------------------------
  const hiddenVideo = document.createElement('video');
  hiddenVideo.setAttribute('playsinline', '');
  hiddenVideo.muted = true;
  hiddenVideo.autoplay = true;
  hiddenVideo.style.cssText = 'position:fixed;width:1px;height:1px;opacity:0;pointer-events:none;top:-9999px;left:-9999px;';

  const canvas = document.createElement('canvas');
  canvas.width = WIDTH;
  canvas.height = HEIGHT;
  const ctx = canvas.getContext('2d', { alpha: false });
  // Fallback fill so the substituted stream is never a fully blank
  // frame before the WebRTC connection is up.
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, WIDTH, HEIGHT);

  let canvasStream = null;
  function getCanvasStream() {
    if (!canvasStream) {
      canvasStream = canvas.captureStream(FPS);
    }
    return canvasStream;
  }

  let drawing = false;
  function startDrawLoop() {
    if (drawing) return;
    drawing = true;
    const draw = () => {
      if (!drawing) return;
      if (hiddenVideo.readyState >= 2) {
        // letterbox/cover the incoming frame into the fixed canvas size
        const vw = hiddenVideo.videoWidth || WIDTH;
        const vh = hiddenVideo.videoHeight || HEIGHT;
        const scale = Math.max(WIDTH / vw, HEIGHT / vh);
        const dw = vw * scale, dh = vh * scale;
        const dx = (WIDTH - dw) / 2, dy = (HEIGHT - dh) / 2;
        ctx.drawImage(hiddenVideo, dx, dy, dw, dh);
      }
      requestAnimationFrame(draw);
    };
    requestAnimationFrame(draw);
  }

  document.documentElement.appendChild(hiddenVideo);

  // ---- status badge (optional, for setup/debugging) ---------------------
  let badge = null;
  function setStatus(text, color) {
    if (!cfg.showStatusBadge) return;
    if (!badge) {
      badge = document.createElement('div');
      badge.style.cssText = 'position:fixed;bottom:8px;left:8px;z-index:2147483647;font:12px -apple-system,sans-serif;padding:4px 8px;border-radius:6px;background:rgba(0,0,0,0.6);color:#fff;pointer-events:none;';
      const attach = () => document.documentElement.appendChild(badge);
      if (document.body) attach(); else document.addEventListener('DOMContentLoaded', attach);
    }
    badge.textContent = 'camswap: ' + text;
    badge.style.color = color || '#fff';
  }

  // ---- signaling / WebRTC receiver --------------------------------------
  let ws = null;
  let pc = null;
  let reconnectTimer = null;

  function iceServers() {
    return [{ urls: 'stun:stun.l.google.com:19302' }];
  }

  function connectSignaling() {
    setStatus('соединение...', '#ffcc66');

    try {
      ws = new WebSocket(cfg.serverUrl);
    } catch (e) {
      // Most common cause: the page is https:// but serverUrl is ws://
      // (not wss://) — browsers throw a SecurityError synchronously for
      // that "mixed content" combination instead of failing later.
      setStatus('ошибка: небезопасное соединение — используйте wss:// вместо ws:// (' + e.message + ')', '#ff6b6b');
      scheduleReconnect();
      return;
    }

    ws.onopen = () => {
      ws.send(JSON.stringify({ type: 'join', room: cfg.room, role: 'receiver' }));
    };

    ws.onclose = scheduleReconnect;
    ws.onerror = scheduleReconnect;

    ws.onmessage = async (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch (e) { return; }

      if (msg.type === 'joined') {
        setStatus('в комнате, жду сигнал от OBS...', '#ffcc66');
        return;
      }

      if (msg.type === 'error') {
        setStatus('ошибка сервера: ' + msg.message, '#ff6b6b');
        return;
      }

      if (msg.type === 'peer-left') {
        setStatus('источник отключился', '#ffcc66');
        if (pc) { pc.close(); pc = null; }
        return;
      }

      if (msg.type === 'offer') {
        pc = new RTCPeerConnection({ iceServers: iceServers() });

        pc.ontrack = (ev2) => {
          hiddenVideo.srcObject = ev2.streams[0];
          hiddenVideo.play().catch(() => {});
          startDrawLoop();
          setStatus('видео получено', '#7CFC7C');
        };

        pc.onicecandidate = (ev2) => {
          if (ev2.candidate) {
            ws.send(JSON.stringify({ type: 'ice-candidate', candidate: ev2.candidate }));
          }
        };

        pc.onconnectionstatechange = () => {
          if (pc.connectionState === 'failed' || pc.connectionState === 'disconnected') {
            setStatus('соединение прервано (' + pc.connectionState + ')', '#ff6b6b');
          }
        };

        await pc.setRemoteDescription(new RTCSessionDescription(msg.sdp));
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        ws.send(JSON.stringify({ type: 'answer', sdp: answer }));
        return;
      }

      if (msg.type === 'ice-candidate' && pc && msg.candidate) {
        try { await pc.addIceCandidate(msg.candidate); } catch (e) { /* ignore */ }
        return;
      }
    };
  }

  function scheduleReconnect() {
    if (reconnectTimer) return;
    setStatus('переподключение...', '#ffcc66');
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connectSignaling();
    }, 2000);
  }

  // ---- getUserMedia / enumerateDevices override --------------------------
  // IMPORTANT: this override is installed BEFORE connectSignaling() runs
  // below. If the signaling connection throws (e.g. mixed-content
  // SecurityError from ws:// on an https:// page) or fails for any other
  // reason, the site still gets the substituted camera (showing a black
  // frame until a stream arrives) instead of silently falling back to the
  // phone's real camera because an unrelated error aborted the script.
  const fakeVideoDevice = {
    deviceId: 'camswap-virtual-camera',
    groupId: 'camswap-virtual-camera-group',
    kind: 'videoinput',
    label: 'Camera',
    toJSON() { return this; }
  };

  navigator.mediaDevices.getUserMedia = async function (constraints) {
    const wantsVideo = !!(constraints && constraints.video);
    const wantsAudio = !!(constraints && constraints.audio);

    if (!wantsVideo) {
      // Pure audio (or empty) request: pass straight through to the
      // real device, nothing to substitute.
      if (!nativeGetUserMedia) throw new DOMException('getUserMedia unavailable', 'NotSupportedError');
      return nativeGetUserMedia(constraints);
    }

    const tracks = [getCanvasStream().getVideoTracks()[0]];

    if (wantsAudio) {
      try {
        if (!nativeGetUserMedia) throw new Error('no native getUserMedia');
        const audioOnly = await nativeGetUserMedia({ audio: constraints.audio });
        const at = audioOnly.getAudioTracks()[0];
        if (at) tracks.push(at);
      } catch (e) {
        console.warn('[camswap] could not acquire real microphone:', e);
      }
    }

    return new MediaStream(tracks);
  };

  if (nativeEnumerateDevices) {
    navigator.mediaDevices.enumerateDevices = async function () {
      const real = await nativeEnumerateDevices();
      // Keep real audio inputs (so mic selection still works), but
      // replace video inputs with the single fake "Camera" entry so
      // device pickers on the site don't expose/select the real lens.
      const audioOnly = real.filter(d => d.kind !== 'videoinput');
      return [fakeVideoDevice, ...audioOnly];
    };
  }

  console.info('[camswap] camera substitution active, room=' + cfg.room);

  connectSignaling();
})();
