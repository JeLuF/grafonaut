// Hosts one OGraf graphic (a Web Component module) inside a sandboxed iframe of the renderer page.
// The renderer page calls into it with postMessage: load (imports the module and calls load()), then the graphic's
// playAction/stopAction/updateAction/customAction/dispose methods.
(() => {
  let element = null;
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
    return callGraphic('load', params);
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
