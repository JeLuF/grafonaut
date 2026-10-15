import { Worker } from 'node:worker_threads';

// Property and payload schemas come from uploaded manifests. Their regular expressions (`pattern`) and structure are
// chosen by the uploader, and a pattern such as (a+)+$ can block a thread for seconds or longer. That work runs in a
// worker thread, one task at a time, with a time limit: a task that runs too long terminates the worker (a new one
// starts for the next task) and fails with SchemaTimeoutError, so the app's event loop is never blocked.
export class SchemaTimeoutError extends Error {
  constructor() { super('Checking against the graphic\'s schema took too long'); }
}

export function createSchemaRunner({ timeoutMs = 1000 } = {}) {
  let worker = null;
  let queue = Promise.resolve();
  let nextId = 0;

  function spawn() {
    const current = new Worker(new URL('./untrusted-schema-worker.js', import.meta.url), { resourceLimits: { maxOldGenerationSizeMb: 128 } });
    const state = { worker: current, pending: null };
    state.ready = new Promise((resolve, reject) => {
      current.on('message', (message) => {
        if (message.ready) return resolve();
        if (state.pending?.id === message.id) state.pending.settle(message);
      });
      current.on('error', (error) => { reject(error); state.pending?.settle({ error: error.message }); });
      current.on('exit', () => {
        if (worker === state) worker = null;
        reject(new Error('Schema worker stopped'));
        state.pending?.settle({ error: 'Schema worker stopped' });
      });
    });
    current.unref();
    return state;
  }

  async function execute(task, args) {
    worker ??= spawn();
    const state = worker;
    state.worker.ref();
    try {
      await state.ready;
      return await new Promise((resolve, reject) => {
        const id = ++nextId;
        const timer = setTimeout(() => {
          state.pending = null;
          if (worker === state) worker = null;
          void state.worker.terminate();
          reject(new SchemaTimeoutError());
        }, timeoutMs);
        state.pending = { id, settle: ({ result, error }) => {
          clearTimeout(timer);
          state.pending = null;
          if (error !== undefined) reject(new Error(error)); else resolve(result);
        } };
        state.worker.postMessage({ id, task, args });
      });
    } finally { state.worker.unref(); }
  }

  return {
    run(task, ...args) {
      const job = queue.then(() => execute(task, args));
      queue = job.catch(() => {});
      return job;
    },
    close: () => worker?.worker.terminate()
  };
}

export const untrustedSchemas = createSchemaRunner();
