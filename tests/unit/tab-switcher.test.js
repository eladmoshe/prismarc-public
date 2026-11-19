import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import { TabSwitcher, TAB_SWITCHER_LIMIT, TAB_SWITCHER_SESSION } from '../../tab-switcher.js';
import { describeOpenTab } from '../../tab-switcher-tabs.js';

function fixture() {
    const tab = (id, windowId, lastAccessed, incognito = false) => ({
        id, windowId, lastAccessed, incognito, url: 'https://duplicate.test/',
    });
    const normal = (id, tabs, incognito = false) => ({ id, type: 'normal', incognito, tabs });
    const windows = [
        normal(10, [tab(1, 10, 400), tab(4, 10, 100)]),
        normal(20, [tab(2, 20, 300), tab(3, 20, 200)]),
        normal(30, [tab(5, 30, 500, true)], true),
        { id: 40, type: 'popup', tabs: [tab(6, 40, 600)] },
    ];
    const sessions = {};
    const updates = [];
    const created = [];
    const focused = [];
    const lookup = id => windows.flatMap(window => window.tabs).find(tab => tab.id === id);
    const chrome = {
        runtime: { id: 'arcify', getURL: path => 'chrome-extension://arcify/' + path },
        storage: { session: {
            get: async key => ({ [key]: structuredClone(sessions[key]) }),
            set: async values => { Object.assign(sessions, structuredClone(values)); },
            remove: async key => { delete sessions[key]; },
        } },
        tabs: {
            create: async options => { created.push(options); },
            get: async id => lookup(id),
            update: async (id, props) => {
                assert.deepEqual(props, { active: true });
                const tab = lookup(id);
                assert.ok(tab);
                tab.lastAccessed = 1000;
                updates.push(id);
                return tab;
            },
        },
        windows: {
            get: async id => windows.find(window => window.id === id),
            getAll: async ({ windowTypes }) => windows.filter(window => windowTypes.includes(window.type)),
            create: async props => {
                const window = { ...props, id: 55, tabs: [{ id: 56, windowId: 55, url: props.url }] };
                windows.push(window);
                return window;
            },
            update: async (id, props) => {
                assert.deepEqual(props, { focused: true });
                focused.push(id);
            },
            remove: async id => {
                const index = windows.findIndex(window => window.id === id);
                assert.notEqual(index, -1);
                windows.splice(index, 1);
            },
        },
    };
    const picker = () => windows.find(window => window.id === 55);
    const state = () => sessions[TAB_SWITCHER_SESSION];
    const request = (controller, action, tabId) => controller.receive({ type: TAB_SWITCHER_SESSION, action, tabId }, {
        id: chrome.runtime.id, url: picker().url, tab: picker().tabs[0],
    });
    return { chrome, windows, lookup, updates, created, focused, picker, state, request };
}

test('one tab has no effect and two tabs open a picker on the first press', async () => {
    const f = fixture();
    f.windows[0].tabs.pop();
    f.windows[1].tabs.pop();
    const second = f.windows[1].tabs.pop();
    const switcher = new TabSwitcher(f.chrome);
    await switcher.invoke(f.lookup(1));
    assert.deepEqual(f.updates, []);
    assert.equal(f.picker(), undefined);
    f.windows[1].tabs.push(second);
    await switcher.invoke(f.lookup(1));
    assert.deepEqual(f.state().tabIds, [1, 2]);
    assert.equal(f.state().selectedId, 2);
    assert.deepEqual(f.updates, []);
    await f.request(switcher, 'commit');
    assert.deepEqual(f.updates, [2]);
    assert.equal(f.picker(), undefined);
});

test('an observed Option release during inline startup switches once with no popup', async () => {
    const f = fixture();
    let release;
    let stop;
    const overlay = {
        isOnTab: () => false,
        ownsGesture: () => true,
        open: async (_source, token, _pressedAt, prepare) => {
            await prepare();
            release = switcher.inlineInput(token, 'commit');
            return true;
        },
        close: async token => { stop = token; },
    };
    const switcher = new TabSwitcher(f.chrome, undefined, overlay);
    await switcher.invoke(f.lookup(1));
    await release;
    assert.deepEqual(f.updates, [2]);
    assert.equal(f.picker(), undefined);
    assert.equal(f.state(), undefined);
    assert.equal(typeof stop, 'string');
});

