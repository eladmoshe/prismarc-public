import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isZoomLaunchUrl, registerZoomLaunchTabs } from '../../zoom-launch-tabs.js';

const launch = 'https://fixture.zoom.us/j/1001?pwd=fixture#success';
const otherLaunch = 'https://zoom.us/j/1002?jst=fixture';
const key = 'zoomLaunchTabDeadlines';

test('matches only secure Zoom numeric meeting launch routes', () => {
    for (const url of [launch, otherLaunch, 'https://zoom.us/j/123/', 'https://nested.fixture.zoom.us/j/123']) {
        assert.ok(isZoomLaunchUrl(url));
    }
    for (const url of [undefined, 'invalid', 'http://zoom.us/j/123', 'https://zoom.us.example.invalid/j/123',
        'https://notzoom.us/j/123', 'https://zoom.us:8443/j/123', 'https://zoom.us/wc/123/join', 'https://zoom.us/j/123/more',
        'https://zoom.us/j/abc', 'https://fixture@zoom.us/j/123', 'https://zoom.us/join?j=123']) {
        assert.equal(isZoomLaunchUrl(url), false);
    }
});

function event() {
    return { addListener(listener) { this.fire = listener; } };
}

function fixture(tabs = [], stored = {}) {
    let time = 1_000_000;
    const closed = [];
    const open = new Map(tabs.map(tab => [tab.id, tab]));
    const chrome = {
        tabs: {
            onCreated: event(), onUpdated: event(), onRemoved: event(), onReplaced: event(),
            query: async () => [...open.values()],
            get: async id => open.get(id),
            remove: async id => { closed.push(id); open.delete(id); },
        },
        alarms: {
            onAlarm: event(),
            async get(name) { assert.equal(name, key); return this.deadline && { scheduledTime: this.deadline }; },
            async create(name, { when }) { assert.equal(name, key); this.deadline = when; },
            async clear(name) { assert.equal(name, key); this.deadline = undefined; },
        },
        storage: { session: {
            get: async name => ({ [name]: stored[name] }),
            set: async value => { Object.assign(stored, value); },
            remove: async name => { delete stored[name]; },
        } },
    };
    registerZoomLaunchTabs(chrome, error => { throw error; }, () => time);
    return {
        chrome, open, closed, stored,
        drain: () => new Promise(resolve => setImmediate(resolve)),
        advance: milliseconds => { time += milliseconds; },
        fire: () => chrome.alarms.onAlarm.fire({ name: key }),
        navigate(id, url) {
            const tab = { id, url };
            open.set(id, tab);
            return chrome.tabs.onUpdated.fire(id, { url }, tab);
        },
    };
}

test('worker restart restores a deadline, session reset gives an existing tab a full minute', async () => {
    const existing = [{ id: 7, url: launch }];
    const restarted = fixture(existing, { [key]: { 7: 1_010_000, 8: 1_000_000 } });
    await restarted.drain();
    assert.deepEqual(restarted.stored[key], { 7: 1_010_000 });
    await restarted.fire();
    assert.deepEqual(restarted.closed, []);
    restarted.advance(10_000);
    await restarted.fire();
    assert.deepEqual(restarted.closed, [7]);
    assert.equal(restarted.stored[key], undefined);

    const fresh = fixture(existing);
    await fresh.drain();
    assert.deepEqual(fresh.stored[key], { 7: 1_060_000 });
});

test('new launch resets the delay and web-client navigation or removal cancels it', async () => {
    const f = fixture();
    await f.navigate(1, launch);
    f.advance(50_000);
    await f.navigate(1, otherLaunch);
    f.advance(10_000);
    await f.fire();
    assert.deepEqual(f.closed, []);
    assert.equal(f.chrome.alarms.deadline, 1_110_000);
    await f.navigate(1, 'https://zoom.us/wc/1002/join');
    await f.navigate(2, launch);
    await f.chrome.tabs.onRemoved.fire(2);
    f.advance(60_000);
    await f.fire();
    assert.deepEqual(f.closed, []);
    assert.equal(f.chrome.alarms.deadline, undefined);
});

test('pending navigations and replacement tabs are rechecked before closing', async () => {
    const f = fixture([{ id: 5, url: launch }]);
    await f.drain();
    f.advance(60_000);
    f.open.get(5).pendingUrl = 'https://example.invalid/';
    await f.fire();
    assert.deepEqual(f.closed, []);
    assert.equal(f.chrome.alarms.deadline, 1_120_000);
    f.open.set(7, { id: 7, url: otherLaunch });
    await f.chrome.tabs.onReplaced.fire(7, 5);
    assert.deepEqual(f.stored[key], { 7: 1_120_000 });
    f.advance(60_000);
    await f.fire();
    assert.deepEqual(f.closed, [7]);
});

test('a navigation during a multi-tab expiry check protects the new meeting in either tab', async () => {
    const f = fixture([{ id: 5, url: launch }, { id: 6, url: launch }]);
    await f.drain();
    f.advance(60_000);
    let release;
    const entered = new Promise(resolve => {
        f.chrome.tabs.get = async id => {
            const previous = f.open.get(id);
            if (id === 5) {
                resolve();
                await new Promise(unblock => { release = unblock; });
            }
            return previous;
        };
    });
    const sweep = f.fire();
    await entered;
    const sameTab = f.navigate(5, otherLaunch);
    const secondTab = f.navigate(6, otherLaunch);
    release();
    await Promise.all([sweep, sameTab, secondTab]);
    assert.deepEqual(f.closed, []);
    assert.deepEqual(f.stored[key], { 5: 1_120_000, 6: 1_120_000 });
});
