import assert from 'node:assert/strict';
import { test } from 'node:test';
import { captureCrop, ElementCapture } from '../../element-capture.js';

test('maps the clipped CSS bounds to the actual screenshot pixel grid', () => {
    const viewport = { width: 100, height: 80 };
    const bitmap = { width: 201, height: 160 };
    assert.deepEqual(captureCrop({ x: 10.2, y: 15.2, width: 25.5, height: 30.6 }, viewport, bitmap),
        { x: 21, y: 30, width: 51, height: 62 });
    assert.deepEqual(captureCrop({ x: -12, y: 70, width: 62, height: 25 }, viewport, bitmap),
        { x: 0, y: 140, width: 101, height: 20 });
    for (const rect of [
        { x: NaN, y: 15, width: 25, height: 30 },
        { x: 0, y: 0, width: 0.01, height: 30 },
        { x: 100, y: 15, width: 25, height: 30 },
    ]) assert.throws(() => captureCrop(rect, viewport, bitmap));
    assert.throws(() => captureCrop({ x: 5, y: 5, width: 20, height: 20 }, viewport,
        { width: 10_000, height: 10_000 }));
});

function fixture(t) {
    const tab = { id: 11, windowId: 3, active: true, url: 'https://example.test/fixture' };
    const sender = {
        id: 'prismarc', frameId: 0, documentId: 'frame', documentLifecycle: 'active', tab,
        url: tab.url, origin: 'https://example.test',
    };
    const viewport = { width: 800, height: 600, url: tab.url };
    const sent = [];
    const scriptCalls = [];
    const screenshots = [];
    let onFocusChanged;
    const chrome = {
        runtime: { id: 'prismarc' },
        permissions: { request: async () => true },
        windows: {
            onFocusChanged: { addListener(listener) { onFocusChanged = listener; } },
            get: async () => ({ focused: true, type: 'normal', tabs: [tab] }),
        },
        tabs: {
            sendMessage: async (tabId, message, target) => {
                sent.push({ tabId, message, target });
                return { success: true };
            },
            captureVisibleTab: async (...call) => { screenshots.push(call); },
        },
        scripting: {
            executeScript: async call => {
                scriptCalls.push(call);
                return [{ frameId: 0, documentId: 'frame', result: viewport }];
            },
        },
    };
    const capture = new ElementCapture(chrome);
    capture.register();
    t.after(() => onFocusChanged(-1));
    return { capture, chrome, tab, sender, sent, scriptCalls, screenshots };
}

test('permits the bundled picker in the exact source document and invalidates its token on cancel', async t => {
    const { capture, tab, sender, sent, scriptCalls, screenshots } = fixture(t);
    assert.equal(await capture.start(tab), true);
    assert.deepEqual(scriptCalls, [{ target: { tabId: tab.id }, files: ['capture-picker.js'], world: 'ISOLATED' }]);
    assert.deepEqual(sent[0].target, { documentId: sender.documentId });
    const { token } = sent[0].message;
    const cancel = { type: 'elementCaptureCancel', token };
    const selection = {
        type: 'elementCaptureSelection', token, viewportWidth: 800, viewportHeight: 600,
        rect: { x: 15, y: 25, width: 40, height: 50 },
    };
    for (const alteredSender of [
        { ...sender, id: 'unrelated-extension' },
        { ...sender, frameId: 1 },
        { ...sender, documentId: 'replacement' },
        { ...sender, documentLifecycle: 'cached' },
        { ...sender, url: 'https://different.test/', origin: 'https://different.test' },
        { ...sender, url: 'https://different.test/' },
        { ...sender, tab: { ...sender.tab, id: 12 } },
        { ...sender, tab: { ...sender.tab, windowId: 4 } },
    ]) assert.equal(capture.receive(selection, alteredSender), undefined);
    assert.equal(capture.receive({ ...selection, token: 'wrong' }, sender), undefined);
    assert.equal(capture.coversTab(tab.id), true);
    // Chrome can retain the document's first URL in a content script sender after pushState.
    assert.deepEqual(await capture.receive(cancel, { ...sender, url: `${sender.origin}/original-route` }), { success: true });
    assert.equal(capture.coversTab(tab.id), false);
    assert.equal(capture.receive(selection, sender), undefined);
    assert.deepEqual(screenshots, []);
});

test('discards a capture when Chrome replaces the source document during screenshot readback', async t => {
    const { capture, chrome, tab, sender, sent, scriptCalls, screenshots } = fixture(t);
    const takeScreenshot = chrome.tabs.captureVisibleTab;
    let releaseScreenshot;
    const readbackStarted = new Promise(resolve => {
        chrome.tabs.captureVisibleTab = async (...call) => {
            await takeScreenshot(...call);
            return new Promise(release => {
                releaseScreenshot = release;
                resolve();
            });
        };
    });
    assert.equal(await capture.start(tab), true);
    const selection = capture.receive({
        type: 'elementCaptureSelection', token: sent[0].message.token, viewportWidth: 800, viewportHeight: 600,
        rect: { x: 15, y: 25, width: 40, height: 50 },
    }, sender);
    await Promise.race([readbackStarted, selection.then(() => assert.fail('The screenshot was never requested.'))]);
    const executeScript = chrome.scripting.executeScript;
    chrome.scripting.executeScript = async call => {
        const result = await executeScript(call);
        return [{ ...result[0], documentId: 'replacement' }];
    };
    t.mock.method(globalThis, 'atob', () => assert.fail('A screenshot from the replacement document must never be decoded.'));
    releaseScreenshot('data:image/png;base64,fixture');
    const result = await selection;
    assert.equal(result.success, false);
    assert.equal(result.png, undefined);
    assert.equal(globalThis.atob.mock.callCount(), 0);
    assert.equal(capture.coversTab(tab.id), false);
    assert.deepEqual(screenshots, [[tab.windowId, { format: 'png' }]]);
    assert.deepEqual(scriptCalls.slice(1).map(call => call.target), [
        { tabId: tab.id, documentIds: [sender.documentId] },
        { tabId: tab.id, documentIds: [sender.documentId] },
    ]);
});

test('a denied scripting grant leaves the page untouched', async t => {
    const { capture, chrome, tab, sent, scriptCalls, screenshots } = fixture(t);
    chrome.permissions.request = async () => false;
    assert.equal(await capture.start(tab), false);
    assert.equal(capture.coversTab(tab.id), false);
    assert.deepEqual(scriptCalls, []);
    assert.deepEqual(sent, []);
    assert.deepEqual(screenshots, []);
});
