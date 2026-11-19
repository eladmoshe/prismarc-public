import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setTimeout as wait } from 'node:timers/promises';
import { parsePreviewDomains, TAB_SWITCHER_EXCLUDED_DOMAINS, TabSwitcherPreviews, TAB_SWITCHER_CAPTURE_ON_VISIT, TAB_SWITCHER_PAGE_PREVIEWS, TAB_SWITCHER_PREVIEW_CACHE } from '../../tab-switcher-previews.js';

const reducedImage = 'data:image/jpeg;base64,Zml4dHVyZQ==';
const webTab = { id: 1, windowId: 4, url: 'http://example.test/', active: true, incognito: false, status: 'complete' };

function deferred() {
    let resolve;
    const promise = new Promise(done => { resolve = done; });
    return { promise, resolve };
}

function fixture(settings = {}, session = {}) {
    const handlers = {};
    let active = { ...webTab };
    let allSites = false;
    const live = new Map([[active.id, active]]);
    const calls = [];
    function event(name) {
        return { addListener(handler) { (handlers[name] ||= []).push(handler); } };
    }
    function emit(name, ...args) {
        for (const handler of handlers[name] ?? []) handler(...args);
    }
    const area = items => ({
        get: async selector => {
            const keys = selector == null ? Object.keys(items) : [selector].flat();
            return structuredClone(Object.fromEntries(keys.filter(key => key in items).map(key => [key, items[key]])));
        },
        getKeys: async () => Object.keys(items),
        set: async values => Object.assign(items, structuredClone(values)),
        remove: async keys => { for (const key of [keys].flat()) delete items[key]; },
    });
    const chrome = {
        storage: {
            local: area(settings),
            session: area(session),
            onChanged: event('storage'),
        },
        windows: {
            get: async () => ({ focused: true, type: 'normal', incognito: false, tabs: [active] }),
            getLastFocused: async () => ({ id: active.windowId }),
            onFocusChanged: event('focus'),
        },
        tabs: {
            get: async id => live.get(id),
            captureVisibleTab: async (id, options) => {
                calls.push([id, options]);
                return 'fixture raw data';
            },
            onUpdated: event('updated'),
            onRemoved: event('removed'),
            onActivated: event('activated'),
        },
        permissions: { contains: async () => allSites, onAdded: event('permission-added'), onRemoved: event('permission-removed') },
        alarms: { onAlarm: event('alarm') },
    };
    let now = 100_000;
    const worker = (resize = async () => reducedImage) => {
        const previews = new TabSwitcherPreviews(chrome, { now: () => now, resize });
        previews.register();
        return previews;
    };
    return {
        chrome, emit, get active() { return active; }, live, calls, session, local: settings, worker,
        advance: delta => { now += delta; },
        grant: value => { allSites = value; },
        select: props => {
            active = { ...webTab, ...props };
            live.set(active.id, active);
        },
    };
}

test('a shortcut can hand off before its screenshot arrives; a restarted worker serves only reduced eligible pixels', async () => {
    const f = fixture();
    const service = f.worker();
    const capture = deferred();
    f.chrome.tabs.captureVisibleTab = async (id, options) => {
        f.calls.push([id, options]);
        return capture.promise;
    };
    await service.capture(f.active);
    assert.deepEqual(f.calls, [[4, { format: 'jpeg', quality: 45 }]]);
    assert.equal(f.session[TAB_SWITCHER_PREVIEW_CACHE], undefined);
    const result = service.get([1, 8]);
    capture.resolve('fixture raw bytes');
    assert.deepEqual(await result, { 1: reducedImage });
    const cache = f.session[TAB_SWITCHER_PREVIEW_CACHE];
    assert.deepEqual(Object.keys(cache[1]).sort(), ['capturedAt', 'expiresAt', 'ref']);
    assert.match(cache[1].ref, /:s:/);
    assert.ok(f.session[cache[1].ref].ciphertext);
    assert.ok(!JSON.stringify(f.session).includes(reducedImage));
    assert.deepEqual(f.local, {});
    assert.equal(JSON.stringify(cache).includes('example.test'), false);
    assert.deepEqual(await f.worker().get([1, 8]), { 1: reducedImage });
    delete f.active.url;
    assert.deepEqual(await f.worker().get([1]), {});
});

