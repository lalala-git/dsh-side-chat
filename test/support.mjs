import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
export const project = fileURLToPath(new URL('../', import.meta.url));
export const h = (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat(Infinity).filter(c => c !== null && c !== undefined && c !== false) });
export const plain = value => JSON.parse(JSON.stringify(value));
export const settle = () => new Promise(resolve => setImmediate(resolve));
export function fixture(t) {
  const base = path.join(project, '_scratch', 'tests'); fs.mkdirSync(base, { recursive: true });
  const dir = fs.mkdtempSync(path.join(base, 'owned-')), root = path.join(dir, 'sessions'); fs.mkdirSync(root);
  const agents = new Map(), sessions = new Map(), calls = { created: [], disposed: [], sections: [], contexts: [], mounted: [], archived: [], deleted: [], detached: [] };
  const main = { id: 'main', options: { provider: 'fixture', model: 'alpha' }, session: { header: { id: 'main', cwd: project }, requestHeader: () => ({ config: { provider: 'fixture', model: 'alpha', reasoningEffort: 'high' } }) } };
  agents.set('main', main); sessions.set('main', main.session);
  const events = [
    { type: 'user/message', surfaceOp: 'append', data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'parent-question' }, { type: 'image', secret: 'not-copied' }] } },
    { type: 'assistant/message', surfaceOp: 'append', data: { message: { source: { kind: 'model' }, content: [{ type: 'text', text: 'parent-answer' }, { type: 'reasoning', text: 'private-reasoning' }] } } },
    { type: 'goal/change', surfaceOp: 'append', data: { objective: 'DO-NOT-COPY-GOAL' } },
    { type: 'user/message', surfaceOp: 'append', data: { source: { kind: 'goal' }, content: [{ type: 'text', text: 'DO-NOT-COPY-QUEUE' }] } },
  ];
  const reg = { archivedSessionIds: [],
    async archiveSession(id) { calls.archived.push(id); this.archivedSessionIds.push(id); },
    async unarchiveSession(id) { this.archivedSessionIds = this.archivedSessionIds.filter(x => x !== id); },
    async unpinSession() {}, list: () => [{ async detachSession(id) { calls.detached.push(id); } }],
  };
  const services = {
    agents: { get: id => agents.get(id), async create(options) {
      calls.created.push(options);
      await options.setup({ systemPrompt: { section: value => calls.sections.push(value), context: value => calls.contexts.push(value) } });
      const session = { header: { id: options.sessionId, ...options.meta } };
      const agent = { id: options.sessionId, status: 'idle', session };
      agents.set(agent.id, agent); sessions.set(agent.id, session);
      const log = path.join(root, '2026-10-23', agent.id); fs.mkdirSync(log, { recursive: true }); fs.writeFileSync(path.join(log, 'log.jsonl'), '{"owned":true}');
      return { agent, async dispose() { calls.disposed.push(agent.id); agents.delete(agent.id); sessions.delete(agent.id); } };
    } },
    sessions: { get: id => sessions.get(id) },
    sessionQuery: { async observeSession() { return { header: { id: 'main', cwd: project, agentPreset: 'standard' }, events, [Symbol.dispose]() { calls.released = (calls.released ?? 0) + 1; } }; } },
    sessionTitle: { async rename(_session, title) { calls.title = title; } },
    agentPresets: { async resolve(id) { return { id: id ?? 'standard' }; }, async mount(_ctx, id) { calls.mounted.push(id); } },
    agentDefaultModel: { currentSelection: () => main.options },
    sessionPersistence: { root }, workspaceRegistry: reg,
    storageDomain: { get: name => name === 'session_projcache' ? { table: () => ({ async delete(id) { calls.deleted.push(id); } }) } : undefined },
  };
  const ctx = { get: name => services[name], async waterfall() { return []; } };
  t.after(() => {
    const absolute = fs.realpathSync(dir);
    if (!absolute.startsWith(fs.realpathSync(base) + path.sep) || path.basename(absolute) !== path.basename(dir)) throw new Error('Unsafe test cleanup');
    fs.rmSync(absolute, { recursive: true, force: true });
  });
  return { ctx, services, agents, sessions, calls, events, reg, dir, root, main,
    log: id => path.join(root, '2026-10-23', id) };
}
