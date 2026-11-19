import test from 'node:test';
import assert from 'node:assert/strict';
import { withTabCloseMotion, withRemovedTabMotion } from '../../tab-close-motion.js';

function fixture({ reduced = false, animationFails = false } = {}) {
    const classes = new Set();
    let finish;
    const animation = { finished: new Promise(resolve => { finish = resolve; }),
        cancelled: false, cancel() { this.cancelled = true; }, finish() { finish(); } };
    const row = {
        classList: { contains: c => classes.has(c), add: c => classes.add(c), remove: c => classes.delete(c) },
        ownerDocument: { defaultView: {
            matchMedia: () => ({ matches: reduced }),
            getComputedStyle: () => ({ height: '28px', paddingTop: '4px', paddingBottom: '4px', marginBottom: '4px' })
        } },
        getClientRects: () => [{}],
        animate() { if (animationFails) throw new Error('Unavailable'); return animation; }
    };
    return { row, animation, finish };
}

test('close waits for motion, ignores repeat clicks, and keeps the final frame for the removal listener', async () => {
    const { row, animation, finish } = fixture();
    let calls = 0;
    const close = () => { calls++; };
    const pending = withTabCloseMotion(row, close);
    await withTabCloseMotion(row, close);
    assert.equal(calls, 0);
    finish();
    await pending;
    assert.equal(calls, 1);
    assert.equal(animation.cancelled, false);
    assert.equal(row.classList.contains('tab-closing'), true);
});

test('a failed close restores the row and permits retry', async () => {
    const { row, animation, finish } = fixture();
    const pending = withTabCloseMotion(row, () => { throw new Error('Close denied'); });
    finish();
    await assert.rejects(pending, /Close denied/);
    assert.equal(animation.cancelled, true);
    assert.equal(row.classList.contains('tab-closing'), false);
    await withTabCloseMotion(row, () => {});
});

test('reduced motion closes immediately without animation', async () => {
    const { row } = fixture({ reduced: true });
    row.animate = () => assert.fail('Reduced motion must not animate');
    let closed = false;
    await withTabCloseMotion(row, () => { closed = true; });
    assert.equal(closed, true);
});

test('hidden rows and unavailable animation still close', async () => {
    for (const hidden of [true, false]) {
        const { row } = fixture({ animationFails: true });
        if (hidden) row.getClientRects = () => [];
        let closed = false;
        await withTabCloseMotion(row, () => { closed = true; });
        assert.equal(closed, true);
        assert.equal(row.classList.contains('tab-closing'), false);
    }
});

test('a suspended animation timeline cannot hold up closing', async () => {
    const { row } = fixture();
    let closed = false;
    await withTabCloseMotion(row, () => { closed = true; });
    assert.equal(closed, true);
});

test('native removal animates a visible row before reconciling its projection', async () => {
    const { row, finish } = fixture();
    let reconciled = false;
    const pending = withRemovedTabMotion(row, () => { reconciled = true; });
    assert.equal(reconciled, false);
    finish();
    await pending;
    assert.equal(reconciled, true);
});

test('native reconciliation does not repeat motion after an explicit close', async () => {
    const { row, finish } = fixture();
    let animations = 0, reconciled = 0;
    const animate = row.animate;
    row.animate = (...args) => { animations++; return animate(...args); };
    const pending = withTabCloseMotion(row, () => withRemovedTabMotion(row, () => { reconciled++; }));
    finish();
    await pending;
    assert.equal(animations, 1);
    assert.equal(reconciled, 1);
    await withRemovedTabMotion(null, () => { reconciled++; });
    assert.equal(reconciled, 2);
});

test('a reduced-motion native removal reconciles immediately', async () => {
    const { row } = fixture({ reduced: true });
    row.animate = () => assert.fail('Reduced motion must not animate');
    let reconciled = false;
    await withRemovedTabMotion(row, () => { reconciled = true; });
    assert.equal(reconciled, true);
});
