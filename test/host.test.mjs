import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createSideChatService, referenceContext } from '../src/host/service.js';
import { registerRoutes } from '../src/host/index.js';
import { createSideChatClient } from '../src/client/native.js';
import { fixture } from './support.mjs';
const args = (id = 'open-request-00000001') => ({ sourceSessionId: 'main', requestId: id });

test('opening creates an owned EMPTY native Agent with frozen quoted context, not a fork or archived Agent', async t => {
  const f = fixture(t), service = createSideChatService(f.ctx), view = await service.open(args());
  assert.match(view.sessionId, /^sidechat-/); assert.equal(view.token.length, 43);
  assert.equal(f.calls.created.length, 1); const options = f.calls.created[0];
  assert.equal('seed' in options, false); assert.equal('parentSession' in options.meta, false);
  assert.equal(options.meta.cwd, f.main.session.header.cwd, 'inherit the actual source cwd regardless of the clone directory name');
  assert.equal(f.calls.archived.length, 0, 'archiving an OPEN chat rejects every native model step');
  assert.equal(f.calls.released, 1); assert.deepEqual(f.calls.mounted, ['standard']);
  assert.ok(f.calls.sections[0].text.includes('parent-answer'));
  assert.ok(!f.calls.sections[0].text.includes('private-reasoning'));
  assert.ok(!f.calls.sections[0].text.includes('DO-NOT-COPY'));
  assert.deepEqual(view.context, { messageCount: 2, truncated: false });
  assert.deepEqual(options.agentOptions, { provider: 'fixture', model: 'alpha', reasoningEffort: 'high' });
  assert.equal(f.agents.get('main'), f.main);
  f.events[0].data.content[0].text = 'later main edit';
  assert.ok(!f.calls.sections[0].text.includes('later main edit'));
  await service.dispose();
});

test('duplicate opening is idempotent and a changed source cannot reuse its request', async t => {
  const f = fixture(t), service = createSideChatService(f.ctx);
  const [a, b] = await Promise.all([service.open(args()), service.open(args())]);
  assert.deepEqual(a, b); assert.equal(f.calls.created.length, 1);
  await assert.rejects(service.open({ ...args(), sourceSessionId: 'other' }), e => e.code === 'sidechat/request-conflict');
  await service.dispose();
});

test('the request cannot claim a main Session, inject a path, or choose a Session id for deletion', async t => {
  const f = fixture(t), service = createSideChatService(f.ctx);
  await assert.rejects(service.open({ ...args(), sessionId: 'main' }), /字段/);
  await assert.rejects(service.close({ sessionId: 'main', token: 'x'.repeat(43) }), e => e.code === 'sidechat/not-owned');
  assert.equal(f.calls.disposed.length, 0); assert.equal(f.agents.get('main'), f.main);
});

test('source observation is released even when its workspace is invalid', async t => {
  const f = fixture(t); f.services.sessionQuery.observeSession = async () => ({ header: { id: 'main', cwd: '' }, [Symbol.dispose]() { f.calls.released = 1; } });
  await assert.rejects(createSideChatService(f.ctx).open(args()), e => e.code === 'sidechat/source-unavailable');
  assert.equal(f.calls.released, 1); assert.equal(f.calls.created.length, 0);
});

test('explicit close removes only the minted side Session and its exact log directory, idempotently', async t => {
  const f = fixture(t), service = createSideChatService(f.ctx), view = await service.open(args());
  const mainPath = path.join(f.root, '2026-10-23', 'main'); fs.mkdirSync(mainPath); fs.writeFileSync(path.join(mainPath, 'sentinel'), 'keep');
  const result = await service.close(viewToAuth(view));
  assert.equal(result.removed, true); assert.equal(fs.existsSync(f.log(view.sessionId)), false);
  assert.equal(fs.readFileSync(path.join(mainPath, 'sentinel'), 'utf8'), 'keep');
  assert.deepEqual(f.calls.archived, [view.sessionId]); assert.deepEqual(f.calls.deleted, [view.sessionId]);
  await service.close(viewToAuth(view)); assert.equal(f.calls.disposed.length, 1);
  assert.equal(f.agents.get('main'), f.main);
});

function viewToAuth(view) { return { sessionId: view.sessionId, token: view.token }; }

