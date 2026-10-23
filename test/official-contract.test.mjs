import test from 'node:test';
import assert from 'node:assert/strict';
import { readAsarText } from '../scripts/asar-reference.mjs';
import { installNativeSideChat, SIDE_CHAT_BODY_SLOT } from '../src/client/native.js';
import { createSideChatService } from '../src/host/service.js';
import { fixture, h } from './support.mjs';
const archive = process.env.DSH_REFERENCE_ASAR;
const reference = name => readAsarText(archive, 'dsh/node_modules/@deepseek-ai/' + name);
function extract(source, name) {
  const start = source.indexOf('function ' + name + '(');
  assert.ok(start >= 0, 'Native reference must still export this function body: ' + name);
  const first = source.indexOf('{', source.indexOf(')', start));
  let depth = 1, cursor = first + 1;
  for (; cursor < source.length && depth; cursor++) { if (source[cursor] === '{') depth++; if (source[cursor] === '}') depth--; }
  return source.slice(start, cursor);
}
function panel() {
  const registered = new Map();
  installNativeSideChat({ effect: fn => fn(), resources: { register: () => () => {} }, sessions: {},
    sidebarRightTabs: { register: () => () => {} }, sidebarRight: { registerCloseHandler: () => () => {} },
    slots: { inject: (_name, fn) => fn(), register: (decl, component) => { registered.set(decl.name, component); return () => {}; } },
  }, { React: { createElement: h }, client: {} });
  return registered.get(SIDE_CHAT_BODY_SLOT);
}

test('SHIPPED ui-subagent contract: our native view selection calls the exact same Chat slot', { skip: !archive }, async () => {
  const official = await reference('dsh-client-ui-subagent/lib/client.js');
  const officialFixed = new Function('react_jsx_runtime', extract(official, 'FixedChatConversationView') + ';return FixedChatConversationView;')({ jsx: (_type, props) => props.children, Fragment: 'Fragment' });
  const officialPanel = new Function('FixedChatConversationView', extract(official, 'ConversationSlotPanel') + ';return ConversationSlotPanel;')(officialFixed);
  const ownPanel = panel();
  for (const Comp of [officialPanel, ownPanel]) {
    let captured;
    Comp({ sessionId: 'side', useSession: fn => fn({ blank: false, awaitingFirstTurn: false, openState: 'open', running: true }),
      useConversation: fn => fn({ activeTargets: new Set() }), useSessions: fn => fn({ byId: { side: { blank: false } } }),
      renderFactorySlot: (...args) => { captured = args; },
    });
    assert.equal(captured[0], 'conversation.content'); assert.deepEqual(captured[1], { variant: 'embedded', phase: 'active', hero: false });
    assert.equal(typeof captured[2].slots.views, 'function', 'Missing this native override produced empty transcripts/composer-at-top');
    const rows = []; captured[2].slots.views({ renderSlot: (name, props) => rows.push({ name, props }) });
    assert.deepEqual(rows, [{ name: 'conversation.session', props: { view: 'chat' } }]);
  }
});

test('SHIPPED archived-session gate: opening stays runnable; archive would reject every model step', { skip: !archive }, async t => {
  const source = await reference('dsh-api-session-controller/lib/types/archived-session-gate.js');
  const gate = new Function(extract(source, 'underArchivedSession') + ';return underArchivedSession;')();
  const f = fixture(t), service = createSideChatService(f.ctx), opened = await service.open({ sourceSessionId: 'main', requestId: 'official-open-000001' });
  const gateCtx = { workspaceRegistry: f.reg, sessions: f.services.sessions }, agent = f.agents.get(opened.sessionId);
  assert.equal(gate(gateCtx, agent), false);
  f.reg.archivedSessionIds.push(opened.sessionId);
  assert.equal(gate(gateCtx, agent), true, 'stopActivity=false does NOT make an archived Session runnable');
  await service.dispose();
});

test('SHIPPED ConversationContent requires the local views override and embeds the native composer', { skip: !archive }, async () => {
  const source = await reference('dsh-client-ui-conversation/lib/client.js');
  assert.match(source, /useFactorySlot\("views", ConversationSessionView\)/);
  assert.match(source, /slots:\s*\{\s*views:\s*\{ scope: "session" \}/);
  assert.match(source, /sessionId === void 0 \|\| hero && chipTitle === void 0/);
});

test('SHIPPED tab close hook is synchronous, bound occurrence close has zero arguments', { skip: !archive }, async () => {
  const source = await reference('dsh-client-ui-sidebar-right/lib/client.js');
  assert.match(source, /removeAfterCleanup\(sessionId, tab, commit\)\s*\{\s*this\.closeHandlers\.get\(tab\.kind\)\?\.\(sessionId, tab\);\s*commit\(\);/);
  assert.match(source, /close: \(\) =>\s*\{\s*navigator\.closeIn\(sessionId, tabId\);/);
});