test('an explicit opt-out clears the session shelf and rejects pending capture output', async () => {
    const f = fixture();
    const service = f.worker();
    await service.capture(f.active);
    assert.deepEqual(await service.get([1]), { 1: reducedImage });

    const capture = deferred();
    f.chrome.tabs.captureVisibleTab = async () => capture.promise;
    await service.capture(f.active);
    f.emit('storage', { [TAB_SWITCHER_PAGE_PREVIEWS]: { newValue: false } }, 'local');
    capture.resolve('late fixture bytes');
    await service.cacheWork;
    assert.equal(f.session[TAB_SWITCHER_PREVIEW_CACHE], undefined);
    assert.deepEqual(await service.get([1]), {});

    const off = fixture({ [TAB_SWITCHER_PAGE_PREVIEWS]: false });
    await off.worker().capture(off.active);
    assert.deepEqual(off.calls, []);
});

test('only stable foreground normal web tabs can be captured', async () => {
    const f = fixture();
    const service = f.worker();
    await service.capture({ ...f.active, incognito: true });
    await service.capture({ ...f.active, url: 'chrome://settings/' });
    await service.capture({ ...f.active, active: false });
    await service.capture({ ...f.active, pendingUrl: 'http://example.test/new' });
    await service.capture({ ...f.active, status: 'unloaded', discarded: true });
    f.chrome.windows.get = async () => ({ focused: false, type: 'normal', tabs: [f.active] });
    await service.capture(f.active);
    assert.equal(f.calls.length, 0);

    let reads = 0;
    f.chrome.windows.get = async () => {
        if (++reads === 2) {
            f.emit('activated', { tabId: 2, windowId: 4 });
            f.emit('activated', { tabId: 1, windowId: 4 });
        }
        return { focused: true, type: 'normal', tabs: [f.active] };
    };
    await service.capture(f.active);
    assert.equal(f.calls.length, 1);
    assert.deepEqual(await service.get([1]), {});
});

test('navigation before hydration finishes and deletion after hydration both evict thumbnails', async () => {
    const records = { 1: { data: reducedImage, expiresAt: 160_000 } };
    const f = fixture({}, { [TAB_SWITCHER_PREVIEW_CACHE]: records });
    const read = deferred();
    f.chrome.storage.session.get = async () => read.promise;
    const service = f.worker();
    f.emit('updated', 1, { url: 'http://example.test/changed' });
    read.resolve({ [TAB_SWITCHER_PREVIEW_CACHE]: records });
    assert.deepEqual(await service.get([1]), {});
    assert.equal(f.session[TAB_SWITCHER_PREVIEW_CACHE], undefined);

    const g = fixture();
    const ready = g.worker();
    await ready.capture(g.active);
    await ready.get([1]);
    g.emit('removed', 1);
    assert.deepEqual(await ready.get([1]), {});
    assert.equal(g.session[TAB_SWITCHER_PREVIEW_CACHE], undefined);
});

test('capture rate, permission removal, site refusal and expiry fall back safely', async () => {
    const f = fixture();
    const service = f.worker();
    for (let index = 0; index < 3; index++) {
        await service.capture(f.active);
        await service.get([1]);
    }
    assert.equal(f.calls.length, 2);
    f.advance(1000);
    f.chrome.tabs.captureVisibleTab = async () => { throw new Error('Fixture blocks capture'); };
    const denied = await service.capture(f.active);
    await denied.preview;
    assert.deepEqual(await service.get([1]), {});
    assert.equal(f.session[TAB_SWITCHER_PREVIEW_CACHE], undefined);

    const records = { 1: { data: reducedImage, expiresAt: 150_000 } };
    const g = fixture();
    const restored = g.worker();
    await restored.capture(g.active);
    assert.deepEqual(await restored.get([1]), { 1: reducedImage });
    g.advance(600_000);
    g.emit('alarm', { name: 'tabSwitcherPreviewExpiry' });
    assert.deepEqual(await restored.get([1]), {});
    assert.equal(g.session[TAB_SWITCHER_PREVIEW_CACHE], undefined);

    const h = fixture({}, { [TAB_SWITCHER_PREVIEW_CACHE]: records });
    const pending = h.worker();
    h.emit('permission-removed', { permissions: ['activeTab'] });
    await pending.cacheWork;
    assert.deepEqual(await pending.get([1]), {});
    assert.equal(h.session[TAB_SWITCHER_PREVIEW_CACHE], undefined);
});

