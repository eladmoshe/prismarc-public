import test from 'node:test';
import assert from 'node:assert/strict';
import { Logger } from '../../logger.js';

test('production errors and warnings are visible without URLs, browser errors or arbitrary arguments', t => {
    const error = t.mock.method(console, 'error', () => {});
    const warn = t.mock.method(console, 'warn', () => {});
    const debug = t.mock.method(console, 'debug', () => {});
    Logger.error(new Error('Could not open https://example.test/?secret=value'));
    Logger.warn('User-named folder', { name: 'Private place' });
    Logger.error(Logger.context('Could not save the bookmark.'), new Error('Unexpected private detail'));
    Logger.debug('private');
    assert.deepEqual(error.mock.calls.map(call => call.arguments), [
        ['[PrismArc] An extension operation failed.'],
        ['[PrismArc] Could not save the bookmark.']
    ]);
    assert.deepEqual(warn.mock.calls.map(call => call.arguments), [['[PrismArc] An extension operation reported a warning.']]);
    assert.equal(debug.mock.callCount(), 0);
});

test('the local debug setting opts into raw diagnostic details', async t => {
    const error = t.mock.method(console, 'error', () => {});
    globalThis.chrome = { storage: {
        local: { get: async () => ({ debugLoggingEnabled: true }) },
        onChanged: { addListener() {} }
    } };
    t.after(() => { delete globalThis.chrome; });
    await Logger.initialize();
    const details = new Error('diagnostic detail');
    Logger.error(Logger.context('Could not finish.'), details);
    assert.deepEqual(error.mock.calls[0].arguments, ['[PrismArc] Could not finish.', details]);
});
