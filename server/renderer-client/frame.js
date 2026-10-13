// Hosts one OGraf graphic (a Web Component module) inside a sandboxed iframe of the renderer page.
// The renderer page calls into it with postMessage: load (imports the module and calls load()), then the graphic's
// playAction/stopAction/updateAction/customAction/dispose methods.
(() => {
  let element = null;
  const SETTLE_TIMEOUT = 5000;
  // Load events of nested frames do not bubble, but a capturing listener on the document sees them.
  const loadedFrames = new WeakSet();
  document.addEventListener('load', (event) => { if (event.target instanceof HTMLIFrameElement) loadedFrames.add(event.target); }, true);

  function frameLoaded(frame) {
    if (!frame.getAttribute('src') && !frame.hasAttribute('srcdoc')) return true;
    try {
      // Same-origin frames can be checked directly (the initial about:blank document does not count).
      const doc = frame.contentDocument;
      if (doc) return doc.readyState === 'complete' && doc.URL !== 'about:blank';
    } catch { /* cross-origin: rely on the load event */ }
    return loadedFrames.has(frame);
  }

  // Being forgiving: some graphics resolve load() before pages they create in nested frames (e.g. SPX-style HTML
  // templates that define play()/stop()) have loaded. Wait for those frames before reporting the graphic as loaded,
  // at most SETTLE_TIMEOUT, so an action sent right after load() finds them ready.
  async function settle() {
    const deadline = Date.now() + SETTLE_TIMEOUT;
    for (;;) {
      const pending = [...document.querySelectorAll('iframe')].filter((frame) => !frameLoaded(frame));
      const remaining = deadline - Date.now();
      if (!pending.length || remaining <= 0) return;
      await Promise.race([
        Promise.all(pending.map((frame) => new Promise((resolve) => frame.addEventListener('load', resolve, { once: true })))),
        new Promise((resolve) => setTimeout(resolve, Math.min(remaining, 250)))
      ]);
    }
  }
  const reply = (message) => parent.postMessage(message, '*');
  const plain = (value) => {
    try { return JSON.parse(JSON.stringify(value ?? { statusCode: 200 })); } catch { return { statusCode: 200 }; }
  };

  async function callGraphic(method, params) {
    if (!element) throw Object.assign(new Error('No graphic is loaded'), { graphic: false });
    if (typeof element[method] !== 'function') throw new Error(`The graphic does not support ${method}`);
    return element[method](params);
  }

  async function load({ module, params }) {
    const Graphic = (await import(module)).default;
    if (typeof Graphic !== 'function') throw new Error('The graphic module has no default export');
    const name = `ograf-graphic-${Math.random().toString(36).slice(2)}`;
    customElements.define(name, class extends Graphic {});
    element = document.createElement(name);
    document.body.appendChild(element);
    const result = await callGraphic('load', params);
    await settle();
    return result;
  }

  window.addEventListener('message', async (event) => {
    const message = event.data;
    if (event.source !== parent || !message || message.ograf !== 'call') return;
    try {
      let result;
      if (message.method === 'load') result = await load(message.params);
      else if (message.method === 'dispose') result = element ? await callGraphic('dispose', message.params) : undefined;
      else result = await callGraphic(message.method, message.params);
      reply({ ograf: 'result', callId: message.callId, result: plain(result) });
    } catch (error) {
      reply({ ograf: 'error', callId: message.callId, message: String(error?.message ?? error), graphic: error?.graphic !== false });
    }
  });
  reply({ ograf: 'ready' });
})();