test('ordinary visits require both the app opt-in and the browser all-sites grant', async () => {
    const withoutPreference = fixture();
    withoutPreference.grant(true);
    const first = withoutPreference.worker();
    const withoutGrant = fixture({ [TAB_SWITCHER_CAPTURE_ON_VISIT]: true });
    const second = withoutGrant.worker();
    for (const f of [withoutPreference, withoutGrant]) {
        f.emit('activated', { tabId: 1, windowId: 4 });
        f.emit('focus', 4);
        f.emit('updated', 1, { status: 'complete' }, f.active);
    }
    await wait(250);
    assert.deepEqual(withoutPreference.calls, []);
    assert.deepEqual(withoutGrant.calls, []);
    await second.capture(withoutGrant.active);
    assert.deepEqual(await second.get([1]), { 1: reducedImage });
    assert.deepEqual(await first.get([1]), {});
});

test('opted-in normal visits supply up to five images before the shortcut is used', async () => {
    const f = fixture({ [TAB_SWITCHER_CAPTURE_ON_VISIT]: true });
    f.grant(true);
    const previews = f.worker();
    await previews.ready;

    // Passing briefly over a tab must not start a capture that races the
    // next foreground tab, including when the two have identical URLs.
    f.emit('activated', { tabId: 1, windowId: 4 });
    f.select({ id: 2 });
    f.emit('activated', { tabId: 2, windowId: 4 });
    await wait(230);
    assert.deepEqual(await previews.get([1, 2]), { 2: reducedImage });
    assert.equal(f.calls.length, 1);

    for (let id = 3; id <= 8; id++) {
        f.advance(1100);
        f.select({ id });
        f.emit('activated', { tabId: id, windowId: 4 });
        await wait(230);
        await previews.get([id]);
    }
    const wanted = [1, 2, 3, 4, 5, 6, 7, 8];
    assert.deepEqual(Object.keys(await previews.get(wanted)).map(Number), [4, 5, 6, 7, 8]);
    assert.equal(Object.keys(f.session[TAB_SWITCHER_PREVIEW_CACHE]).length, 5);
    assert.equal(JSON.stringify(f.session).includes('example.test'), false);

    f.advance(1100);
    f.select({ id: 8, url: 'http://example.test/new', status: 'loading' });
    f.emit('updated', 8, { status: 'loading', url: f.active.url }, f.active);
    assert.deepEqual(await previews.get([8]), {});
    f.select({ id: 8, url: 'http://example.test/new' });
    f.emit('updated', 8, { status: 'complete' }, f.active);
    await wait(230);
    assert.deepEqual(await previews.get([8]), { 8: reducedImage });

    f.grant(false);
    f.emit('permission-removed', { origins: ['<all_urls>'] });
    assert.deepEqual(await previews.get(wanted), {});
    assert.equal(f.session[TAB_SWITCHER_PREVIEW_CACHE], undefined);
    f.advance(1100);
    await previews.capture(f.active);
    assert.deepEqual(await previews.get([8]), { 8: reducedImage });
});

