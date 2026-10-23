import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fixture } from './support.mjs';
import { createSideChatService } from '../src/host/service.js';

test('a junction inside the Session root fails preflight before stopping/deleting', async t => {
  const f = fixture(t), service = createSideChatService(f.ctx);
  const view = await service.open({ sourceSessionId: 'main', requestId: 'junction-open-000001' });
  const link = path.join(f.root, 'linked-bucket'), target = path.join(f.dir, 'link-target');
  fs.mkdirSync(target); fs.symlinkSync(target, link, 'junction');
  await assert.rejects(service.close({ sessionId: view.sessionId, token: view.token }), e => e.code === 'sidechat/unsafe-path');
  assert.equal(f.calls.disposed.length, 0); assert.equal(fs.existsSync(f.log(view.sessionId)), true);
  assert.equal(fs.existsSync(target), true); await service.dispose();
});

test('closing a running SIDE Session cannot stop the running MAIN Session', async t => {
  const f = fixture(t), service = createSideChatService(f.ctx);
  f.main.status = 'running';
  const view = await service.open({ sourceSessionId: 'main', requestId: 'running-side-000001' });
  f.agents.get(view.sessionId).status = 'running';
  await service.close({ sessionId: view.sessionId, token: view.token });
  assert.equal(f.main.status, 'running'); assert.equal(f.agents.get('main'), f.main);
  assert.deepEqual(f.calls.archived, [view.sessionId]); assert.deepEqual(f.calls.disposed, [view.sessionId]);
});