test('queued native repeats advance once each before an observed startup release commits', async () => {
    const f = fixture();
    let reveal;
    let opened;
    const ready = new Promise(resolve => { opened = resolve; });
    const opening = new Promise(resolve => { reveal = resolve; });
    const overlay = {
        isOnTab: () => true,
        ownsGesture: () => true,
        open: async (_source, token, _pressedAt, prepare) => {
            await prepare();
            opened(token);
            return opening;
        },
        close: async () => {},
    };
    const switcher = new TabSwitcher(f.chrome, undefined, overlay);
    const first = switcher.invoke(f.lookup(1));
    const token = await ready;
    const second = switcher.invoke(f.lookup(1));
    const third = switcher.invoke(f.lookup(1));
    const released = switcher.inlineInput(token, 'commit');
    reveal(true);
    await Promise.all([first, second, third, released]);
    assert.deepEqual(f.updates, [4]);
    assert.equal(f.picker(), undefined);
    assert.equal(f.state(), undefined);
});

test('navigation in a source tab that lost focus does not open a focused picker', async () => {
    const f = fixture();
    const original = f.lookup(1);
    const overlay = {
        current: { source: original },
        isOnTab: () => true,
        ownsGesture: () => true,
        open: async (_source, token, _pressedAt, prepare) => {
            await prepare();
            overlay.current.token = token;
            return true;
        },
        close: async () => {},
    };
    const switcher = new TabSwitcher(f.chrome, undefined, overlay);
    await switcher.invoke(original);
    f.windows[0].focused = false;
    await switcher.inlineSourceChanged(original.id, { status: 'loading' });
    assert.equal(f.picker(), undefined);
    assert.equal(f.state(), undefined);
    assert.deepEqual(f.updates, []);
    assert.deepEqual(f.focused, []);
});

test('a stale inline handshake cannot steal focus with a fallback popup', async () => {
    const f = fixture();
    f.windows[0].focused = true;
    const original = f.lookup(1);
    original.active = true;
    const overlay = {
        isOnTab: () => false,
        open: async (_source, _token, _pressedAt, prepare) => {
            await prepare();
            f.windows[0].focused = false;
            return false;
        },
    };
    await new TabSwitcher(f.chrome, undefined, overlay).invoke(original);
    assert.equal(f.picker(), undefined);
    assert.equal(f.state(), undefined);
    assert.deepEqual(f.updates, []);
    assert.deepEqual(f.focused, []);
});

test('back-to-back commands with stale origin snapshot open one real picker and preserve duplicate URLs', async () => {
    const f = fixture();
    const switcher = new TabSwitcher(f.chrome);
    await Promise.all([switcher.invoke(f.lookup(1)), switcher.invoke(f.lookup(1)), switcher.invoke(f.lookup(1))]);
    assert.deepEqual(f.updates, []);
    assert.deepEqual(f.state().tabIds, [1, 2, 3, 4]);
    assert.equal(f.state().selectedId, 4);
    assert.equal(f.windows.filter(window => window.id === 55).length, 1);
});

test('a delayed repeat with a stale origin advances the existing focused picker', async () => {
    const f = fixture();
    const switcher = new TabSwitcher(f.chrome);
    const now = Date.now();
    await switcher.invoke(f.lookup(1), now);
    assert.equal(f.state().selectedId, 2);
    const picker = f.picker();
    await switcher.invoke(f.lookup(1), now + 3000);
    assert.equal(f.state().selectedId, 3);
    assert.equal(f.picker(), picker);
    assert.deepEqual(f.updates, []);
    await f.request(switcher, 'commit');
    assert.deepEqual(f.updates, [3]);
    assert.equal(f.picker(), undefined);
});

test('a current picker opens preview settings in its regular origin without committing the highlighted tab', async () => {
    const f = fixture();
    const switcher = new TabSwitcher(f.chrome);
    await switcher.invoke(f.lookup(1));
    const picker = f.picker();
    const sender = { id: f.chrome.runtime.id, url: picker.url, tab: picker.tabs[0] };
    await switcher.receive({ type: TAB_SWITCHER_SESSION, action: 'previewSettings' }, { ...sender, url: switcher.pageUrl('stale') });
    assert.deepEqual(f.created, []);
    await Promise.all([
        switcher.receive({ type: TAB_SWITCHER_SESSION, action: 'previewSettings' }, sender),
        switcher.receive({ type: TAB_SWITCHER_SESSION, action: 'commit' }, sender),
    ]);
    assert.deepEqual(f.created, [{ windowId: 10, url: f.chrome.runtime.getURL('options.html#tabSwitcherCaptureOnVisit'), active: true }]);
    assert.deepEqual(f.focused, [10]);
    assert.deepEqual(f.updates, []);
    assert.equal(f.state(), undefined);
    assert.equal(f.picker(), undefined);
});

