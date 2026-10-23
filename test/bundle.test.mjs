import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Script, createContext } from 'node:vm';
import path from 'node:path';
import { renderClient } from '../scripts/build.mjs';

const bundle = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8');
const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));

function load() {
  let registration;
  const styles = [];
  const calls = { resources: [], tabs: [], slots: [], injections: [] };
  const window = { __ModuleLoader__: { load(value) { assert.equal(registration, undefined); registration = value; } } };
  const document = {
    head: { appendChild(style) { styles.push(style); } },
    createElement(type) {
      assert.equal(type, 'style');
      return { dataset: {}, textContent: '', remove() { const at = styles.indexOf(this); if (at >= 0) styles.splice(at, 1); } };
    },
  };
  new Script(bundle).runInContext(createContext({ window, document, console, fetch() { assert.fail('no raw fetch'); } }));
  assert.equal(calls.resources.length, 0, 'loading must not register anything before apply');
  const React = {
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat(Infinity) }),
    useState: initial => [typeof initial === 'function' ? initial() : initial, () => {}],
  };
  const exported = registration.factory(id => {
    if (id === 'react') return React;
    assert.equal(id, '@deepseek-ai/dsh-client-ui-primitives'); return { MenuItemButton: 'NativeMenuItemButton' };
  });
  const ctx = {
    sessions: { list: { getSnapshot: () => ({ byId: {} }) }, fork: () => assert.fail('client must not fork a Session'), create: () => assert.fail('client must not create a Session'), rename: () => assert.fail('client must not rename a Session'), retain: () => ({ release() {} }) },
    connection: { rpc: { call: async () => assert.fail('module registration and icon rendering must not call host RPC') } },
    resources: { register: provider => { calls.resources.push(provider); return () => {}; } },
    sidebarRightTabs: { register: definition => { calls.tabs.push(definition); return () => {}; } },
    sidebarRight: { openResource() {}, registerCloseHandler() { return () => {}; } },
    slots: {
      inject(name, callback) { calls.injections.push(name); return callback(); },
      register(definition) {
        if (['sidebar.right.tab.menu.item', 'conversation.session.header.utilities'].includes(definition.name)) {
          assert.equal(typeof definition.id, 'string', 'native list slots require options.id, not options.key');
        }
        calls.slots.push(definition); return () => {};
      },
    },
    effect: fn => fn(),
    get: () => undefined,
  };
  return { registration, exported, ctx, calls, styles, document };
}

test('committed client bundle exactly matches the current source without writing outputs', async () => {
  assert.equal(bundle, await renderClient(), 'run node scripts/build.mjs after editing client source');
});

test('release has one explicit runtime allowlist with complete exports and host imports', async () => {
  assert.deepEqual(manifest.files, ['cordis.patch.yml', 'README.md', 'LICENSE', 'src/host/index.js', 'src/host/service.js', 'src/host/delete.js', 'lib/client.js']);
  const names = new Set(['package.json', ...manifest.files]);
  assert.equal(names.size, 8);
  for (const entry of [manifest.main, ...Object.values(manifest.exports), manifest.dsh.bundle.patch]) {
    assert.ok(names.has(entry.replace(/^\.\//, '')), 'runtime entry must be packaged: ' + entry);
  }
  for (const name of manifest.files.filter(name => name.startsWith('src/host/'))) {
    const source = await readFile(new URL('../' + name, import.meta.url), 'utf8');
    for (const [, specifier] of source.matchAll(/\bfrom\s+['"](\.[^'"]+)['"]/g)) {
      assert.ok(names.has(path.posix.normalize(path.posix.join(path.posix.dirname(name), specifier))), 'host import must be packaged: ' + specifier);
    }
  }
  const pack = await readFile(new URL('../scripts/pack.mjs', import.meta.url), 'utf8');
  assert.match(pack, /const names = \['package\.json', \.\.\.manifest\.files\]/, 'custom pack and npm must use the same manifest allowlist');
  assert.match(pack, /await renderClient\(\)/, 'pack must reject a stale client bundle');
  assert.equal(manifest.scripts.prepack, 'node scripts/build.mjs --check');
});

test('bundle registers a lazy module for this package and shares the shell React', () => {
  const { registration, exported, styles } = load();
  assert.equal(registration.id, manifest.name);
  assert.equal(manifest.name, 'dsh-plugin-side-chat-native');
  assert.deepEqual([...exported.inject], ['slots', 'sidebarRightTabs', 'sidebarRight', 'sessions', 'resources', 'connection', 'uiWorkspace']);
  assert.ok(manifest.dsh.client.inject.includes('@deepseek-ai/dsh-client-ui-conversation'));
  assert.ok(manifest.dsh.client.inject.includes('@deepseek-ai/dsh-client-ui-workspace'));
  assert.equal(styles.length, 0, 'materializing must not inject CSS');
});

test('apply wires the native tab, body slot and header entry', () => {
  const { exported, ctx, calls, styles } = load();
  exported.apply(ctx);
  assert.equal(styles.length, 1);
  assert.ok(styles[0].textContent.includes('.dsh-side-chat-native'));
  assert.equal(calls.resources.length, 1);
  assert.equal(calls.tabs.length, 1);
  assert.equal(calls.tabs[0].kind, 'sidechat');
  const names = calls.slots.map(definition => definition.name);
  assert.ok(names.includes('sidebar.right.pane.tab'));
  assert.ok(names.includes('dsh-plugin-side-chat-native.body'));
  assert.ok(names.includes('conversation.session.header.utilities'));
  assert.ok(names.includes('sidebar.right.tab.menu.item'));
});

test('rebuilt bundle contributes the chat artwork to the native guide without card layout overrides', () => {
  const { exported, ctx, calls, styles } = load();
  exported.apply(ctx);
  const entry = calls.tabs[0].guide[0];
  assert.equal(typeof entry.icon, 'function');
  const svg = entry.icon({ size: 26 });
  assert.equal(svg.type, 'svg'); assert.equal(svg.props.width, 26); assert.equal(svg.props.height, 26);
  assert.equal(svg.props.viewBox, '0 0 36 36'); assert.equal(svg.props.stroke, '#539CFA');
  assert.equal(svg.children.filter(child => child.type === 'path').length, 3);
  assert.doesNotMatch(styles[0].textContent, /data-sidebar-right-guide-entry|entryIcon|placeholderInk/);
});

test('the native composer consumes empty space only inside this side-chat scrollport', () => {
  const { exported, ctx, styles } = load();
  exported.apply(ctx);
  const css = styles[0].textContent;
  // A blank native Chat returns no viewArea. Sticky bottom:0 cannot consume
  // that empty flex space; the native seat needs an auto margin, not a replica.
  assert.match(css, /\.dsh-side-chat-native\s+\[data-conversation-scroll\]\s*>\s*\[data-composer-seat\]\s*\{[^}]*margin-top\s*:\s*auto(?:\s*;|\s*\})/);
  assert.doesNotMatch(css, /position\s*:\s*(?:fixed|absolute)\b/, 'do not detach the composer from native scrolling');
});

test('a rejected native seam only disables the UI instead of blocking app boot', () => {
  const { exported, ctx } = load();
  ctx.sidebarRightTabs.register = () => { throw new Error('native seam changed'); };
  const errors = [];
  const original = console.error;
  console.error = (...args) => errors.push(args);
  try {
    assert.doesNotThrow(() => exported.apply(ctx));
  } finally {
    console.error = original;
  }
  assert.equal(errors.length, 1);
  assert.match(String(errors[0][0]), /原生侧聊注册失败/);
});