test('enabling ordinary previews schedules the current web tab without another visit', async () => {
    for (const grantFirst of [false, true]) {
        const f = fixture();
        const service = f.worker();
        await service.ready;
        const grant = () => {
            f.grant(true);
            f.emit('permission-added', { origins: ['<all_urls>'] });
        };
        const enable = () => f.emit('storage', { [TAB_SWITCHER_CAPTURE_ON_VISIT]: { newValue: true } }, 'local');
        (grantFirst ? grant : enable)();
        await new Promise(resolve => setImmediate(resolve));
        (grantFirst ? enable : grant)();
        await wait(260);
        assert.deepEqual(await service.get([1]), { 1: reducedImage });
        assert.equal(f.calls.length, 1);
    }
});

test('a settled visit can submit outside the key handoff budget and keep its verified frame after switching', async () => {
    const f = fixture({ [TAB_SWITCHER_CAPTURE_ON_VISIT]: true });
    f.grant(true);
    const service = f.worker();
    await service.permissionReady;
    const getWindow = f.chrome.windows.get;
    f.chrome.windows.get = async () => {
        await wait(45);
        return getWindow();
    };
    const image = deferred();
    f.chrome.tabs.captureVisibleTab = async (window, details) => {
        f.calls.push([window, details]);
        return image.promise;
    };

    await service.capture(f.active, true);
    assert.equal(f.calls.length, 1);
    f.select({ id: 2 });
    f.emit('activated', { tabId: 2, windowId: 4 });
    f.emit('focus', 5);
    image.resolve('fixture raw bytes');
    assert.deepEqual(await service.get([1, 2]), { 1: reducedImage });
});

test('an active same-document URL update can settle in the dwell window without a load event', async () => {
    const f = fixture({ [TAB_SWITCHER_CAPTURE_ON_VISIT]: true });
    f.grant(true);
    const service = f.worker();
    await service.permissionReady;
    await service.capture(f.active, true);
    assert.deepEqual(await service.get([1]), { 1: reducedImage });

    const url = 'http://example.test/another-route';
    f.select({ url, pendingUrl: url });
    f.emit('updated', 1, { url }, f.active);
    assert.deepEqual(await service.get([1]), {});
    f.select({ url });
    await wait(260);
    assert.deepEqual(await service.get([1]), { 1: reducedImage });
    assert.equal(f.calls.length, 2);
});

test('a transient refresh failure keeps the last frame, while a browser denial evicts it', async () => {
    const f = fixture();
    let resizeFails = false;
    const service = f.worker(async () => resizeFails ? null : reducedImage);
    await service.capture(f.active);
    assert.deepEqual(await service.get([1]), { 1: reducedImage });

    resizeFails = true;
    f.advance(1100);
    await service.capture(f.active);
    assert.deepEqual(await service.get([1]), { 1: reducedImage });

    f.advance(1100);
    f.chrome.tabs.captureVisibleTab = async () => { throw new Error('Failed to capture tab: image readback failed'); };
    await service.capture(f.active);
    assert.deepEqual(await service.get([1]), { 1: reducedImage });

    f.advance(1100);
    f.chrome.tabs.captureVisibleTab = async () => { throw new Error('Fixture policy blocks capture'); };
    const denied = await service.capture(f.active);
    await denied.preview;
    assert.deepEqual(await service.get([1]), {});
});

test('an in-flight verified visit cannot restore a frame after the tab navigates', async () => {
    const f = fixture({ [TAB_SWITCHER_CAPTURE_ON_VISIT]: true });
    f.grant(true);
    const service = f.worker();
    await service.permissionReady;
    const image = deferred();
    f.chrome.tabs.captureVisibleTab = () => image.promise;
    await service.capture(f.active, true);
    f.select({ id: 2 });
    f.emit('activated', { tabId: 2, windowId: 4 });
    f.live.set(1, { ...webTab, url: 'http://example.test/signed-out', active: false });
    f.emit('updated', 1, { url: f.live.get(1).url }, f.live.get(1));
    image.resolve('late bytes from before navigation');
    await service.cacheWork;
    assert.deepEqual(await service.get([1]), {});
});

