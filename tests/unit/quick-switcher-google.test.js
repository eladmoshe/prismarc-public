import { test } from 'node:test';
import assert from 'node:assert/strict';
import { googleSearchUrl, activateGoogleSearch } from '../../quick-switcher-google.js';

test('Google navigation encodes a trimmed query as one q parameter without tracking', () => {
    for (const query of ['cats & dogs', 'עברית + café #?', 'https://example.test/?q=one&x=two', '<script>"test"</script>']) {
        const url = new URL(googleSearchUrl(`  ${query}  `));
        assert.equal(url.origin, 'https://www.google.com');
        assert.equal(url.pathname, '/search');
        assert.deepEqual([...url.searchParams], [['q', query]]);
        assert.equal(url.hash, '');
    }
    for (const query of ['', '  ', '\n\t']) assert.equal(googleSearchUrl(query), null);
});

test('explicit Google activation creates a new source-window tab even for an already open search', async () => {
    for (const incognito of [false, true]) {
        const calls = [];
        const context = { id: 7, type: 'normal', incognito };
        const api = {
            windows: { get: async id => { assert.equal(id, 7); return context; }, update: async (...args) => calls.push(['focus', ...args]) },
            tabs: {
                query: async query => { assert.deepEqual(query, { active: true, windowId: 7 }); return [{ id: 11, url: googleSearchUrl('cats') }]; },
                create: async options => { calls.push(['create', options]); return { id: 12, ...options, incognito }; },
                update: () => assert.fail('Search must not reuse or navigate an existing tab'),
            },
        };
        const opened = await activateGoogleSearch('cats', context, api);
        assert.equal(opened.incognito, incognito);
        assert.deepEqual(calls, [['create', { url: googleSearchUrl('cats'), windowId: 7, active: true, openerTabId: 11 }], ['focus', 7, { focused: true }]]);
    }
});

test('empty queries do nothing and a changed privacy context blocks Google navigation', async () => {
    assert.equal(await activateGoogleSearch(' ', {}, {}), null);
    await assert.rejects(activateGoogleSearch('cats', { id: 1, incognito: true }, {
        windows: { get: async () => ({ id: 1, type: 'normal', incognito: false }) },
        tabs: { create: () => assert.fail('Do not cross browsing contexts') },
    }), /Browser context changed/);
});
