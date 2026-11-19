import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../../sidebar.js', import.meta.url), 'utf8');
const start = source.indexOf('async function moveTabToSpace(');
const end = source.indexOf('// The bookmark is the durable favorite', start);
const functionSource = source.slice(start, end).trim();

test('native unpin after closure leaves membership/DOM untouched and releases the move lock', async () => {
    const spaces = [{ id: 'home', temporaryTabs: [8], spaceBookmarks: [9], lastTab: 9 }];
    const before = structuredClone(spaces);
    const processingTabMoves = new Set();
    const move = vm.runInNewContext(`(${functionSource})`, {
        spaces, processingTabMoves,
        chrome: { tabs: { get: async () => { throw new Error('No tab with id: 9.'); } } },
        document: { querySelector() { assert.fail('Closed-tab move must not touch the DOM'); } },
        saveSpaces() { assert.fail('Closed-tab move must not save changed membership'); },
    });
    await move(9, 'home');
    assert.deepEqual(spaces, before);
    assert.equal(processingTabMoves.size, 0);
});

test('other native lookup failures remain visible and release the move lock', async () => {
    const spaces = [{ id: 'home', temporaryTabs: [8], spaceBookmarks: [9], lastTab: 9 }];
    const before = structuredClone(spaces);
    const processingTabMoves = new Set();
    const move = vm.runInNewContext(`(${functionSource})`, {
        spaces, processingTabMoves,
        chrome: { tabs: { get: async () => { throw new Error('Native API unavailable'); } } },
    });
    await assert.rejects(move(9, 'home'), /Native API unavailable/);
    assert.deepEqual(spaces, before);
    assert.equal(processingTabMoves.size, 0);
});

test('a destination removed during native lookup leaves the source membership untouched', async () => {
    const original = { id: 'source', temporaryTabs: [9], spaceBookmarks: [], lastTab: 9 };
    const spaces = [structuredClone(original), { id: 'target', temporaryTabs: [], spaceBookmarks: [] }];
    const processingTabMoves = new Set();
    let release;
    const move = vm.runInNewContext(`(${functionSource})`, {
        spaces, processingTabMoves, Logger: { warn() {} },
        chrome: { tabs: { get: () => new Promise(resolve => { release = resolve; }) } },
        document: { querySelector() { assert.fail('Canceled move must not change DOM'); } },
        saveSpaces() { assert.fail('Canceled move must not save a partial membership change'); },
    });
    const pending = move(9, 'target');
    spaces.pop();
    release({ id: 9, windowId: 1 });
    await pending;
    assert.deepEqual(spaces, [original]);
    assert.equal(processingTabMoves.size, 0);
});
