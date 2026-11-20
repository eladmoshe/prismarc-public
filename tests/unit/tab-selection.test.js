import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getContextTabIds, getTabSelectionRange, getToggledTabSelection } from '../../tab-selection.js';

test('shift selection includes every tab between the anchor and target in either direction', () => {
    const order = [11, 12, 13, 14, 15];
    assert.deepEqual(getTabSelectionRange(order, 12, 15), [12, 13, 14, 15]);
    assert.deepEqual(getTabSelectionRange(order, 15, 12), [12, 13, 14, 15]);
});

test('shift selection falls back to the target when its anchor is no longer visible', () => {
    assert.deepEqual(getTabSelectionRange([11, 12, 13], 99, 12), [12]);
});

test('toggling scattered rows preserves sidebar order and excludes tabs outside the current space', () => {
    const order = [11, 12, 13, 14, 15];
    const selected = getToggledTabSelection(order, new Set([15, 99]), 11);
    assert.deepEqual(selected, [11, 15]);
    assert.deepEqual(getContextTabIds(selected, 15), [11, 15]);
    assert.deepEqual(getContextTabIds(selected, 12), [12]);
    const remaining = getToggledTabSelection(order, new Set(selected), 15);
    assert.deepEqual(remaining, [11]);
    assert.deepEqual(getToggledTabSelection(order, new Set(remaining), 11), []);
});

test('context actions use the group only when the right-clicked tab is selected', () => {
    assert.deepEqual(getContextTabIds(new Set([11, 12, 13]), 12), [11, 12, 13]);
    assert.deepEqual(getContextTabIds(new Set([11, 12, 13]), 14), [14]);
    assert.deepEqual(getContextTabIds(new Set([11]), 11), [11]);
});