test('browser quota defers at most one retry for the same foreground visit', async context => {
    context.mock.timers.enable({ apis: ['setTimeout'] });
    const optIn = { [TAB_SWITCHER_CAPTURE_ON_VISIT]: true };
    const f = fixture(optIn);
    f.grant(true);
    const service = f.worker();
    await service.permissionReady;
    let attempts = 0;
    f.chrome.tabs.captureVisibleTab = async () => {
        attempts++;
        if (attempts === 1) throw new Error('This request exceeds the MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND quota.');
        return 'fixture raw data';
    };
    // Flush promises around each timer tick. The native capture remains
    // foreground and the unrelated shortcut command is never invoked.
    f.emit('activated', { tabId: 1, windowId: 4 });
    const flush = () => new Promise(resolve => setImmediate(resolve));
    await flush();
    context.mock.timers.tick(200);
    await flush();
    assert.equal(attempts, 1);
    f.advance(1000);
    context.mock.timers.tick(1000);
    await flush();
    assert.equal(attempts, 2);
    assert.deepEqual(await service.get([1]), { 1: reducedImage });
});

test('excluded sites cover subdomains, keep lookalike sites eligible, and clear previous captures', async () => {
    assert.deepEqual(parsePreviewDomains('EXAMPLE.test, example.test portal.test'), ['example.test', 'portal.test']);
    for (const invalid of ['*', 'https://example.test', '.test', 'example.test/path']) {
        assert.throws(() => parsePreviewDomains(invalid));
    }
    const f = fixture({ [TAB_SWITCHER_EXCLUDED_DOMAINS]: ['example.test'] });
    const previews = f.worker();
    for (const host of ['example.test', 'news.example.test', 'news.example.test.']) {
        f.select({ url: 'https://' + host });
        await previews.capture(f.active);
    }
    assert.equal(f.calls.length, 0);
    f.select({ url: 'https://anotherexample.test/' });
    await previews.capture(f.active);
    assert.deepEqual(await previews.get([1]), { 1: reducedImage });
    f.emit('storage', { [TAB_SWITCHER_EXCLUDED_DOMAINS]: { newValue: ['anotherexample.test'] } }, 'local');
    assert.deepEqual(await previews.get([1]), {});
    assert.equal(f.session[TAB_SWITCHER_PREVIEW_CACHE], undefined);
});

test('unrelated local storage traffic during worker startup preserves existing thumbnails', async () => {
    const f = fixture();
    const first = f.worker();
    await first.capture(f.active);
    assert.deepEqual(await first.get([1]), { 1: reducedImage });
    const ready = deferred();
    f.chrome.storage.local.get = () => ready.promise;
    const service = f.worker();
    f.emit('storage', { spaces: { newValue: [] } }, 'local');
    ready.resolve({});
    assert.deepEqual(await service.get([1]), { 1: reducedImage });
});

test('an already opted-in worker fills a missing foreground thumbnail and retries a transient readback once', async context => {
    context.mock.timers.enable({ apis: ['setTimeout'] });
    const drain = () => new Promise(resolve => setImmediate(resolve));
    const f = fixture({ [TAB_SWITCHER_CAPTURE_ON_VISIT]: true });
    f.grant(true);
    let attempts = 0;
    f.chrome.tabs.captureVisibleTab = async () => {
        if (++attempts === 1) throw new Error('Failed to capture tab: image readback failed');
        return 'fixture raw bytes';
    };
    const service = f.worker();
    await drain();
    context.mock.timers.tick(200);
    await drain();
    assert.equal(attempts, 1);
    f.advance(1000);
    context.mock.timers.tick(1000);
    await drain();
    assert.equal(attempts, 2);
    assert.deepEqual(await service.get([1]), { 1: reducedImage });
});