test('a non-normal or vanished origin does not invent a different starting tab', async () => {
    const f = fixture();
    const switcher = new TabSwitcher(f.chrome);
    await switcher.invoke(f.lookup(6));
    const oldOrigin = f.windows[0].tabs.shift();
    await switcher.invoke(oldOrigin);
    assert.equal(f.state(), undefined);
    assert.equal(f.picker(), undefined);
    assert.deepEqual(f.updates, []);
});

test('focusing another normal window dismisses the open picker without changing that destination', async () => {
    const f = fixture();
    const switcher = new TabSwitcher(f.chrome);
    await switcher.invoke(f.lookup(1));
    f.windows[0].focused = true;
    await switcher.windowFocused(10, Date.now() + 1);
    assert.deepEqual(f.updates, []);
    assert.equal(f.state(), undefined);
    assert.equal(f.picker(), undefined);
});

test('window focus updates cross-window recency even without a native tab activation', async () => {
    const f = fixture();
    const switcher = new TabSwitcher(f.chrome);
    f.lookup(3).active = true;
    f.windows[1].focused = true;
    await switcher.windowFocused(20, 600);
    f.windows[1].focused = false;
    f.lookup(1).active = true;
    f.windows[0].focused = true;
    await switcher.windowFocused(10, 700);
    assert.equal(f.lookup(3).lastAccessed, 200);
    const restarted = new TabSwitcher(f.chrome);
    await restarted.invoke(f.lookup(1));
    assert.equal(f.state().selectedId, 3);
    await f.request(restarted, 'commit');
    assert.deepEqual(f.updates, [3]);
});

test('rapid private-window commands cycle only among private tabs without creating a picker', async () => {
    const f = fixture();
    f.windows[2].tabs.push(
        { ...f.lookup(5), id: 7, lastAccessed: 250 },
        { ...f.lookup(5), id: 8, lastAccessed: 50 },
    );
    const switcher = new TabSwitcher(f.chrome);
    await switcher.invoke(f.lookup(5));
    await switcher.invoke(f.lookup(7));
    await switcher.invoke(f.lookup(8));
    assert.deepEqual(f.updates, [7, 8, 5]);
    assert.equal(f.picker(), undefined);
    assert.equal(f.state(), undefined);
});

test('the private shortcut wraps around five IDs when more tabs are open', async () => {
    const f = fixture();
    for (const [index, id] of [7, 8, 9, 10, 11, 12].entries()) {
        f.windows[2].tabs.push({ ...f.lookup(5), id, lastAccessed: 450 - index * 10 });
    }
    const switcher = new TabSwitcher(f.chrome);
    const sequence = [5, 7, 8, 9, 10, 5];
    const started = Date.now();
    for (const [index, id] of sequence.entries()) await switcher.invoke(f.lookup(id), started + index);
    assert.deepEqual(f.updates, [7, 8, 9, 10, 5, 7]);
    assert.equal(f.picker(), undefined);
});

test('the open picker survives a worker restart and keeps wrapped order across moves and closes', async () => {
    const f = fixture();
    const switcher = new TabSwitcher(f.chrome);
    await switcher.invoke(f.lookup(1));
    assert.equal(f.state().selectedId, 2);
    const resumed = new TabSwitcher(f.chrome);
    await resumed.invoke(f.picker().tabs[0]);
    assert.equal(f.state().selectedId, 3);
    await resumed.invoke(f.picker().tabs[0]);
    assert.equal(f.state().selectedId, 4);
    await resumed.invoke(f.picker().tabs[0]);
    assert.equal(f.state().selectedId, 1);
    await f.request(resumed, 'previous');
    assert.equal(f.state().selectedId, 4);
    f.windows[0].tabs.pop();
    await resumed.removeTab(4);
    assert.deepEqual(f.state().tabIds, [1, 2, 3]);
    assert.equal(f.state().selectedId, 1);
    await f.request(resumed, 'commit', 3);
    assert.deepEqual(f.updates, [3]);
    assert.deepEqual(f.focused, [20]);
    assert.equal(f.state(), undefined);
    assert.equal(f.picker(), undefined);
});

