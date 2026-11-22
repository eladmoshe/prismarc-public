import { isTrustedExtensionMessage } from '../../message-security.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { TabSwitcher } from '../../tab-switcher.js';

const source = readFileSync(new URL('../../background.js', import.meta.url), 'utf8')
    .replace(/^import .*;\s*$/gm, '');
function background(completed = false, onboardingVersion = undefined, version = '5.1.0') {
    const installed = [], messages = [], commands = [], opened = [];
    const commandFailures = [];
    const event = { addListener() {} };
    const chrome = {
        runtime: {
            id: 'arcify',
            getURL: path => `chrome-extension://arcify/${path}`,
            onInstalled: { addListener: listener => installed.push(listener) },
            onMessage: { addListener: listener => messages.push(listener) },
            onStartup: event,
            getManifest: () => ({ version })
        },
        sidePanel: { setPanelBehavior: async () => {} },
        commands: { onCommand: { addListener: listener => commands.push(listener) } },
        alarms: { onAlarm: event, get: async () => undefined, clear: async () => {} },
        bookmarks: { onCreated: event, onMoved: event, onChanged: event, onRemoved: event },
        storage: { onChanged: event, local: { get: async () => ({ onboardingCompleted: completed, onboardingVersion }) } },
        tabs: { create: async tab => opened.push(tab), onActivated: event, onUpdated: event, onRemoved: event }
    };
    runInNewContext(source, {
        registerZoomLaunchTabs() {},
        chrome, console, isTrustedExtensionMessage, TabSwitcher, dispatchTourMessage: async () => 'tour',
        TabSwitcherOverlay: class { register() {} receive() {} isOnTab() { return false; } isOverlayFrame() { return false; } },
        TabSwitcherPreviews: class { register() {} },
        registerBookmarkListeners() {}, createCleanTabsHandler: () => () => {},
        SpaceFavorites: class { install() {} async dispatch() { return []; } },
        enqueueBookmarkOperation: async () => ({ orders: {} }),
        SpaceStore: class { install() {} async dispatch() { return [{ id: 'home' }]; } },
        Utils: {
            getSettings: async () => ({ autoArchiveEnabled: false }),
            moveToPrevTabInSpace: async () => { throw new Error('Tab closed during shortcut'); }
        },
        ownerOf: (_spaces, tabId) => tabId === 1 ? { id: 'home' } : undefined,
        Logger: { log() {}, error: (...args) => commandFailures.push(args), context: value => value }
    });
    return { installed, messages, commands, opened, commandFailures, chrome };
}

test('a fresh install opens the onboarding guide once', async () => {
    const app = background();
    await Promise.all(app.installed.map(listener => listener({ reason: 'install' })));
    assert.equal(app.opened.length, 1);
    assert.equal(app.opened[0].url, 'installation-onboarding.html');
    assert.equal(app.opened[0].active, true);
});

test('uncompleted updates and completed installs do not use the same version gate', async () => {
    for (const [reason, completed, expected] of [['update', false, 1], ['install', true, 0]]) {
        const app = background(completed);
        await Promise.all(app.installed.map(listener => listener({ reason })));
        assert.equal(app.opened.length, expected);
    }
});

test('a completed install sees the onboarding once when this extension version changes', async () => {
    const updated = background(true, '5.0.0');
    await Promise.all(updated.installed.map(listener => listener({ reason: 'update', previousVersion: '5.0.0' })));
    assert.equal(updated.opened.length, 1);

    const current = background(true, '5.1.0');
    await Promise.all(current.installed.map(listener => listener({ reason: 'update', previousVersion: '5.0.0' })));
    assert.equal(current.opened.length, 0);
});

test('space-store replies are not intercepted by unrelated Promise listeners', async () => {
    const app = background();
    const replies = [];
    assert.equal(app.messages.length, 1);
    const claims = app.messages.map(listener => listener({ type: 'spaceStore', action: 'get' }, { id: 'arcify' }, reply => replies.push(reply)));
    assert.equal(claims.filter(claim => claim === true).length, 1);
    assert.equal(claims.some(claim => typeof claim?.then === 'function'), false);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(replies.length, 1);
    assert.equal(replies[0].success, true);
    assert.equal(replies[0].spaces[0].id, 'home');
});

test('privileged background listeners ignore untrusted senders before reading or mutating data', async () => {
    const app = background();
    for (const sender of [{}, { id: 'other-extension' }, { id: 'arcify', url: 'https://example.com/' }]) {
        for (const message of [null, { type: 'spaceStore', action: 'get' },
            { type: 'bookmarkOrder', operation: {} }, { type: 'nativeFavorites', action: 'pin' },
            { type: 'sidebarTour', action: 'start' }, { action: 'searchBookmarks', query: '' },
            { action: 'openNewTab', url: 'https://example.com' }, { type: 'openTabSwitcher', action: 'commit' }]) {
            for (const listener of app.messages) {
                assert.equal(listener(message, sender, () => assert.fail('untrusted sender received a reply')), undefined);
            }
        }
    }
    assert.deepEqual(app.opened, []);
});

test('a single trusted router dispatches Favorites and tour and ignores unrelated messages', async () => {
    const { messages: [listen] } = background();
    const sender = { id: 'arcify', url: 'chrome-extension://arcify/sidebar.html' };
    assert.equal(listen({ target: 'offscreen', type: 'copyToClipboard' }, sender, () => assert.fail('Unowned response')), undefined);
    const request = message => new Promise(resolve => assert.equal(listen(message, sender, resolve), true));
    assert.equal((await request({ type: 'nativeFavorites', action: 'get' })).tabs.length, 0);
    assert.equal((await request({ type: 'sidebarTour', action: 'start' })).state, 'tour');
    assert.equal((await request({ type: 'bookmarkOrder', operation: {} })).success, true);
});

test('adjacent-tab shortcuts tolerate no active or owned tab and report navigation failures', async () => {
    const { commands: [command], commandFailures, chrome } = background();
    chrome.tabs.query = async () => [];
    await command('NextTabInSpace');
    await command('NextTabInSpace', { id: 2 });
    assert.equal(commandFailures.length, 0);
    await command('PrevTabInSpace', { id: 1 });
    assert.equal(commandFailures.length, 1);
    assert.equal(commandFailures[0][1].message, 'Tab closed during shortcut');
});
