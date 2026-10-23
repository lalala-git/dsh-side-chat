import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, h, settle } from './support.mjs';
import { createSideChatService } from '../src/host/service.js';
import { createSideChatClient, installNativeSideChat, chatAddress } from '../src/client/native.js';

test('browser refresh may recover only a live side-chat capability owned by the same source', async t => {
  const f = fixture(t), service = createSideChatService(f.ctx), opened = await service.open({ sourceSessionId: 'main', requestId: 'recover-request-0001' });
  assert.equal(service.recover({ sessionId: opened.sessionId, sourceSessionId: 'main' }).token, opened.token);
  assert.throws(() => service.recover({ sessionId: opened.sessionId, sourceSessionId: 'other' }), e => e.code === 'sidechat/not-owned');
  assert.throws(() => service.recover({ sessionId: 'main', sourceSessionId: 'main' }), e => e.code === 'sidechat/not-owned');
  await service.close({ sessionId: opened.sessionId, token: opened.token });
  assert.throws(() => service.recover({ sessionId: opened.sessionId, sourceSessionId: 'main' }), e => e.code === 'sidechat/not-owned');
});

test('host creates own handles WITHOUT reading or patching the GLOBAL Agent factory', async t => {
  const f = fixture(t);
  Object.defineProperty(f.services.agents, 'requireFactory', { get() { assert.fail('global factory access forbidden'); } });
  const service = createSideChatService(f.ctx);
  const opened = await service.open({ sourceSessionId: 'main', requestId: 'no-patch-request-001' });
  await service.close({ sessionId: opened.sessionId, token: opened.token });
  assert.equal(f.calls.disposed.length, 1); assert.equal(f.agents.get('main'), f.main);
});

test('ownership is NOT inferred from a persisted id after a host restart', async t => {
  const f = fixture(t), before = createSideChatService(f.ctx);
  const opened = await before.open({ sourceSessionId: 'main', requestId: 'restart-request-001' });
  await before.dispose(); const after = createSideChatService(f.ctx);
  assert.throws(() => after.recover({ sessionId: opened.sessionId, sourceSessionId: 'main' }), e => e.code === 'sidechat/not-owned');
  await assert.rejects(after.close({ sessionId: opened.sessionId, token: opened.token }), e => e.code === 'sidechat/not-owned');
});

function uiFixture(client) {
  const slots = new Map(), effects = []; let handler;
  const ctx = { effect: fn => fn(), resources: { register: () => () => {} }, sessions: {}, sidebarRightTabs: { register: () => () => {} },
    sidebarRight: { registerCloseHandler: (_kind, fn) => { handler = fn; return () => {}; }, tabsIn: () => [] },
    slots: { inject: (_name, fn) => fn(), register: (spec, Comp) => { slots.set(spec.name, Comp); return () => {}; } } };
  installNativeSideChat(ctx, { React: { createElement: h, useState: initial => [initial, () => {}], useEffect: fn => effects.push(fn) }, client });
  return { ctx, slots, effects, close: (...args) => handler(...args) };
}

test('explicit X retains the native tab until async owned cleanup confirms success', async () => {
  let finish, closes = 0;
  const client = createSideChatClient({ rpc: { call: async (_channel, method) => {
    if (method.endsWith('open')) return { ok: true, value: { sessionId: 'side-1', token: 'x'.repeat(43) } };
    return new Promise(resolve => { finish = () => resolve({ ok: true, value: { removed: true } }); });
  } } }, () => 'close-request-0000001');
  await client.open('page', 'main'); const f = uiFixture(client);
  const tab = { id: 'tab-1', contentId: chatAddress('side-1'), actions: { close() { f.close('main', tab); closes++; } } };
  f.slots.get('sidebar.right.pane.tab')({ sessionId: 'main', useTabInfo: () => ({ tab, panel: {} }), useResource: () => ({ value: { reference: {} } }), SessionProvider: 'Provider', renderSlot: () => 'body' });
  for (const fn of f.effects) fn();
  assert.throws(() => f.close('main', tab), /安全清理/); assert.equal(closes, 0); assert.equal(client.state('side-1'), 'closing');
  finish(); await settle(); assert.equal(closes, 1); assert.equal(client.state('side-1'), 'closed');
});

test('closing one of two duplicated views never deletes their shared Session', () => {
  let cleanup = 0;
  const f = uiFixture({ has: () => true, state: () => 'open', close: () => { cleanup++; return Promise.resolve(); } });
  const tab = { id: 'one', contentId: chatAddress('side-1') };
  f.ctx.sidebarRight.tabsIn = () => [tab, { ...tab, id: 'two' }];
  assert.doesNotThrow(() => f.close('main', tab)); assert.equal(cleanup, 0);
});

test('refresh recovery stores the capability privately and closes through the owned RPC', async () => {
  const calls = [], client = createSideChatClient({ rpc: { call: async (_channel, method, payload) => {
    calls.push({ method, payload });
    return { ok: true, value: method.endsWith('recover') ? { sessionId: 'side-1', token: 'x'.repeat(43) } : { removed: true } };
  } } });
  await client.recover('side-1', 'main'); assert.equal(client.has('side-1'), true);
  await client.close('side-1'); assert.equal(calls[0].method, 'sideChatNative.recover'); assert.equal(calls[1].payload.token.length, 43);
  assert.equal('token' in client, false);
});
