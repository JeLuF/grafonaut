import crypto from 'node:crypto';
import { WebSocketServer } from 'ws';

// One logical renderer per account. Every renderer page connected with the account's renderer token (OBS, test
// tabs, the My Graphics preview) is a live copy of it: commands go to all of them and the first reply wins.
// The on-air state lives in the store, so renderers that connect later (or after a restart) catch up.
export const RENDERER_ID = 'main';
export const socketPathPattern = /^\/render\/([^/?#]+)\/ws\/?(?:\?.*)?$/;

export class RendererError extends Error {
  // kind: 'no-renderer' | 'timeout' | 'graphic' (the graphic's method threw) | 'renderer'
  constructor(kind, message) {
    super(message);
    this.kind = kind;
  }
}

export function moduleUrl(versionId, mainFile) {
  return `/render/assets/${encodeURIComponent(versionId)}/${String(mainFile).split('/').map(encodeURIComponent).join('/')}`;
}

function normalizeResult(result) {
  const value = result && typeof result === 'object' ? result : {};
  const normalized = { statusCode: typeof value.statusCode === 'number' ? value.statusCode : 200 };
  if (typeof value.statusMessage === 'string') normalized.statusMessage = value.statusMessage;
  if (typeof value.currentStep === 'number') normalized.currentStep = value.currentStep;
  return normalized;
}

export function createRenderHub(store, { commandTimeout = 10000, heartbeatInterval = 30000 } = {}) {
  const sockets = new Map();
  const pending = new Map();
  const key = (accountId) => String(accountId);
  const send = (socket, message) => { if (socket.readyState === 1) socket.send(JSON.stringify(message)); };

  function connections(accountId) {
    return [...(sockets.get(key(accountId)) ?? [])].filter((socket) => socket.readyState === 1);
  }

  async function snapshot(accountId) {
    const [entries, instances] = await Promise.all([store.listRenderEntries(accountId), store.listRenderInstances(accountId)]);
    return { type: 'state', order: entries.map((entry) => entry.entryId), instances: instances.map((instance) => ({
      instanceId: instance.instanceId, entryId: instance.entryId, module: moduleUrl(instance.versionId, instance.mainFile),
      data: instance.data, currentStep: instance.currentStep, playing: instance.playing
    })) };
  }

  async function broadcastState(accountId) {
    const targets = connections(accountId);
    if (!targets.length) return;
    const state = await snapshot(accountId);
    for (const socket of targets) send(socket, state);
  }

  // Called after My Graphics changes: drops instances of entries that are gone or disabled and re-sends order and state.
  async function syncEntries(accountId) {
    const [entries, instances] = await Promise.all([store.listRenderEntries(accountId), store.listRenderInstances(accountId)]);
    const playable = new Set(entries.filter((entry) => entry.enabled && !entry.packageDisabled).map((entry) => entry.entryId));
    const stale = instances.filter((instance) => !playable.has(instance.entryId)).map((instance) => instance.entryId);
    if (stale.length) await store.deleteRenderInstances(accountId, stale);
    await broadcastState(accountId);
  }

  function settle(id, error, result) {
    const command = pending.get(id);
    if (!command) return;
    clearTimeout(command.timer);
    pending.delete(id);
    if (error) command.reject(error); else command.resolve(result);
  }

  function command(accountId, message) {
    const targets = connections(accountId);
    if (!targets.length) return Promise.reject(new RendererError('no-renderer', 'No renderer is connected.'));
    const id = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject, waiting: new Set(targets), failure: null,
        timer: setTimeout(() => settle(id, new RendererError('timeout', 'The renderer did not respond in time.')), commandTimeout) });
      for (const socket of targets) send(socket, { type: 'command', id, ...message });
    });
  }

  function handleReply(socket, message) {
    const command = pending.get(message.id);
    if (!command || !command.waiting.delete(socket)) return;
    if (!message.error) return settle(message.id, null, normalizeResult(message.result));
    command.failure ??= new RendererError(message.error.graphic ? 'graphic' : 'renderer', String(message.error.message || 'The renderer reported an error.'));
    if (!command.waiting.size) settle(message.id, command.failure);
  }

  function forget(socket) {
    for (const [id, command] of pending) {
      if (command.waiting.delete(socket) && !command.waiting.size) {
        settle(id, command.failure ?? new RendererError('no-renderer', 'The renderer disconnected.'));
      }
    }
  }

  function attach(socket, account) {
    const accountKey = key(account.id);
    if (!sockets.has(accountKey)) sockets.set(accountKey, new Set());
    sockets.get(accountKey).add(socket);
    socket.isAlive = true;
    socket.on('pong', () => { socket.isAlive = true; });
    socket.on('message', (raw) => {
      let message;
      try { message = JSON.parse(raw.toString()); } catch { return; }
      if (message?.type === 'reply' && typeof message.id === 'string') handleReply(socket, message);
    });
    socket.on('close', () => {
      sockets.get(accountKey)?.delete(socket);
      if (!sockets.get(accountKey)?.size) sockets.delete(accountKey);
      forget(socket);
    });
    snapshot(account.id).then((state) => send(socket, state)).catch(() => socket.close(1011, 'Renderer state unavailable'));
  }

  // Closes every renderer connection of the account, e.g. after its renderer token was replaced.
  function disconnect(accountId, code = 4401, reason = 'Renderer token replaced') {
    for (const socket of sockets.get(key(accountId)) ?? []) socket.close(code, reason);
  }

  // allowsUpgrade(request): whether this host may serve renderer WebSockets (see hosts.js).
  function attachServer(server, findAccountByToken, { allowsUpgrade = () => true } = {}) {
    const webSockets = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });
    server.on('upgrade', (request, socket, head) => {
      const match = socketPathPattern.exec(request.url ?? '');
      if (!match || !allowsUpgrade(request)) { socket.destroy(); return; }
      webSockets.handleUpgrade(request, socket, head, async (connection) => {
        let account = null;
        try { account = await findAccountByToken(decodeURIComponent(match[1]), 'renderer'); } catch { /* treated as unknown */ }
        if (!account) { connection.close(4401, 'Unknown renderer token'); return; }
        attach(connection, account);
      });
    });
    const heartbeat = setInterval(() => {
      for (const accountSockets of sockets.values()) {
        for (const socket of accountSockets) {
          if (!socket.isAlive) { socket.terminate(); continue; }
          socket.isAlive = false;
          socket.ping();
        }
      }
    }, heartbeatInterval);
    heartbeat.unref();
    server.on('close', () => { clearInterval(heartbeat); webSockets.close(); });
    return webSockets;
  }

  return { attach, attachServer, broadcastState, command, connections, disconnect, snapshot, syncEntries };
}