test('only the current picker can act and Escape restores the original window', async () => {
    const f = fixture();
    const switcher = new TabSwitcher(f.chrome);
    await switcher.invoke(f.lookup(1));
    const fakeAction = { type: TAB_SWITCHER_SESSION, action: 'commit' };
    const sender = { id: f.chrome.runtime.id, url: f.picker().url, tab: f.picker().tabs[0] };
    assert.equal(switcher.receive(fakeAction, { ...sender, url: 'https://foreign.test/' }), undefined);
    await switcher.receive(fakeAction, { ...sender, url: f.picker().url + '-stale' });
    await switcher.receive(fakeAction, { ...sender, tab: { ...sender.tab, incognito: true } });
    assert.deepEqual(f.updates, []);
    await f.request(switcher, 'cancel');
    assert.deepEqual(f.updates, [1]);
    assert.deepEqual(f.focused, [10]);
    assert.equal(f.state(), undefined);
    assert.equal(f.picker(), undefined);
});

test('popup cleanup keeps an actionable snapshot if Chrome rejects window removal', async () => {
    const f = fixture();
    const switcher = new TabSwitcher(f.chrome);
    await switcher.invoke(f.lookup(1));
    const remove = f.chrome.windows.remove;
    f.chrome.windows.remove = async () => { throw new Error('Temporary failure'); };
    await assert.rejects(f.request(switcher, 'cancel'), /Temporary failure/);
    assert.ok(f.state());
    assert.ok(f.picker());
    f.chrome.windows.remove = remove;
    await f.request(switcher, 'cancel');
    assert.equal(f.state(), undefined);
    assert.equal(f.picker(), undefined);
});

test('picker labels omit embedded, script, credential, and query payloads', () => {
    const embedded = 'data:text/html,%3Cform%3Eprivate%3C%2Fform%3E';
    assert.deepEqual(describeOpenTab({ url: embedded, title: embedded }), {
        title: 'Embedded document', address: '',
    });
    assert.deepEqual(describeOpenTab({ url: embedded, title: 'A named document' }), {
        title: 'A named document', address: 'Embedded document',
    });
    assert.deepEqual(describeOpenTab({ url: 'blob:https://example.test/opaque-id', title: 'Report' }), {
        title: 'Report', address: 'Embedded document · example.test',
    });
    assert.deepEqual(describeOpenTab({ pendingUrl: 'javascript:alert(1)' }), {
        title: 'JavaScript URL', address: '',
    });
    assert.deepEqual(describeOpenTab({ url: 'https://user:password@example.test/inbox?token=private#fragment', title: 'Inbox' }), {
        title: 'Inbox', address: 'example.test/inbox',
    });
});

test('capture only receives real regular tab gestures and failures never stop switching', async () => {
    const f = fixture();
    const captures = [];
    const switcher = new TabSwitcher(f.chrome, {
        async capture(tab) {
            captures.push(tab.id);
            throw new Error('Capture unavailable');
        },
    });
    await switcher.invoke(f.lookup(1));
    assert.deepEqual(f.updates, []);
    await switcher.invoke(f.picker().tabs[0]);
    await f.request(switcher, 'cancel');
    await switcher.invoke(f.lookup(2));
    await f.request(switcher, 'commit');
    await switcher.invoke(f.lookup(5));
    assert.deepEqual(captures, [1, 2]);
});

test('only the current picker may read its previews and slow images do not block keyboard actions', async () => {
    const f = fixture();
    let resolvePreviews;
    const pending = new Promise(resolve => { resolvePreviews = resolve; });
    const switcher = new TabSwitcher(f.chrome, {
        async capture() {},
        async get(tabIds) {
            assert.deepEqual(tabIds, [1, 2, 3, 4]);
            return pending;
        },
    });
    await switcher.invoke(f.lookup(1));
    const sender = { id: f.chrome.runtime.id, url: f.picker().url + '-other', tab: f.picker().tabs[0] };
    assert.equal(await switcher.receive({ type: TAB_SWITCHER_SESSION, action: 'previews' }, sender), undefined);
    const response = f.request(switcher, 'previews');
    await f.request(switcher, 'previous');
    assert.equal(f.state().selectedId, 1);
    resolvePreviews({ 2: 'data:image/jpeg;base64,cHJldmlldw==' });
    assert.deepEqual(await response, { previews: { 2: 'data:image/jpeg;base64,cHJldmlldw==' } });
});

