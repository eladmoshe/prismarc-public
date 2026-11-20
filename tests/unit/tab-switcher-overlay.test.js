import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { TabSwitcherOverlay } from '../../tab-switcher-overlay.js';
import { INLINE_ACCESS, INLINE_SWITCHER, setInlineSwitcher } from '../../tab-switcher-inline-settings.js';
import { setPreviewPreferences } from '../../tab-switcher-preview-settings.js';

function fixture() {
    const source = { id: 42, windowId: 7, incognito: false, active: true, url: 'https://source.test/page' };
    const tabOnly = action => ({
        id: 'prismarc', tab: source, documentLifecycle: 'active', documentId: action,
        frameId: 0, url: source.url, origin: 'https://source.test',
    });
    const renderer = { ...tabOnly('renderer'), frameId: 9, url: 'chrome-extension://dynamic/tab-switcher.html',
        origin: 'chrome-extension://dynamic' };
    let probeReady;
    const probe = new Promise(resolve => { probeReady = resolve; });
    const sends = [];
    const steps = [];
    const api = {
        scripting: {},
        commands: { async getAll() { return [{ name: 'cycleOpenTabs', shortcut: '⌥⇥' }]; } },
        storage: { local: { async get() { return { [INLINE_SWITCHER]: true }; } } },
        permissions: { async contains() { return true; } },
        windows: { async get() { return { type: 'normal', focused: true, incognito: false, tabs: [source] }; } },
        tabs: { async sendMessage(_id, message) {
            sends.push(message.action);
            if (message.action === 'probe') probeReady(message.nonce);
            return true;
        } },
        runtime: {
            id: 'prismarc', getURL: path => 'chrome-extension://dynamic/' + path,
            async getPlatformInfo() { return { os: 'mac' }; },
        },
    };
    const overlay = new TabSwitcherOverlay(api, {
        input: (...call) => steps.push(call), lost: token => steps.push(['lost', token]),
    });
    return { overlay, source, tabOnly, renderer, probe, sends, steps, api };
}

const bridge = (nonce, action) => ({ type: 'recent-tabs-inline', nonce, action });

test('only the renderer that proves the isolated host capability can access the picker', async () => {
    const f = fixture();
    const opened = f.overlay.open(f.source, 'picker-token', Date.now());
    const nonce = await f.probe;
    assert.equal(await f.overlay.receive(bridge(nonce, 'renderer'), f.renderer), undefined);
    await f.overlay.receive(bridge(nonce, 'probe'), f.tabOnly('host'));
    await f.overlay.receive(bridge(nonce, 'host'), f.tabOnly('host'));
    for (const sender of [
        { ...f.renderer, origin: 'null' },
        { ...f.renderer, id: 'other' },
        { ...f.renderer, frameId: 0 },
        { ...f.renderer, documentLifecycle: 'cached' },
        { ...f.renderer, tab: { ...f.source, id: 99 } },
        { ...f.renderer, tab: { ...f.source, incognito: true } },
    ]) {
        assert.equal(await f.overlay.receive(bridge(nonce, 'renderer'), sender), undefined);
    }
    assert.equal(await f.overlay.receive(bridge('wrong', 'renderer'), f.renderer), undefined);
    assert.deepEqual(await f.overlay.receive(bridge(nonce, 'renderer'), f.renderer), { token: 'picker-token' });
    assert.equal(await opened, true);
    assert.equal(f.overlay.authorizes({ token: 'picker-token' }, f.renderer), true);
    assert.equal(f.overlay.authorizes({ token: 'picker-token' }, { ...f.renderer, documentId: 'independent' }), false);
    await f.overlay.close('picker-token');
    assert.ok(!f.overlay.authorizes({ token: 'picker-token' }, f.renderer));
});

test('an early release is committed only after the same source prepares a renderer', async () => {
    const f = fixture();
    const opened = f.overlay.open(f.source, 'same-session', Date.now());
    const nonce = await f.probe;
    await f.overlay.receive(bridge(nonce, 'released-probe'), f.tabOnly('source-key-frame'));
    await f.overlay.receive(bridge(nonce, 'host'), f.tabOnly('top-host'));
    assert.deepEqual(f.steps, []);
    await f.overlay.receive(bridge(nonce, 'renderer'), f.renderer);
    assert.equal(await opened, true);
    assert.deepEqual(f.steps, [['same-session', 'commit']]);
    f.overlay.reset();
    assert.deepEqual(f.steps.at(-1), ['lost', 'same-session']);
});

