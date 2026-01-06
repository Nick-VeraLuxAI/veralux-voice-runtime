const logEl = document.getElementById('log');
const statusEl = document.getElementById('status');
const tenantEl = document.getElementById('tenant');
const startBtn = document.getElementById('start');
const stopBtn = document.getElementById('stop');
const remoteAudio = document.getElementById('remoteAudio');

let pc;
let localStream;

function logLine(message) {
  const line = `[${new Date().toISOString()}] ${message}`;
  logEl.textContent += `${line}\n`;
  logEl.scrollTop = logEl.scrollHeight;
}

function setStatus(text) {
  statusEl.textContent = text;
}

function getTenantId() {
  const params = new URLSearchParams(window.location.search);
  return tenantEl.value.trim() || params.get('tenant_id') || '';
}

async function waitForIceGathering(peer) {
  if (peer.iceGatheringState === 'complete') return;
  await new Promise((resolve) => {
    const handler = () => {
      if (peer.iceGatheringState === 'complete') {
        peer.onicegatheringstatechange = null;
        resolve();
      }
    };
    peer.onicegatheringstatechange = handler;
    setTimeout(() => {
      peer.onicegatheringstatechange = null;
      resolve();
    }, 2000);
  });
}

async function startCall() {
  const tenantId = getTenantId();
  if (!tenantId) {
    logLine('tenant_id required');
    return;
  }

  setStatus('starting');
  startBtn.disabled = true;
  stopBtn.disabled = false;

  pc = new RTCPeerConnection({
    iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
  });

  pc.onconnectionstatechange = () => {
    setStatus(pc.connectionState);
    logLine(`pc state: ${pc.connectionState}`);
  };

  pc.ontrack = (event) => {
    const stream = event.streams[0] || new MediaStream([event.track]);
    remoteAudio.srcObject = stream;
    remoteAudio.play().catch(() => undefined);
  };

  localStream = await navigator.mediaDevices.getUserMedia({ audio: true });
  for (const track of localStream.getTracks()) {
    pc.addTrack(track, localStream);
  }

  const offer = await pc.createOffer({
    offerToReceiveAudio: true,
  });
  await pc.setLocalDescription(offer);
  await waitForIceGathering(pc);

  const response = await fetch('/v1/webrtc/offer', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      offer: pc.localDescription,
      tenant_id: tenantId,
    }),
  });

  if (!response.ok) {
    const err = await response.json().catch(() => ({ error: 'unknown' }));
    logLine(`offer failed: ${err.error}`);
    setStatus('error');
    return;
  }

  const data = await response.json();
  await pc.setRemoteDescription(data.answer);
  setStatus('connected');
  logLine('webrtc connected');
}

async function stopCall() {
  stopBtn.disabled = true;
  startBtn.disabled = false;
  setStatus('stopping');

  if (localStream) {
    for (const track of localStream.getTracks()) {
      track.stop();
    }
    localStream = null;
  }
  if (pc) {
    pc.close();
    pc = null;
  }
  setStatus('idle');
  logLine('call stopped');
}

startBtn.addEventListener('click', () => {
  startCall().catch((error) => {
    logLine(`start failed: ${error.message || error}`);
    setStatus('error');
    startBtn.disabled = false;
    stopBtn.disabled = true;
  });
});

stopBtn.addEventListener('click', () => {
  stopCall().catch((error) => {
    logLine(`stop failed: ${error.message || error}`);
  });
});