import { test } from 'node:test';
import assert from 'node:assert/strict';
import { numberShortcutIndex, optionDigit } from '../../quick-switcher-keyboard.js';

test('plain numbers address displayed rows two through ten while row one keeps Enter', () => {
    assert.equal(numberShortcutIndex({ key: '1' }, 12), 1);
    assert.equal(numberShortcutIndex({ key: '9' }, 12), 9);
    assert.equal(numberShortcutIndex({ key: '9' }, 9), null);
    assert.equal(numberShortcutIndex({ key: '1' }, 1), null);
    assert.equal(numberShortcutIndex({ key: '1' }, 0), null);
    for (const key of ['0', '10', '!', 'ArrowDown', 'Enter']) assert.equal(numberShortcutIndex({ key }, 30), null);
    assert.equal(numberShortcutIndex({ key: '1', code: 'Numpad1' }, 2), 1);
    assert.equal(numberShortcutIndex({ key: '1', repeat: true }, 2), 1, 'Repeated accelerators can be consumed without entering query text');
});

test('modified, composing and previously handled keystrokes never become result accelerators', () => {
    for (const guard of ['metaKey', 'ctrlKey', 'altKey', 'shiftKey', 'isComposing', 'defaultPrevented']) {
        assert.equal(numberShortcutIndex({ key: '1', [guard]: true }, 9), null, guard);
    }
    assert.equal(numberShortcutIndex({ key: '1', keyCode: 229 }, 9), null);
});

test('Option maps the physical number row to ASCII digits even when the layout produces symbols', () => {
    for (const digit of '0123456789') {
        assert.equal(optionDigit({ key: '¡', code: `Digit${digit}`, altKey: true }), digit);
    }
    assert.equal(optionDigit({ key: '1', code: 'Digit1', altKey: true, repeat: true }), '1');
});

test('Option digits do not override other modifiers, composition, or number-pad entry', () => {
    const event = { key: '¡', code: 'Digit1', altKey: true };
    for (const guard of ['metaKey', 'ctrlKey', 'shiftKey', 'isComposing', 'defaultPrevented']) {
        assert.equal(optionDigit({ ...event, [guard]: true }), null, guard);
    }
    assert.equal(optionDigit({ ...event, keyCode: 229 }), null);
    assert.equal(optionDigit({ ...event, getModifierState: modifier => modifier === 'AltGraph' }), null);
    assert.equal(optionDigit({ ...event, altKey: false }), null);
    assert.equal(optionDigit({ ...event, code: 'Numpad1' }), null);
    assert.equal(optionDigit({ ...event, code: 'KeyA' }), null);
});
