import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copyCurrentTabUrlWithFallback } from '../../url-copy.js';

const logger = { log() {}, error() {} };

test('copies the last-focused tab URL within an offscreen extension document', async () => {
    let queryOptions;
    const calls = [];
    const chromeApi = {
        tabs: { query: async options => {
            queryOptions = options;
            return [{ id: 7, url: 'https://example.org/private?token=secret' }];
        } },
        scripting: { executeScript() { assert.fail('must never inject into a visited page'); } },
        runtime: {
            getURL: path => `chrome-extension://arcify/${path}`,
            getContexts: async () => [],
            sendMessage: async message => { calls.push(['message', message]); return { success: true }; }
        },
        offscreen: {
            createDocument: async details => calls.push(['create', details]),
            closeDocument: async () => calls.push(['close'])
        }
    };
    assert.equal(await copyCurrentTabUrlWithFallback({ chromeApi, logger }), true);
    assert.deepEqual(queryOptions, { active: true, lastFocusedWindow: true });
    assert.equal(calls[0][0], 'create');
    assert.equal(calls[1][1].target, 'offscreen');
    assert.equal(calls[1][1].text, 'https://example.org/private?token=secret');
    assert.deepEqual(calls.find(call => call[0] === 'close'), ['close']);
});

test('falls back to the sidebar without page injection when offscreen is unavailable', async () => {
    const messages = [];
    const chromeApi = {
        tabs: { query: async () => [{ id: 42, url: 'https://example.com/article' }] },
        scripting: { executeScript() { assert.fail('page injection is removed'); } },
        runtime: { sendMessage(message, reply) { messages.push(message); reply({ success: true }); } }
    };
    assert.equal(await copyCurrentTabUrlWithFallback({ chromeApi, logger }), true);
    assert.deepEqual(messages, [{ command: 'copyCurrentUrl', url: 'https://example.com/article' }]);
});

test('reports clipboard failure when both extension contexts reject the operation', async () => {
    const chromeApi = {
        tabs: { query: async () => [{ id: 42, url: 'https://example.com' }] },
        offscreen: { createDocument: async () => { throw new Error('Unavailable'); } },
        scripting: { executeScript() { assert.fail('page injection is removed'); } },
        runtime: {
            getURL: path => `chrome-extension://arcify/${path}`,
            lastError: { message: 'No sidebar' },
            sendMessage: (_message, reply) => reply()
        }
    };
    assert.equal(await copyCurrentTabUrlWithFallback({ chromeApi, logger }), false);
});

test('does not expose a URL to clipboard contexts when no active tab exists', async () => {
    const chromeApi = {
        tabs: { query: async () => [] },
        runtime: { sendMessage() { assert.fail('no URL should be sent'); } }
    };
    assert.equal(await copyCurrentTabUrlWithFallback({ chromeApi, logger }), false);
});

test('rapid copy commands serialize create, send and close, and close on a rejected copy', async () => {
    const calls = [];
    let open = false;
    const chromeApi = {
        runtime: {
            getURL: path => `chrome-extension://arcify/${path}`,
            getContexts: async () => open ? [{}] : [],
            sendMessage(message, reply) {
                if (message.action === 'urlCopySuccess') return Promise.resolve();
                if (message.command === 'copyCurrentUrl') {
                    calls.push(['fallback', message.url]);
                    reply({ success: true });
                    return;
                }
                calls.push(['offscreen', message.text]);
                return Promise.resolve({ success: !message.text.includes('/first') });
            }
        },
        offscreen: {
            async createDocument() {
                assert.equal(open, false);
                open = true;
                calls.push(['create']);
            },
            async closeDocument() {
                assert.equal(open, true);
                open = false;
                calls.push(['close']);
            }
        }
    };
    const run = (id, path) => copyCurrentTabUrlWithFallback({ chromeApi, logger, tab: { id, url: `https://test.example/${path}` } });
    assert.deepEqual(await Promise.all([run(1, 'first'), run(2, 'second')]), [true, true]);
    assert.deepEqual(calls, [
        ['create'], ['offscreen', 'https://test.example/first'], ['close'], ['fallback', 'https://test.example/first'],
        ['create'], ['offscreen', 'https://test.example/second'], ['close']
    ]);
});

test('a clipboard document close failure does not repeat a completed copy', async () => {
    const chromeApi = {
        runtime: {
            getURL: path => `chrome-extension://arcify/${path}`,
            getContexts: async () => [{}],
            async sendMessage(message) {
                assert.equal(message.command, undefined);
                return { success: true };
            }
        },
        offscreen: {
            createDocument: async () => assert.fail('Existing context should be reused'),
            closeDocument: async () => { throw new Error('Could not close'); }
        }
    };
    assert.equal(await copyCurrentTabUrlWithFallback({ chromeApi, logger, tab: { id: 1, url: 'https://test.example/' } }), true);
});