test('five recent IDs are frozen and later or older tabs cannot enter selection', async () => {
    const f = fixture();
    for (const [index, id] of [7, 8, 9, 10].entries()) {
        f.windows[0].tabs.push({ ...f.lookup(1), id, lastAccessed: 90 - index * 10 });
    }
    const switcher = new TabSwitcher(f.chrome);
    await switcher.invoke(f.lookup(1));
    const selected = () => f.state().selectedId;
    assert.deepEqual(f.state().tabIds, [1, 2, 3, 4, 7]);
    assert.equal(f.state().tabIds.length, TAB_SWITCHER_LIMIT);
    assert.equal(selected(), 2);
    f.windows[0].tabs.push({ ...f.lookup(1), id: 11, lastAccessed: 5000 });
    for (const id of [3, 4, 7, 1]) {
        await f.request(switcher, 'next');
        assert.equal(selected(), id);
    }
    await f.request(switcher, 'previous');
    assert.equal(selected(), 7);
    await f.request(switcher, 'commit', 8);
    await f.request(switcher, 'commit', 9);
    await f.request(switcher, 'commit', 11);
    assert.deepEqual(f.updates, []);
    await f.request(switcher, 'commit');
    assert.deepEqual(f.updates, [7]);
});

test('a suspended foreground capture does not delay the first picker window', async () => {
    const f = fixture();
    let complete;
    const pending = new Promise(resolve => { complete = resolve; });
    const switcher = new TabSwitcher(f.chrome, { capture: () => pending });
    await switcher.invoke(f.lookup(1));
    assert.equal(f.state().selectedId, 2);
    complete();
});

function pickerInputFixture(onMessage) {
    const listeners = new Map();
    const timers = new Map();
    let nextTimer = 1;
    let messages = [];
    let openingPreviewSettings = false;
    const script = readFileSync(new URL('../../public/tab-switcher-release.js', import.meta.url), 'utf8');
    const window = { addEventListener(type, listener) { listeners.set(type, listener); } };
    window.parent = window;
    runInNewContext(script, {
        window,
        document: { hasFocus: () => true, documentElement: {
            hasAttribute: name => name === 'data-opening-preview-settings' && openingPreviewSettings,
        } },
        setTimeout(listener) {
            const id = nextTimer++;
            timers.set(id, listener);
            return id;
        },
        clearTimeout(id) { timers.delete(id); },
        chrome: { runtime: {
            async sendMessage(message) {
                const result = onMessage(message);
                messages.push(result);
                return result;
            },
        } },
    });
    const emit = (name, event = {}) => listeners.get(name)?.({ isTrusted: true, ...event });
    const expire = async () => {
        for (const [id, listener] of timers) {
            timers.delete(id);
            listener();
        }
        await settle();
    };
    const settle = async () => {
        const pending = messages;
        messages = [];
        await Promise.all(pending);
    };
    return { emit, expire, settle, openPreviewSettings() { openingPreviewSettings = true; } };
}

test('the head listener accepts only a trusted Option release before the renderer initializes', async () => {
    const requests = [];
    const f = pickerInputFixture(message => requests.push([message.type, message.action]));
    f.emit('keyup', { key: 'Alt', altKey: false, isTrusted: false });
    f.emit('keyup', { key: 'Tab', altKey: true });
    f.emit('keyup', { key: 'Alt', altKey: true });
    assert.deepEqual(requests, []);
    f.emit('keyup', { key: 'Alt', altKey: false });
    await f.settle();
    assert.deepEqual(requests, [[TAB_SWITCHER_SESSION, 'commit']]);
});

test('releasing Option while opening preview settings does not commit a tab switch', async () => {
    const f = pickerInputFixture(() => assert.fail('Should not commit an Option release while navigating to settings'));
    f.openPreviewSettings();
    f.emit('keyup', { key: 'Alt', altKey: false });
    await f.settle();
});

test('a quiet first hold and a pause after advancing cannot activate a tab before Option release', async () => {
    const f = fixture();
    const switcher = new TabSwitcher(f.chrome);
    await switcher.invoke(f.lookup(1));
    const picker = f.picker();
    const input = pickerInputFixture(message => f.request(switcher, message.action));
    // Model the initial Tab release being delivered before the picker gains focus.
    input.emit('tab-switcher-ready');
    await input.expire();
    assert.deepEqual(f.updates, []);
    assert.equal(f.picker(), picker);
    assert.equal(f.state().selectedId, 2);
    await switcher.invoke(picker.tabs[0]);
    await input.expire();
    assert.deepEqual(f.updates, []);
    assert.equal(f.picker(), picker);
    assert.equal(f.state().selectedId, 3);
    input.emit('keyup', { key: 'Alt', altKey: false });
    await input.settle();
    assert.deepEqual(f.updates, [3]);
    assert.equal(f.picker(), undefined);
});
