import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tabAudioState, updateTabAudioIndicator, updateWindowTabAudio, isAudioOnlyTabChange, TabAudioEvents } from '../../tab-audio.js';

test('audio-only events bypass structural refresh while mixed native changes retain it', () => {
    for (const change of [{ audible: false }, { mutedInfo: { muted: true } }, { audible: true, mutedInfo: { muted: false } }]) assert.equal(isAudioOnlyTabChange(change), true);
    for (const change of [{}, { title: 'Changed' }, { audible: true, pinned: true }, { audible: false, status: 'loading' }]) assert.equal(isAudioOnlyTabChange(change), false);
});

test('audio state distinguishes native mute from recent sound and rejects non-live identities', () => {
    assert.equal(tabAudioState({ id: 1, audible: true }), 'audible');
    assert.equal(tabAudioState({ id: 1, audible: true, mutedInfo: { muted: true } }), 'muted');
    assert.equal(tabAudioState({ id: 1, audible: false, mutedInfo: { muted: true } }), 'muted');
    for (const tab of [undefined, { id: null, audible: true }, { id: -1, audible: true }, { id: 1 }, { id: 1, audible: false }]) {
        assert.equal(tabAudioState(tab), null);
    }
});

function host(favorite = false) {
    const ownerDocument = {
        createElement(tagName) {
            return {
                tagName, dataset: {}, attributes: {}, listeners: {}, isConnected: true,
                setAttribute(name, value) { this.attributes[name] = value; },
                addEventListener(type, listener) { this.listeners[type] = listener; },
                focus() { ownerDocument.activeElement = this; },
            };
        },
    };
    const parent = {
        children: [],
        querySelector(selector) {
            if (!selector.includes('.tab-audio-indicator')) return null;
            return this.children.find(child => child.className === 'tab-audio-indicator');
        },
        insertBefore(child) {
            this.children.push(child);
            child.remove = () => {
                child.isConnected = false;
                this.children = this.children.filter(node => node !== child);
            };
        },
    };
    const element = {
        ...parent, children: [],
        dataset: favorite ? { audioBaseTitle: 'Saved favorite\nhttps://example.test/\nDouble-click to return to saved URL' } : {},
        title: '', attributes: {},
        classList: { contains: name => favorite && name === 'pinned-favicon' },
        closest(selector) { return favorite && selector === '.favorite-tile' ? parent : null; },
        querySelector(selector) {
            if (selector === '.tab-title-display') return { textContent: 'A renamed tab' };
            return parent.querySelector.call(this, selector);
        },
        setAttribute(name, value) { this.attributes[name] = value; },
        focus() { ownerDocument.activeElement = this; },
        ownerDocument,
    };
    return element;
}

test('live updates preserve the sound button as a sibling of a Favorite and keep its accessible title', () => {
    const element = host(true);
    const tile = element.closest('.favorite-tile');
    updateTabAudioIndicator(element, { id: 7, audible: true, title: 'Saved favorite' });
    assert.equal(element.children.length, 0);
    assert.equal(tile.children.length, 1);
    const [button] = tile.children;
    assert.equal(button.tagName, 'button');
    assert.equal(button.attributes['aria-label'], 'Mute tab: A renamed tab');
    assert.match(element.attributes['aria-label'], /Double-click to return to saved URL\nPlaying audio$/);
    updateTabAudioIndicator(element, { id: 7, audible: true, mutedInfo: { muted: true } });
    assert.equal(tile.children[0], button);
    assert.equal(button.attributes['aria-label'], 'Unmute tab: A renamed tab');
    assert.doesNotMatch(element.title, /Playing audio/);
    button.focus();
    updateTabAudioIndicator(element, { id: 7, audible: false, mutedInfo: { muted: false } });
    assert.equal(tile.children.length, 0);
    assert.equal(element.ownerDocument.activeElement, element);
    assert.equal(element.title, element.dataset.audioBaseTitle);
    assert.equal(element.dataset.audioState, undefined);
});

test('speaker actions check fresh mute state and never change activation or another window', async () => {
    const element = host();
    const actions = [];
    let current = { id: 7, windowId: 1, audible: true, mutedInfo: { muted: true } };
    const chromeApi = { tabs: {
        get: async () => current,
        update: async (id, changes) => actions.push([id, changes]),
    } };
    updateTabAudioIndicator(element, { ...current, mutedInfo: { muted: false } }, { chromeApi });
    const [button] = element.children;
    const click = { stopPropagation() {} };
    await button.listeners.click(click);
    assert.deepEqual(actions, [[7, { muted: false }]], 'The native state wins over the last painted badge');
    current = { ...current, windowId: 2 };
    await button.listeners.click(click);
    current = { ...current, windowId: 1, mutedInfo: { muted: false }, audible: false };
    await button.listeners.click(click);
    assert.equal(actions.length, 1);
});

test('offline bookmarks never inherit audio and updates stay within the native owning window', () => {
    const element = host();
    updateTabAudioIndicator(element, { id: 7, audible: true }, { live: false });
    assert.equal(element.children.length, 0);
    updateWindowTabAudio({ querySelectorAll() { assert.fail('Other-window audio must not alter this sidebar'); } }, { id: 7, windowId: 2, audible: true }, 1);
    const other = host();
    updateWindowTabAudio({ querySelectorAll: () => [element, other] }, { id: 7, windowId: 1, audible: true }, 1);
    assert.equal(element.dataset.audioState, 'audible');
    assert.equal(other.dataset.audioState, 'audible');
    assert.match(element.title, /^A renamed tab\nPlaying audio$/);
});

test('audio updates retain existing nonaudio safety tooltips', () => {
    const element = host();
    updateTabAudioIndicator(element, { id: 1, audible: true });
    element.title = 'Favorite controls are unavailable until the bookmark folder is restored.';
    updateTabAudioIndicator(element, { id: 1, audible: true, mutedInfo: { muted: true } });
    assert.match(element.title, /^Favorite controls are unavailable[\s\S]*\nMuted$/);
    updateTabAudioIndicator(element, { id: 1, audible: false });
    assert.equal(element.title, 'Favorite controls are unavailable until the bookmark folder is restored.');
});

test('later native audio events win over held snapshots without persisting stale tab entries', () => {
    const events = new TabAudioEvents();
    const silent = { id: 1, windowId: 7, audible: false, mutedInfo: { muted: false } };
    const start = events.revision;
    events.record({ ...silent, audible: true }, 7);
    assert.equal(events.apply(silent, start).audible, true);
    const next = events.revision;
    events.record({ ...silent, audible: true, mutedInfo: { muted: true } }, 7);
    assert.equal(events.reconcileWindow([silent], next)[0].mutedInfo.muted, true);
    assert.equal(events.apply(silent, events.revision).audible, false, 'Fresh snapshots supersede older events');
    events.record({ ...silent, id: 2, windowId: 8 }, 7);
    assert.equal(events.latest.has(2), false);
    events.reconcileWindow([], events.revision);
    assert.equal(events.latest.size, 0);
    events.record(silent, 7); events.forget(1);
    assert.equal(events.latest.size, 0);
});

test('closed/detached tabs cannot be resurrected by older held reads and tombstones are released', async () => {
    const events = new TabAudioEvents();
    let release;
    const pending = events.read(() => new Promise(resolve => { release = resolve; }));
    events.forget(9);
    await events.read(async () => [], true);
    assert.equal(events.removed.has(9), true, 'An older read still needs the removal boundary');
    release([{ id: 9, windowId: 1, audible: true }]);
    assert.deepEqual(await pending, []);
    assert.equal(events.removed.size, 0);
    assert.equal(events.reads.size, 0);
});