test('a detailed frame that exceeds the JPEG cap is resized again before storage', async t => {
    const f = fixture();
    const dimensions = [];
    const priorBitmap = globalThis.createImageBitmap;
    const priorCanvas = globalThis.OffscreenCanvas;
    t.after(() => {
        if (priorBitmap) globalThis.createImageBitmap = priorBitmap;
        else delete globalThis.createImageBitmap;
        if (priorCanvas) globalThis.OffscreenCanvas = priorCanvas;
        else delete globalThis.OffscreenCanvas;
    });
    globalThis.createImageBitmap = async () => ({ width: 1536, height: 960, close() {} });
    globalThis.OffscreenCanvas = class {
        constructor(width, height) { this.width = width; this.height = height; }
        getContext() { return { drawImage() {} }; }
        async convertToBlob() {
            dimensions.push([this.width, this.height]);
            const size = dimensions.length === 1 ? 41 * 1024 : 20 * 1024;
            return new Blob([new Uint8Array(size)], { type: 'image/jpeg' });
        }
    };
    f.chrome.tabs.captureVisibleTab = async () => reducedImage;
    const service = new TabSwitcherPreviews(f.chrome);
    service.register();
    await service.capture(f.active);
    const frames = await service.get([f.active.id]);
    assert.ok(frames[1]?.startsWith('data:image/jpeg;base64,'));
    assert.deepEqual(dimensions, [[384, 240], [192, 120]]);
});

test('a denied foreground capture is never retried on the same visit', async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const f = fixture({ [TAB_SWITCHER_CAPTURE_ON_VISIT]: true });
    f.grant(true);
    let attempts = 0;
    f.chrome.tabs.captureVisibleTab = async () => {
        attempts++;
        throw new Error('Capture is disabled by policy');
    };
    const service = f.worker();
    const drain = () => new Promise(resolve => setImmediate(resolve));
    await drain();
    t.mock.timers.tick(200);
    await drain();
    f.advance(1500);
    t.mock.timers.tick(1500);
    await drain();
    assert.equal(attempts, 1);
    assert.deepEqual(await service.get([1]), {});
});

test('browsing thumbnails outlive ten minutes and worker sleep, then navigation deletes the encrypted record', async () => {
    const f = fixture({ [TAB_SWITCHER_CAPTURE_ON_VISIT]: true });
    f.grant(true);
    const service = f.worker();
    await service.permissionReady;
    await service.capture(f.active, true);
    assert.deepEqual(await service.get([1]), { 1: reducedImage });
    const record = f.session[TAB_SWITCHER_PREVIEW_CACHE][1];
    assert.deepEqual(Object.keys(record).sort(), ['capturedAt', 'ref', 'visit']);
    assert.match(record.ref, /:d:/);
    assert.deepEqual(Object.keys(f.local[record.ref]).sort(), ['ciphertext', 'iv']);
    for (const stored of [f.local, f.session]) {
        assert.ok(!JSON.stringify(stored).includes(reducedImage.slice(reducedImage.indexOf(',') + 1)));
        assert.ok(!JSON.stringify(stored).includes('example.test'));
    }
    f.advance(24 * 3_600_000);
    const restarted = f.worker();
    assert.deepEqual(await restarted.get([1]), { 1: reducedImage });
    f.emit('updated', 1, { status: 'loading' });
    assert.deepEqual(await restarted.get([1]), {});
    assert.equal(f.local[record.ref], undefined);
});

test('a cold browser session purges unreadable ciphertext and drops legacy plaintext thumbnails', async () => {
    const f = fixture({ [TAB_SWITCHER_CAPTURE_ON_VISIT]: true });
    f.grant(true);
    const service = f.worker();
    await service.permissionReady;
    await service.capture(f.active, true);
    assert.deepEqual(await service.get([1]), { 1: reducedImage });
    const ref = f.session[TAB_SWITCHER_PREVIEW_CACHE][1].ref;
    assert.ok(f.local[ref]);
    const cold = fixture(f.local, {
        [TAB_SWITCHER_PREVIEW_CACHE]: { 1: { data: reducedImage, expiresAt: 190_000 } },
    });
    const restarted = cold.worker();
    assert.deepEqual(await restarted.get([1]), {});
    assert.equal(cold.local[ref], undefined);
    assert.equal(cold.session[TAB_SWITCHER_PREVIEW_CACHE], undefined);
});

