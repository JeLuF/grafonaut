// Grafanaut renderer page. Receives state and commands over the WebSocket and runs every graphic instance in its own
// sandboxed iframe; the frames are stacked in My Graphics order (first entry in front).
(() => {
  const config = JSON.parse(document.getElementById('renderer-config').textContent);
  const stage = document.getElementById('stage');
  const status = document.getElementById('status');
  const frames = new Map();
  let order = [];
  let socket = null;
  let attempts = 0;
  const CALL_TIMEOUT = 30000;

  const socketUrl = new URL(config.socketPath, location.href);
  socketUrl.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';

  function showStatus(text) {
    status.textContent = text;
    status.hidden = !text;
  }

  function connect() {
    socket = new WebSocket(socketUrl);
    socket.addEventListener('open', () => { attempts = 0; showStatus(''); });
    socket.addEventListener('message', (event) => {
      let message;
      try { message = JSON.parse(event.data); } catch { return; }
      if (message.type === 'state') applyState(message);
      else if (message.type === 'command') runCommand(message);
    });
    socket.addEventListener('close', (event) => {
      if (event.code === 4401) {
        frames.clear();
        stage.replaceChildren();
        showStatus('This renderer URL is no longer valid.');
        return;
      }
      // Keep showing the current graphics while reconnecting; the state message on reconnect resynchronises them.
      setTimeout(connect, Math.min(10000, 500 * 2 ** attempts++));
    });
  }

  function reply(id, result, error) {
    if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(error ? { type: 'reply', id, error } : { type: 'reply', id, result }));
  }

  function applyOrder() {
    for (const frame of frames.values()) {
      const index = order.indexOf(frame.entryId);
      frame.iframe.style.zIndex = String(index < 0 ? 0 : order.length - index);
    }
  }

  function createFrame(instanceId, entryId) {
    const iframe = document.createElement('iframe');
    iframe.setAttribute('sandbox', config.sandbox);
    iframe.setAttribute('allow', 'autoplay');
    iframe.setAttribute('referrerpolicy', 'strict-origin');
    iframe.title = `Graphic ${entryId}`;
    iframe.src = config.framePath;
    const frame = { iframe, instanceId, entryId, calls: new Map(), nextCall: 0 };
    frame.ready = new Promise((resolve) => { frame.markReady = resolve; });
    frames.set(instanceId, frame);
    stage.appendChild(iframe);
    applyOrder();
    return frame;
  }

  function call(frame, method, params) {
    return frame.ready.then(() => new Promise((resolve, reject) => {
      const callId = ++frame.nextCall;
      const timer = setTimeout(() => {
        frame.calls.delete(callId);
        reject(Object.assign(new Error(`The graphic did not finish ${method} in time`), { graphic: true }));
      }, CALL_TIMEOUT);
      frame.calls.set(callId, { resolve, reject, timer });
      // Opaque-origin frames (no graphics host) can only be addressed with '*'.
      frame.iframe.contentWindow.postMessage({ ograf: 'call', callId, method, params }, config.messageOrigin);
    }));
  }

  function removeFrame(frame) {
    if (frames.get(frame.instanceId) === frame) frames.delete(frame.instanceId);
    const remove = () => frame.iframe.remove();
    Promise.race([call(frame, 'dispose', {}), new Promise((resolve) => setTimeout(resolve, 1000))]).then(remove, remove);
  }

  window.addEventListener('message', (event) => {
    if (config.messageOrigin !== '*' && event.origin !== config.messageOrigin) return;
    const frame = [...frames.values()].find((candidate) => candidate.iframe.contentWindow === event.source);
    const message = event.data;
    if (!frame || !message || typeof message !== 'object') return;
    if (message.ograf === 'ready') { frame.markReady(); return; }
    const pending = frame.calls.get(message.callId);
    if (!pending) return;
    frame.calls.delete(message.callId);
    clearTimeout(pending.timer);
    if (message.ograf === 'result') pending.resolve(message.result);
    else pending.reject(Object.assign(new Error(message.message || 'The graphic reported an error'), { graphic: message.graphic !== false }));
  });

  function loadInstance({ instanceId, entryId, module, data }) {
    for (const frame of [...frames.values()]) if (frame.entryId === entryId && frame.instanceId !== instanceId) removeFrame(frame);
    const frame = frames.get(instanceId) ?? createFrame(instanceId, entryId);
    return call(frame, 'load', {
      module: new URL(module, config.assetOrigin).href,
      params: { data, renderType: 'realtime', renderCharacteristics: { resolution: { width: innerWidth, height: innerHeight } } }
    });
  }

  function applyState(state) {
    order = Array.isArray(state.order) ? state.order : [];
    const wanted = new Set(state.instances.map((instance) => instance.instanceId));
    for (const frame of [...frames.values()]) if (!wanted.has(frame.instanceId)) removeFrame(frame);
    for (const instance of state.instances) {
      if (frames.has(instance.instanceId)) continue;
      loadInstance(instance).then(() => instance.playing
        ? call(frames.get(instance.instanceId), 'playAction', { goto: instance.currentStep ?? 0, skipAnimation: true }) : undefined)
        .catch((error) => console.error('Could not restore graphic', instance.entryId, error));
    }
    applyOrder();
  }

  async function runCommand(message) {
    try {
      let result;
      if (message.action === 'load') result = await loadInstance(message);
      else {
        const frame = frames.get(message.instanceId);
        if (!frame) throw Object.assign(new Error('The graphic instance is not loaded on this renderer'), { graphic: false });
        result = await call(frame, message.action, message.params ?? {});
      }
      reply(message.id, result ?? { statusCode: 200 });
    } catch (error) {
      reply(message.id, undefined, { message: error.message || 'Renderer error', graphic: Boolean(error.graphic) });
    }
  }

  connect();
})();
