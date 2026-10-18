/**
 * Runs inside each plugin's worker before the plugin's own code. It defines the global
 * `devplus` API and the message protocol with the host. Kept as a string because the
 * worker is created from a Blob (no bundler involvement, no access to app modules).
 */
export const PRELUDE = String.raw`
'use strict';
(() => {
  const pending = new Map();
  let seq = 0;
  const commands = new Map();
  const formatters = new Map();
  const exporters = new Map();

  const call = (method, args) =>
    new Promise((resolve, reject) => {
      const id = ++seq;
      pending.set(id, { resolve, reject });
      postMessage({ type: 'call', id, method, args });
    });

  const need = (obj, fields, what) => {
    if (!obj || typeof obj !== 'object') throw new Error(what + ' needs an object argument');
    for (const [name, type] of fields) {
      if (typeof obj[name] !== type) throw new Error(what + ': "' + name + '" must be a ' + type);
    }
  };

  self.devplus = Object.freeze({
    registerCommand(c) {
      need(c, [['id', 'string'], ['title', 'string'], ['run', 'function']], 'registerCommand');
      commands.set(c.id, c);
      postMessage({ type: 'register', kind: 'command', id: c.id, title: c.title });
    },
    registerCellFormatter(f) {
      need(f, [['id', 'string'], ['title', 'string'], ['match', 'function'], ['format', 'function']], 'registerCellFormatter');
      formatters.set(f.id, f);
      postMessage({ type: 'register', kind: 'formatter', id: f.id, title: f.title });
    },
    registerExporter(x) {
      need(x, [['id', 'string'], ['title', 'string'], ['extension', 'string'], ['export', 'function']], 'registerExporter');
      exporters.set(x.id, x);
      postMessage({ type: 'register', kind: 'exporter', id: x.id, title: x.title, extension: x.extension });
    },
    runQuery: (sql) => call('runQuery', [String(sql)]),
    insertText: (text) => call('insertText', [String(text)]),
    notify: (message) => call('notify', [String(message)]),
    getContext: () => call('getContext', [])
  });

  self.onmessage = async (event) => {
    const m = event.data;
    if (m.type === 'reply') {
      const p = pending.get(m.id);
      if (!p) return;
      pending.delete(m.id);
      if (m.error) p.reject(new Error(m.error));
      else p.resolve(m.value);
      return;
    }
    if (m.type !== 'invoke') return;
    try {
      let value = null;
      if (m.kind === 'command') {
        const c = commands.get(m.id);
        if (!c) throw new Error('Unknown command ' + m.id);
        await c.run();
      } else if (m.kind === 'match') {
        value = {};
        for (const [id, f] of formatters) {
          value[id] = m.columns.flatMap((col, i) => {
            try { return f.match(col) ? [i] : []; } catch (e) { return []; }
          });
        }
      } else if (m.kind === 'format') {
        const f = formatters.get(m.id);
        value = m.values.map((v) => {
          const r = f.format(v);
          return r === undefined ? v : r === null ? null : String(r);
        });
      } else if (m.kind === 'export') {
        const x = exporters.get(m.id);
        value = String(await x.export(m.columns, m.rows));
      }
      postMessage({ type: 'result', id: m.callId, value });
    } catch (err) {
      postMessage({ type: 'result', id: m.callId, error: String((err && err.message) || err) });
    }
  };
})();
`

/** Wrap plugin code so top-level failures are reported instead of silently killing the worker. */
export function workerSource(pluginCode: string): string {
  return `${PRELUDE}\ntry {\n${pluginCode}\n;postMessage({ type: 'ready' });\n} catch (err) {\n  postMessage({ type: 'error', message: String((err && err.stack) || err) });\n}\n`
}