test('Quick Switcher waits for its authenticated search input before taking page focus', async () => {
    const f = fixture();
    let mount;
    let show;
    const mounted = new Promise(resolve => { mount = resolve; });
    const shown = new Promise(resolve => { show = resolve; });
    const record = f.api.tabs.sendMessage;
    f.api.tabs.sendMessage = async (id, message) => {
        if (message.action === 'mount') mount(message.nonce);
        if (message.action === 'show') show();
        return record(id, message);
    };
    const picker = { ...f.renderer, url: 'chrome-extension://dynamic/quick-switcher.html' };
    const open = f.overlay.openSearch(f.source);
    const nonce = await mounted;
    await f.overlay.receive(bridge(nonce, 'host'), f.tabOnly('top-host'));
    assert.equal(await f.overlay.receive(bridge(nonce, 'renderer'), f.renderer), undefined);
    assert.equal((await f.overlay.receive(bridge(nonce, 'renderer'), picker)).windowId, f.source.windowId);
    await f.overlay.receive(bridge(nonce, 'interactive'), { ...picker, documentId: 'other' });
    assert.deepEqual(f.sends, ['mount']);
    await f.overlay.receive(bridge(nonce, 'interactive'), picker);
    await shown;
    assert.deepEqual(f.sends, ['mount', 'show']);
    await f.overlay.receive(bridge(nonce, 'focused'), picker);
    assert.equal(await open, true);
    await f.overlay.receive(bridge(nonce, 'dismiss'), picker);
    assert.equal(await f.overlay.receive(bridge(nonce, 'activate'), picker), undefined);
});

test('a same-document search route requires exact live tab and top-document confirmation', async () => {
    const f = fixture();
    f.source.url += '/workspace#redwood';
    const host = { ...f.tabOnly('top-document'), url: 'https://source.test/page' };
    let mounted, confirms = false;
    const mount = new Promise(resolve => { mounted = resolve; });
    f.api.tabs.sendMessage = async (_id, message, target) => {
        if (message.action === 'mount') mounted(message.nonce);
        if (message.action === 'confirm-search-route') {
            assert.deepEqual(target, { documentId: host.documentId });
            assert.equal(message.url, f.source.url);
            return confirms;
        }
        return true;
    };
    const open = f.overlay.openSearch(f.source);
    const nonce = await mount;
    const claim = sender => f.overlay.receive(bridge(nonce, 'host'), sender);
    for (const sender of [host, { ...host, frameId: 4 }, { ...host, origin: 'https://other.test' }, { ...host, url: 'https://other.test/page' },
        { ...host, tab: { ...f.source, url: host.url } }]) {
        assert.equal((await claim(sender))?.success, false);
        assert.equal(f.overlay.current.host, undefined);
    }
    confirms = true;
    const originalWindow = f.api.windows.get;
    f.api.windows.get = async () => ({ ...await originalWindow(), tabs: [{ ...f.source, url: 'https://source.test/changed' }] });
    assert.equal((await claim(host)).success, false);
    f.api.windows.get = originalWindow;
    await claim(host);
    assert.equal(f.overlay.current.host, host.documentId);
    // A same-URL load signal cannot keep the attempt if its original top document is gone.
    confirms = false;
    f.overlay.searchSourceChanged(f.source.id, { status: 'loading' }, f.source);
    assert.equal(await open, false);
});

test('a missing search listener is attached once and mounted only in the recovered top document', async () => {
    const f = fixture();
    const options = [];
    f.api.scripting.executeScript = async injection => {
        assert.deepEqual(injection, { target: { tabId: f.source.id, frameIds: [0] }, files: ['tab-switcher-inline.js'], injectImmediately: true });
        return [{ frameId: 0, documentId: 'recovered' }];
    };
    f.api.tabs.sendMessage = async (_id, message, target) => {
        if (message.action !== 'mount') return true;
        options.push(target);
        if (options.length === 1) throw new Error('Could not establish connection. Receiving end does not exist.');
        assert.equal((await f.overlay.receive(bridge(message.nonce, 'host'), f.tabOnly('replaced'))).success, false);
        return false;
    };
    assert.equal(await f.overlay.openSearch(f.source), false);
    assert.deepEqual(options, [{ frameId: 0 }, { documentId: 'recovered' }]);
});

test('an explicit refusal or lost site permission cannot trigger listener attachment', async () => {
    for (const missing of [false, true]) {
        const f = fixture();
        let permissionChecks = 0, injections = 0;
        f.api.permissions.contains = async () => ++permissionChecks === 1;
        f.api.scripting.executeScript = async () => { injections++; return []; };
        f.api.tabs.sendMessage = async () => {
            if (missing) throw new Error('Receiving end does not exist.');
            return false;
        };
        assert.equal(await f.overlay.openSearch(f.source), false);
        assert.equal(injections, 0);
    }
});

test('a Chrome host grant is preserved for each explicitly enabled feature', async () => {
    const choices = { tabSwitcherCaptureOnVisit: true };
    const removals = [];
    const api = {
        storage: { local: { async get() { return { ...choices }; }, async set(change) { Object.assign(choices, change); } } },
        permissions: {
            async request(permission) { assert.deepEqual(permission, INLINE_ACCESS); return true; },
            async contains() { return true; },
            async remove(permission) { removals.push(permission); },
        },
    };
    const locks = { request: (_name, callback) => callback() };
    assert.equal(await setInlineSwitcher(api, true, undefined, locks), true);
    await setPreviewPreferences(api, { tabSwitcherCaptureOnVisit: false }, locks);
    assert.deepEqual(removals, []);
    await setInlineSwitcher(api, false, true, locks);
    assert.deepEqual(removals, [{ permissions: ['scripting'] }, { origins: ['<all_urls>'] }]);
});

