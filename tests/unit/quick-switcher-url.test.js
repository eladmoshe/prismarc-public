import { test } from 'node:test';
import assert from 'node:assert/strict';
import { activateTypedWebsite, typedWebsiteUrl } from '../../quick-switcher-url.js';

test('typed website addresses normalize safely and retain the destination components', () => {
    for (const [input, href] of [
        ['  www.zocdoc.com  ', 'https://www.zocdoc.com/'],
        ['EXAMPLE.com:8443/path?q=a%20b&mode=1#part', 'https://example.com:8443/path?q=a%20b&mode=1#part'],
        ['http://example.test/a#b', 'http://example.test/a#b'],
        ['https://bücher.example/', 'https://xn--bcher-kva.example/'],
        ['127.0.0.1:8080/path', 'https://127.0.0.1:8080/path'],
        ['chrome://extensions/shortcuts', 'chrome://extensions/shortcuts'],
        ['CHROME://SETTINGS', 'chrome://settings/'],
        ['chrome://history/?q=example%20tab#results', 'chrome://history/?q=example%20tab#results'],
        ['localhost:3000', 'https://localhost:3000/'],
        ['http://[::1]:8080/path', 'http://[::1]:8080/path'],
    ]) assert.equal(typedWebsiteUrl(input), href, input);
});

test('phrases, malformed addresses, credentials, and other protocols are ordinary searches', () => {
    for (const input of [
        '', '   ', 'zocdoc', 'best www.zocdoc.com', 'www.zocdoc.com new york', '../example.com',
        'example..com', 'example.com:65536', 'https://example.com:', 'http:example.com', 'https:///example.com',
        'example.com\\path', 'exa\nmple.com', 'example.com /search', 'example.com\u200b',
        'https://user:pass@example.com', 'https://@example.com', 'user@example.com',
        'https://127.1', 'http://0x7f000001', 'javascript:alert(1)', 'data:text/plain,hello',
        'file:///tmp/example.com', 'chrome://', 'chrome:extensions/shortcuts', 'chrome:///extensions',
        'chrome://@extensions/shortcuts', 'chrome://extensions:/shortcuts', 'chrome://settings:80/',
        'chrome://settings.evil.test/', 'chrome://extensions/bad%2', 'chrome://crash',
        'chrome-extension://extension-id/', 'ftp://example.com', '//example.com',
    ]) assert.equal(typedWebsiteUrl(input), null, input);
});

test('direct activation revalidates input and can open an explicitly typed sign-in URL', async () => {
    await assert.rejects(activateTypedWebsite('file:///tmp/example.com', {}, {}), /cannot be opened/);
    for (const incognito of [false, true]) {
        const context = { id: 7, type: 'normal', incognito };
        const url = 'https://auth.example.test/login?next=%2Fprojects#sign-in';
        const api = {
            windows: {
                get: async () => context,
                update: async (id, settings) => assert.deepEqual([id, settings], [7, { focused: true }]),
            },
            tabs: {
                query: async query => {
                    assert.deepEqual(query, { active: true, windowId: 7 });
                    return [{ id: 11, url }];
                },
                create: async settings => {
                    assert.deepEqual(settings, { url, windowId: 7, active: true, openerTabId: 11 });
                    return { id: 12, incognito };
                },
            },
        };
        assert.deepEqual(await activateTypedWebsite(url, context, api), { id: 12, incognito });
        await assert.rejects(activateTypedWebsite(url, { ...context, incognito: !incognito }, api), /Browser context changed/);
    }
});