test('withdrawn browsing permission during encryption discards the unpublished record', async () => {
    const f = fixture({ [TAB_SWITCHER_CAPTURE_ON_VISIT]: true });
    f.grant(true);
    const service = f.worker();
    await service.cacheWork;
    const gate = deferred();
    const started = deferred();
    const write = service.store.put.bind(service.store);
    let ref;
    service.store.put = async (...args) => {
        ref = await write(...args);
        started.resolve();
        await gate.promise;
        return ref;
    };
    const job = await service.capture(f.active, true);
    await started.promise;
    f.grant(false);
    f.emit('permission-removed', { origins: ['<all_urls>'] });
    gate.resolve();
    await job.preview;
    assert.deepEqual(await service.get([1]), {});
    assert.equal(f.local[ref], undefined);
    assert.equal(f.session[TAB_SWITCHER_PREVIEW_CACHE], undefined);
});

test('decryption is limited to requested, eligible cards and navigation discards a late decryption', async () => {
    const f = fixture();
    const service = f.worker();
    for (const id of [1, 2]) {
        f.select({ id });
        await service.capture(f.active);
        assert.deepEqual(await service.get([id]), { [id]: reducedImage });
    }
    f.live.get(2).incognito = true;
    const read = service.store.read.bind(service.store);
    const gate = deferred();
    const started = deferred();
    const reads = [];
    service.store.read = async ref => {
        reads.push(ref);
        const data = await read(ref);
        started.resolve();
        await gate.promise;
        return data;
    };
    assert.deepEqual(await service.get([2, 12]), {});
    assert.deepEqual(reads, []);
    const pending = service.get([1, 2]);
    await started.promise;
    f.emit('updated', 1, { status: 'loading' });
    gate.resolve();
    assert.deepEqual(await pending, {});
    assert.equal(reads.length, 1);
});

test('a shortcut capture submitted before opt-in stays in session memory through a later grant', async () => {
    const f = fixture();
    const service = f.worker();
    const gate = deferred();
    f.chrome.tabs.captureVisibleTab = () => gate.promise;
    const job = await service.capture(f.active);
    f.grant(true);
    f.emit('permission-added', { origins: ['<all_urls>'] });
    f.emit('storage', { [TAB_SWITCHER_CAPTURE_ON_VISIT]: { newValue: true } }, 'local');
    await service.permissionReady;
    gate.resolve('fixture');
    await job.preview;
    assert.match(f.session[TAB_SWITCHER_PREVIEW_CACHE][1].ref, /:s:/);
    assert.deepEqual(f.local, {});
    service.stopQueuedVisit();
});

test('ready cards paint without waiting for a pending refresh or another card’s first image', async () => {
    const f = fixture();
    const service = f.worker();
    const original = await service.capture(f.active);
    await original.preview;
    for (const id of [1, 2]) {
        f.advance(1100);
        f.select({ id });
        const incoming = deferred();
        f.chrome.tabs.captureVisibleTab = () => incoming.promise;
        const capture = await service.capture(f.active);
        const visible = await Promise.race([service.get([1, 2]), wait(150).then(() => 'still waiting')]);
        incoming.resolve('fixture');
        await capture.preview;
        assert.deepEqual(visible, { 1: reducedImage });
    }
    assert.deepEqual(await service.get([1, 2]), { 1: reducedImage, 2: reducedImage });
});

test('a shortcut reuses a fresh browsing frame until navigation or its freshness window ends', async () => {
    const f = fixture({ [TAB_SWITCHER_CAPTURE_ON_VISIT]: true });
    f.grant(true);
    const service = f.worker();
    await service.cacheWork;
    const visit = await service.capture(f.active, true);
    await visit.preview;
    await service.capture(f.active);
    assert.equal(f.calls.length, 1);
    f.advance(2600);
    const refresh = await service.capture(f.active);
    await refresh.preview;
    assert.equal(f.calls.length, 2);
    f.select({ url: 'https://example.test/new' });
    f.emit('updated', 1, { url: f.active.url }, f.active);
    const afterNavigation = await service.capture(f.active);
    await afterNavigation.preview;
    assert.equal(f.calls.length, 3);
    service.stopQueuedVisit();
});
