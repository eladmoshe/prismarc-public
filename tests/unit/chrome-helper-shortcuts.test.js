import test from 'node:test';
import assert from 'node:assert/strict';
import { openKeyboardShortcuts } from '../../chromeHelper.js';

test('opening keyboard shortcuts coalesces rapid clicks and reuses an existing tab in the source window', async t => {
    const original = globalThis.chrome;
    t.after(() => { globalThis.chrome = original; });
    const url = 'chrome://extensions/shortcuts';
    const tabs = [];
    const activated = [];
    globalThis.chrome = {
        tabs: {
            query: async query => {
                assert.deepEqual(query, { windowId: 3 });
                return tabs;
            },
            create: async properties => {
                assert.deepEqual(properties, { windowId: 3, url, active: true });
                const tab = { id: 7, pendingUrl: url };
                tabs.push(tab);
                return tab;
            },
            update: async (id, properties) => {
                assert.deepEqual(properties, { active: true });
                activated.push(id);
                return tabs[0];
            },
        },
        windows: { getCurrent: async () => ({ id: 3 }) },
    };
    assert.deepEqual(await Promise.all([openKeyboardShortcuts(3), openKeyboardShortcuts(3)]), [tabs[0], tabs[0]]);
    assert.equal(tabs.length, 1);
    assert.deepEqual(activated, []);
    await openKeyboardShortcuts();
    assert.deepEqual(activated, [7]);
});