test('wrong capability cannot stop or delete even an owned side Session', async t => {
  const f = fixture(t), service = createSideChatService(f.ctx), view = await service.open(args());
  await assert.rejects(service.close({ sessionId: view.sessionId, token: 'x'.repeat(43) }), e => e.code === 'sidechat/not-owned');
  assert.equal(f.calls.disposed.length, 0); assert.equal(fs.existsSync(f.log(view.sessionId)), true); await service.dispose();
});

test('missing projection cleanup fails BEFORE stopping or removing files', async t => {
  const f = fixture(t), service = createSideChatService(f.ctx), view = await service.open(args());
  f.services.storageDomain = undefined;
  await assert.rejects(service.close(viewToAuth(view)), e => e.code === 'sidechat/index-unavailable');
  assert.equal(f.calls.disposed.length, 0); assert.equal(fs.existsSync(f.log(view.sessionId)), true); await service.dispose();
});

test('changed persistence root fails closed', async t => {
  const f = fixture(t), service = createSideChatService(f.ctx), view = await service.open(args());
  f.services.sessionPersistence.root = f.dir;
  await assert.rejects(service.close(viewToAuth(view)), e => e.code === 'sidechat/storage-unavailable');
  assert.equal(f.calls.disposed.length, 0); assert.equal(fs.existsSync(f.log(view.sessionId)), true); await service.dispose();
});

test('ambiguous directories cannot be bulk-deleted', async t => {
  const f = fixture(t), service = createSideChatService(f.ctx), view = await service.open(args());
  fs.mkdirSync(path.join(f.root, 'other', view.sessionId), { recursive: true });
  await assert.rejects(service.close(viewToAuth(view)), e => e.code === 'sidechat/ambiguous');
  assert.equal(f.calls.disposed.length, 0); assert.ok(fs.existsSync(f.log(view.sessionId))); await service.dispose();
});

test('remaining background activity preserves side-chat files', async t => {
  const f = fixture(t), service = createSideChatService(f.ctx), view = await service.open(args());
  f.ctx.waterfall = async () => [{ kind: 'job' }];
  await assert.rejects(service.close(viewToAuth(view)), e => e.code === 'sidechat/busy');
  assert.ok(fs.existsSync(f.log(view.sessionId))); assert.equal(f.calls.deleted.length, 0); assert.ok(f.agents.has('main'));
});

test('unload releases only owned handles and NEVER erases transcripts', async t => {
  const f = fixture(t), service = createSideChatService(f.ctx), view = await service.open(args());
  await service.dispose(); assert.ok(fs.existsSync(f.log(view.sessionId))); assert.equal(f.calls.deleted.length, 0); assert.ok(f.agents.has('main'));
});

test('reference context bounds text and excludes internal controls/attachments', () => {
  const events = [{ type: 'user/message', surfaceOp: 'append', data: { source: { kind: 'user' }, content: [{ type: 'text', text: '0123456789' }] } }];
  assert.deepEqual(referenceContext(events, 5), { messages: [{ role: 'user', text: '56789' }], truncated: true });
});

test('actual client → native envelope routes → host open/close; legacy arbitrary registration disabled', async t => {
  const f = fixture(t), service = createSideChatService(f.ctx), routes = new Map();
  registerRoutes({ connection: { fetch: { register: route => routes.set(route.path, route) } } }, service);
  let seq = 0;
  async function rpc(_channel, method, payload) {
    const response = await routes.get('/api/' + method).fetch(new Request('http://fixture/api/' + method, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'client-request', rpcId: String(++seq), method, payload }),
    }));
    assert.equal(response.headers.get('cache-control'), 'no-store');
    return (await response.json()).result;
  }
  const client = createSideChatClient({ rpc: { call: rpc } }, () => 'client-open-0000000001');
  const view = await client.open('tab', 'main'); assert.ok(!JSON.stringify(view).includes('token'));
  await client.close(view.sessionId); assert.equal(client.state(view.sessionId), 'closed'); assert.ok(f.agents.has('main'));
  const legacy = await rpc('/api', 'sideChatNative.register', { sessionId: 'main' });
  assert.equal(legacy.ok, false); assert.equal(legacy.error.code, 'sidechat/legacy-disabled');
});