function preloadedFrame() {
    const keys = new Map();
    const messages = [];
    const window = { addEventListener(type, listener) { keys.set(type, listener); } };
    window.top = window;
    let receive;
    let now = 100_000;
    let focused = true;
    const chrome = {
        extension: { inIncognitoContext: false },
        runtime: {
            id: 'prismarc',
            onMessage: { addListener(listener) { receive = listener; } },
            async sendMessage(message) { messages.push(message.action); },
        },
        storage: { onChanged: { addListener() {} } },
    };
    const script = readFileSync(new URL('../../public/tab-switcher-inline.js', import.meta.url), 'utf8');
    runInNewContext(script, { window, chrome, navigator: { platform: 'MacIntel' },
        document: { hasFocus: () => focused }, Date: { now: () => now } });
    const option = (type, extra) => keys.get(type)({ key: 'Alt', altKey: type === 'keydown', isTrusted: true, ...extra });
    const probe = (id = chrome.runtime.id) => {
        let accepted;
        receive({ ...bridge('probe-token', 'probe'), pressedAt: now }, { id }, response => { accepted = response; });
        return accepted;
    };
    return {
        messages, keys, option, probe, advance: ms => { now += ms; }, blur: () => { focused = false; keys.get('blur')(); },
    };
}

test('the preloaded listener can associate an early Option release with a cold worker callback only once', () => {
    const frame = preloadedFrame();
    frame.option('keydown');
    frame.option('keyup', { isTrusted: false });
    assert.deepEqual(frame.messages, []);
    frame.option('keyup');
    frame.advance(520);
    assert.equal(frame.probe('wrong-extension'), undefined);
    assert.equal(frame.probe(), true);
    assert.deepEqual(frame.messages, ['released-probe']);
    assert.equal(frame.probe(), undefined);
});

test('expired, interrupted, blurred, or ambiguous source Options cannot stand in for a new switcher gesture', () => {
    for (const interrupt of [
        frame => frame.advance(1100),
        frame => frame.keys.get('keydown')({ key: 'j', altKey: false, isTrusted: true }),
        frame => frame.keys.get('pointerdown')({ isTrusted: true }),
        frame => frame.option('keydown'),
        frame => frame.blur(),
    ]) {
        const frame = preloadedFrame();
        frame.option('keydown');
        frame.option('keyup');
        interrupt(frame);
        assert.equal(frame.probe(), undefined);
    }
});

test('a non-Option Chrome shortcut falls back even after a recent Option event', async () => {
    const f = fixture();
    f.api.commands.getAll = async () => [{ name: 'cycleOpenTabs', shortcut: '⇧⌘Y' }];
    assert.equal(await f.overlay.open(f.source, 'not-option', Date.now()), false);
    assert.deepEqual(f.sends, []);
});

test('ordinary keys after a swallowed Option release cannot switch, and a real Option release triggers once', () => {
    const frame = preloadedFrame();
    frame.option('keydown');
    assert.equal(frame.probe(), true);
    frame.keys.get('keyup')({ key: 'j', altKey: false, isTrusted: true });
    assert.deepEqual(frame.messages, ['probe']);
    frame.option('keyup');
    frame.option('keyup');
    assert.deepEqual(frame.messages, ['probe', 'release']);
});

test('failed overlay consent cannot retain newly unowned scripting or revoke browsing previews', async () => {
    for (const shouldKeepSiteAccess of [true, false]) {
        const choices = { tabSwitcherCaptureOnVisit: shouldKeepSiteAccess };
        const calls = [];
        const api = {
            storage: { local: {
                async get() { return { ...choices }; },
                async set() { throw new Error('Settings unavailable'); },
            } },
            permissions: {
                async request() { return true; },
                async contains() { return true; },
                async remove(permission) { calls.push(permission); },
            },
        };
        await assert.rejects(setInlineSwitcher(api, true, undefined, { request: (_name, act) => act() }), /Settings unavailable/);
        assert.deepEqual(calls, shouldKeepSiteAccess ? [{ permissions: ['scripting'] }] :
            [{ permissions: ['scripting'] }, { origins: ['<all_urls>'] }]);
        assert.equal(choices[INLINE_SWITCHER], undefined);
    }
});

test('the native grant is revalidated before enabling the overlay locally', async () => {
    const calls = [];
    const api = {
        storage: { local: {
            async get() { return { tabSwitcherCaptureOnVisit: true }; },
            async set() { assert.fail('Native permissions were removed'); },
        } },
        permissions: {
            async request() { return true; },
            async contains() { return false; },
            async remove(permission) { calls.push(permission); },
        },
    };
    assert.equal(await setInlineSwitcher(api, true, undefined, { request: (_name, act) => act() }), false);
    assert.deepEqual(calls, [{ permissions: ['scripting'] }]);
});
