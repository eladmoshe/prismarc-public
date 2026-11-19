import { test } from 'node:test';
import assert from 'node:assert/strict';
import { searchBrowser, mergeSearchResults, searchableUrl, urlIdentity, activateBrowserResult, resolveSearchWindow, deleteHistoryResult } from '../../quick-switcher-search.js';

const context = { id: 1, type: 'normal', incognito: false };
const tab = (id, url, title = 'Project', windowId = 1) => ({ id, url, title, windowId, lastAccessed: 100 });

test('recognized Okta callback responses are excluded only from history, including typed queries', () => {
    const callbacks = ['?state=synthetic', '?code=synthetic', '?error=synthetic', '#access_token=synthetic', '#id_token=synthetic'];
    for (const [host, query] of ['tenant.okta.com', 'tenant.oktapreview.com', 'tenant.okta-emea.com'].flatMap(host => ['', 'okta'].map(query => [host, query]))) {
        const history = callbacks.map((suffix, id) => ({ id, title: 'Okta', url: `https://${host}/enduser/callback${suffix}` }));
        assert.deepEqual(mergeSearchResults({ history }, query, context), []);
        const url = history[0].url;
        const explicit = mergeSearchResults({ history, tabs: [tab(1, url, '', 1)],
            bookmarks: [{ id: 'saved', title: 'Saved sign-in', url: history[1].url }] }, query, context);
        assert.deepEqual(explicit.map(item => item.source), ['tab', 'bookmark']);
        assert.equal(explicit[0].url, url);
        assert.equal(explicit[0].title, 'Okta sign-in');
        assert.equal(explicit[0].displayUrl, `https://${host}/enduser/callback`);
    }
});

test('callback recognition does not hide arbitrary pages, lookalike hosts or ordinary login destinations', () => {
    const urls = ['https://tenant.okta.com/enduser/callback?iss=synthetic',
        'https://tenant.okta.com/enduser/callback-help?state=synthetic',
        'https://tenant.okta.com/enduser/callback', 'https://tenant.okta.com/login/login.htm',
        'https://tenant.okta.com/docs?code=example&state=example',
        'https://tenant.okta.com.evil.test/enduser/callback?state=synthetic',
        'https://notokta.com/enduser/callback?state=synthetic',
        'https://example.test/callback?code=example&state=example'];
    const results = mergeSearchResults({ history: urls.map((url, id) => ({ id, url, title: `Page ${id}` })) }, 'okta', context);
    assert.deepEqual(new Set(results.map(item => item.url)), new Set(urls));
});

test('Okta dashboard history variants consolidate before the limit and retain the newest exact destination', () => {
    const newest = 'https://tenant.okta.com/app/UserHome?iss=synthetic-new#section';
    const history = Array.from({ length: 50 }, (_, id) => ({ id, title: '',
        url: `https://tenant.okta.com/enduser/callback?state=synthetic-${id}`, lastVisitTime: 5000 + id }));
    history.push({ id: 'old', url: 'https://tenant.okta.com/app/UserHome?iss=synthetic-old', title: 'Work dashboard', lastVisitTime: 100 },
        { id: 'new', url: newest, title: newest, lastVisitTime: 200 });
    const results = mergeSearchResults({ history }, 'okta', context);
    assert.equal(results.length, 1);
    assert.equal(results[0].url, newest);
    assert.equal(results[0].title, 'Work dashboard', 'Useful older native titles enrich the newest representative');
    assert.equal(results[0].displayUrl, 'https://tenant.okta.com/app/UserHome#section');
    assert.equal(results[0].detail, 'Dashboard');
    for (const title of [newest, newest.replace('https://', '')]) {
        const fallback = mergeSearchResults({ history: [{ id: 'new', url: newest, title }] }, 'okta', context);
        assert.equal(fallback[0].title, 'Okta dashboard');
    }
});

test('dashboard grouping preserves unknown query bytes, repeated fields, paths, tenants, ports and protocols', () => {
    const urls = ['https://tenant.okta.com/app/UserHome?q=one%20two&q=%23tag&iss=old',
        'https://tenant.okta.com/app/UserHome?q=one%20two&q=%23tag&iss=new',
        'https://tenant.okta.com/app/UserHome?q=%23tag&q=one%20two&iss=new',
        'https://tenant.okta.com/app/UserHome?q=other&iss=new',
        'https://tenant.okta.com/app/UserHome?tab=one&iss=new',
        'https://tenant.okta.com/app/UserHome?tab=two&iss=new',
        'https://tenant.okta.com/app/UserHome?redirect=%2Fdocs&iss=new',
        'https://tenant.okta.com/app/UserHome?target=%2Fdocs&iss=new',
        'https://tenant.okta.com/app/real-app?iss=one', 'https://tenant.okta.com/app/real-app?iss=two',
        'https://other.okta.com/app/UserHome?iss=new', 'http://tenant.okta.com/app/UserHome?iss=new',
        'https://tenant.okta.com:8443/app/UserHome?iss=new',
        'https://tenant.okta.com.evil.test/app/UserHome?iss=one',
        'https://tenant.okta.com.evil.test/app/UserHome?iss=two'];
    for (const query of ['', 'okta']) {
        const results = mergeSearchResults({ history: urls.map((url, id) => ({ id, url, title: `Destination ${id}`, lastVisitTime: id + 1 })) }, query, context);
        assert.equal(results.length, urls.length - 1, query);
        assert.equal(results.find(item => item.url === urls[1]).detail, 'Dashboard ?q=one%20two&q=%23tag');
    }
});

test('history dashboard variants attach to the preferred explicit row without collapsing explicit destinations', () => {
    const one = 'https://tenant.okta.com/app/UserHome?iss=one';
    const two = 'https://tenant.okta.com/app/UserHome?iss=two';
    const three = 'https://tenant.okta.com/app/UserHome?iss=three';
    const results = mergeSearchResults({ tabs: [tab(2, two, 'Okta other', 2), tab(1, one, 'Okta current')],
        bookmarks: [{ id: 'saved', title: 'Okta saved', url: three }],
        history: [{ id: 'history', title: 'Okta dashboard', url: 'https://tenant.okta.com/app/UserHome?iss=four', lastVisitTime: 999 }],
    }, 'okta', context);
    assert.equal(results.length, 3);
    assert.deepEqual(results.slice(0, 2).map(item => item.source), ['tab', 'tab']);
    assert.equal(results.find(item => item.time === 999).tabId, 1);
    assert.deepEqual(new Set(results.map(item => item.url)), new Set([one, two, three]));
});

test('dashboard selection opens the observed full URL and does not relax activation identity', async () => {
    const url = 'https://tenant.okta.com/app/UserHome?iss=synthetic-observed#chosen';
    const [item] = mergeSearchResults({ history: [{ id: 'h', url, lastVisitTime: 100 }] }, 'okta', context);
    const f = activationFixture();
    f.setTabs([tab(10, 'https://tenant.okta.com/app/UserHome?iss=synthetic-other')]);
    await activateBrowserResult(item, context, false, f.api);
    assert.equal(f.calls[0][0], 'create');
    assert.equal(f.calls[0][1].url, url);
});

test('native queries run on demand, with explicit history bounds, and never persist a search index', async () => {
    const calls = [];
    let history = [{ id: 'h', url: 'https://history.test/', title: 'Project history', lastVisitTime: 200 }];
    const api = {
        tabs: { query: async query => { calls.push(['tabs', query]); return [tab(1, 'https://tab.test/')]; } },
        bookmarks: {
            search: async query => { calls.push(['bookmarks', query]); return []; },
            getRecent: async count => { calls.push(['recent', count]); return []; },
        },
        history: { search: async query => { calls.push(['history', query]); return history; } },
        storage: { local: { get: async () => ({}), set: () => assert.fail('Search must not write an index') } },
    };
    const initial = await searchBrowser('', context, api);
    assert.equal(initial.results.length, 2);
    assert.ok(calls.some(call => call[0] === 'recent' && call[1] === 30));
    assert.ok(calls.find(call => call[0] === 'history')[1].startTime > 0);
    history = [];
    calls.length = 0;
    const next = await searchBrowser('Project', context, api);
    assert.equal(next.results.length, 1, 'Deleted native history is not retained in a separate store');
    assert.deepEqual(calls.find(call => call[0] === 'history')[1], { text: 'Project', startTime: 0, maxResults: 100 });
    assert.ok(calls.some(call => call[0] === 'bookmarks' && call[1] === 'Project'));
});

test('URL merging ignores fragments, prefers an open tab, and keeps query strings distinct', () => {
    const base = 'https://example.test/page?q=1#one';
    const results = mergeSearchResults({
        tabs: [tab(2, 'https://example.test/page?q=1#other', 'Other window', 2), tab(1, base, 'This window')],
        bookmarks: [{ id: 'b', url: 'https://example.test/page?q=1#saved', title: 'Saved page' },
            { id: 'b2', url: 'https://example.test/page?q=2#one' }, { id: 'b3', url: 'https://example.test/page?q=1#two' }],
        history: [{ id: 'h', url: 'https://example.test/page?q=1#visited', lastVisitTime: 300 }],
        spaces: [{ name: 'Work', temporaryTabs: [1] }],
    }, '', context, 1000);
    assert.equal(results.length, 2);
    const item = results.find(item => item.url === base);
    assert.equal(item.tabId, 1);
    assert.equal(item.bookmarked, true);
    assert.equal(item.context, 'Work');
    assert.equal(item.time, 300);
});

test('fragment-only history duplicates keep the newest visited section as the navigation URL', () => {
    const results = mergeSearchResults({ history: [
        { id: 'old', url: 'https://docs.test/document?tab=t.0#heading=one', title: 'Document', lastVisitTime: 100 },
        { id: 'new', url: 'https://docs.test/document?tab=t.0#heading=two', title: 'Document', lastVisitTime: 300 },
        { id: 'plain', url: 'https://docs.test/document?tab=t.0', title: 'Document', lastVisitTime: 200 },
    ] }, '', context, 1000);
    assert.equal(results.length, 1);
    assert.equal(results[0].url, 'https://docs.test/document?tab=t.0#heading=two');
    assert.equal(results[0].time, 300);
});

test('comparison strips only the fragment, including hash routes, and preserves encoded hashes and queries', () => {
    assert.equal(urlIdentity('https://example.test/app?query=%23tag#/route'), 'https://example.test/app?query=%23tag');
    assert.equal(urlIdentity('https://example.test/app?query=%23tag#'), 'https://example.test/app?query=%23tag');
    assert.notEqual(urlIdentity('https://example.test/app?tab=1#section'), urlIdentity('https://example.test/app?tab=2#section'));
    assert.notEqual(urlIdentity('https://example.test/one#section'), urlIdentity('https://example.test/two#section'));
    assert.equal(urlIdentity('javascript:alert(1)#section'), null);
});

test('unsafe, malformed, and extension helper URLs cannot become navigation results', () => {
    for (const url of ['javascript:alert(1)', 'data:text/html,example', 'chrome-extension://arcify/quick-switcher.html',
        'chrome://quit/', 'chrome://restart/', 'not a URL', undefined]) assert.equal(searchableUrl(url), null);
    assert.equal(searchableUrl('chrome://settings/'), 'chrome://settings/');
    assert.equal(searchableUrl('file:///tmp/report.html'), 'file:///tmp/report.html');
    const results = mergeSearchResults({ bookmarks: [{ id: 'bad', url: 'javascript:alert(1)' }] }, '', context);
    assert.deepEqual(results, []);
});

test('matching pinned and ordinary open tabs precede stronger and newer history matches', () => {
    for (const title of ['cal', 'Calendar archive']) {
        const results = mergeSearchResults({
            tabs: [{ ...tab(1, 'https://calendar.test/pinned', 'Google Calendar'), pinned: true },
                tab(2, 'https://calendar.test/ordinary', 'Team calendar', 2)],
            history: [{ id: 'h', url: 'https://history.test/cal', title, lastVisitTime: 9999 }],
        }, 'cal', context);
        assert.deepEqual(results.map(item => item.source), ['tab', 'tab', 'history']);
        assert.deepEqual(new Set(results.slice(0, 2).map(item => item.tabId)), new Set([1, 2]));
    }
});

test('open tabs retain relevance and recency ordering without a pinned-tab ranking boost', () => {
    const results = mergeSearchResults({ tabs: [
        { ...tab(1, 'https://tabs.test/pinned', 'Shared calendar'), pinned: true, lastAccessed: 900 },
        { ...tab(2, 'https://tabs.test/older', 'Calendar week'), lastAccessed: 100 },
        { ...tab(3, 'https://tabs.test/newer', 'Calendar month'), lastAccessed: 200 },
        { ...tab(4, 'https://tabs.test/exact', 'Calendar'), lastAccessed: 1 },
    ] }, 'calendar', context);
    assert.deepEqual(results.map(item => item.tabId), [4, 3, 2, 1]);
});

test('matching tabs survive the result limit even with many stronger or newer history entries', () => {
    for (const query of ['cal', '']) {
        const results = mergeSearchResults({
            tabs: [{ ...tab(1, 'https://calendar.test/', 'Google Calendar'), pinned: true }],
            history: Array.from({ length: 40 }, (_, id) => ({ id: String(id), title: 'cal',
                url: `https://history.test/${id}`, lastVisitTime: 1000 + id })),
        }, query, context);
        assert.equal(results.length, 30);
        assert.equal(results[0].tabId, 1);
    }
});

test('bookmark/history relevance ranking remains unchanged behind the open-tab tier', () => {
    const results = mergeSearchResults({ tabs: [tab(1, 'https://tab.test/', 'Project updates')],
        bookmarks: Array.from({ length: 40 }, (_, id) => ({ id: String(id), title: id ? 'Project reference' : 'Project', url: `https://saved.test/${id}` })),
        history: [{ id: 'h', title: 'Project', url: 'https://history.test/', lastVisitTime: 9999 }] },
    'project', context);
    assert.equal(results[0].source, 'tab');
    assert.equal(results[1].source, 'bookmark', 'Existing exact-title bookmark bonus is preserved');
    assert.equal(results[1].title, 'Project');
    assert.equal(results[2].source, 'history', 'An exact history match still beats a weaker bookmark');
    assert.equal(results.length, 30);
});

test('unavailable data sources leave other results usable and incognito never queries regular history', async () => {
    let historyCalls = 0;
    const api = {
        tabs: { query: async () => [tab(1, 'https://regular.test/'), { ...tab(2, 'https://private.test/'), incognito: true }] },
        bookmarks: { search: async () => { throw new Error('Bookmarks unavailable'); }, getRecent: async () => [] },
        history: { search: async () => { historyCalls++; throw new Error('Permission unavailable'); } },
        storage: { local: { get: async () => ({}) } },
    };
    const normal = await searchBrowser('Project', context, api);
    assert.deepEqual(normal.unavailable, ['Bookmarks', 'History']);
    assert.equal(normal.results.length, 1);
    assert.equal(normal.results[0].url, 'https://regular.test/');
    const privateResults = await searchBrowser('', { ...context, incognito: true }, api);
    assert.equal(historyCalls, 1);
    assert.equal(privateResults.results[0].url, 'https://private.test/');
});

function activationFixture() {
    const calls = [];
    let tabs = [tab(10, 'https://open.test/', 'Open', 2), { ...tab(11, 'https://origin.test/'), active: true }];
    const api = {
        runtime: { sendMessage: async () => ({ success: true, spaces: [] }) },
        windows: { get: async () => context, getLastFocused: async () => context,
            update: async (...args) => { calls.push(['focus', ...args]); } },
        tabs: {
            query: async query => query.active ? tabs.filter(tab => tab.active && tab.windowId === query.windowId) : tabs,
            update: async (id, options) => { calls.push(['activate', id, options]); return tabs.find(tab => tab.id === id); },
            create: async options => { calls.push(['create', options]); return { id: 99, ...options }; },
        },
    };
    return { api, calls, setTabs: value => { tabs = value; } };
}

test('bookmark/history selection rechecks native tabs and focuses an existing tab across windows', async () => {
    const f = activationFixture();
    await activateBrowserResult({ url: 'https://open.test/' }, context, false, f.api);
    assert.deepEqual(f.calls, [['activate', 10, { active: true }], ['focus', 2, { focused: true }]]);
});

test('switching to an already-active tab explicitly reveals its owning Arcify space', async () => {
    const f = activationFixture(), messages = [];
    f.api.runtime.sendMessage = async message => {
        messages.push(message);
        return { success: true, spaces: [{ id: 'research', temporaryTabs: [10] }] };
    };
    await activateBrowserResult({ tabId: 10, url: 'https://open.test/' }, context, false, f.api);
    assert.deepEqual(messages, [{ type: 'spaceStore', action: 'get' },
        { type: 'spaceStore', action: 'activate', spaceId: 'research', windowId: 2 }]);
});

test('explicit new-tab selection opens in the source window and inherits its active tab as opener', async () => {
    const f = activationFixture();
    await activateBrowserResult({ url: 'https://open.test/#chosen' }, context, true, f.api);
    assert.deepEqual(f.calls[0], ['create', { url: 'https://open.test/#chosen', windowId: 1, active: true, openerTabId: 11 }]);
    assert.deepEqual(f.calls[1], ['focus', 1, { focused: true }]);
});

test('an existing tab with another fragment is reused without navigating it or merging another query', async () => {
    const f = activationFixture();
    f.setTabs([tab(10, 'https://open.test/#current', 'Open', 2)]);
    await activateBrowserResult({ url: 'https://open.test/#chosen' }, context, false, f.api);
    assert.deepEqual(f.calls, [['activate', 10, { active: true }], ['focus', 2, { focused: true }]]);
    f.calls.length = 0;
    await activateBrowserResult({ url: 'https://open.test/?tab=other#chosen' }, context, false, f.api);
    assert.equal(f.calls[0][0], 'create');
    assert.equal(f.calls[0][1].url, 'https://open.test/?tab=other#chosen');
});

test('a tab closed or navigated since search opens the selected URL without activating unrelated content', async () => {
    const f = activationFixture();
    await activateBrowserResult({ tabId: 10, url: 'https://original.test/' }, context, false, f.api);
    assert.equal(f.calls[0][0], 'create');
    assert.equal(f.calls[0][1].url, 'https://original.test/');
    await assert.rejects(activateBrowserResult({ url: 'javascript:alert(1)' }, context, false, f.api), /cannot be opened/);
});

test('a closed originating window falls back to a normal window and never to the palette itself', async () => {
    const api = { windows: { get: async () => { throw new Error('Closed'); },
        getLastFocused: async options => { assert.deepEqual(options, { windowTypes: ['normal'] }); return { id: 7, type: 'normal' }; } } };
    assert.equal((await resolveSearchWindow(1, api)).id, 7);
    api.windows.getLastFocused = async () => ({ id: 9, type: 'popup' });
    await assert.rejects(resolveSearchWindow(1, api), /No browser window/);
});

test('generic X titles become honest account/post labels without collapsing different posts', () => {
    const history = [
        { id: 'a', title: '(4) Home / X', url: 'https://x.com/Example/status/123/photo/2', lastVisitTime: 100 },
        { id: 'b', title: 'Home / X', url: 'https://x.com/Other/status/456/video/1', lastVisitTime: 200 },
        { id: 'c', title: 'Example on X: A useful announcement', url: 'https://x.com/Example/status/789', lastVisitTime: 50 },
    ];
    const results = mergeSearchResults({ history }, 'x.com', context);
    assert.equal(results.length, 3);
    assert.equal(results.find(item => item.id === 'history-a').title, '@Example · Post 123');
    assert.equal(results.find(item => item.id === 'history-a').detail, 'Photo 2');
    assert.equal(results.find(item => item.id === 'history-b').detail, 'Video 1');
    assert.equal(results.find(item => item.id === 'history-c').title, 'Example on X: A useful announcement');
});

test('initial suggestions limit generic history per host, retain tabs/bookmarks, and favor useful titles', () => {
    const history = [1, 2, 3].map(id => ({ id, title: 'Home / X', url: `https://x.com/Example/status/${id}`, lastVisitTime: id * 100 }));
    history.push({ id: 4, title: 'A useful page', url: 'https://example.test/article', lastVisitTime: 1 });
    const data = { history, tabs: [tab(5, 'https://x.com/Example/status/5', 'Home / X')],
        bookmarks: [{ id: 6, title: 'Home / X', url: 'https://x.com/Example/status/6' }] };
    const initial = mergeSearchResults(data, '', context);
    assert.equal(initial.length, 4);
    assert.equal(initial.filter(item => item.source === 'history' && item.genericTitle).length, 1);
    assert.equal(initial.at(-1).url, 'https://x.com/Example/status/3');
    assert.equal(mergeSearchResults(data, 'x.com', context).length, 6);
});

test('a useful matching bookmark title enriches a generic open tab without changing its action or URL', () => {
    const results = mergeSearchResults({ tabs: [tab(1, 'https://x.com/Example/status/123#current', 'Home / X')],
        bookmarks: [{ id: 'b', title: 'Example on X: Launch announcement', url: 'https://x.com/Example/status/123#saved' }] },
    'launch', context);
    assert.equal(results.length, 1);
    assert.equal(results[0].source, 'tab');
    assert.equal(results[0].tabId, 1);
    assert.equal(results[0].title, 'Example on X: Launch announcement');
    assert.equal(results[0].genericTitle, false);
    assert.equal(results[0].bookmarked, true);
    assert.equal(results[0].url, 'https://x.com/Example/status/123#current');
});

test('generic fallback is scoped to exact X hosts and keeps meaningful Home-prefixed titles', () => {
    const results = mergeSearchResults({ bookmarks: [
        { id: 1, title: 'Home / X', url: 'https://x.com.evil.test/Example/status/123' },
        { id: 2, title: 'Home improvement guide', url: 'https://example.test/guide' },
        { id: 3, title: '', url: 'https://example.test/search?q=desk' },
    ] }, '', context);
    assert.equal(results.find(item => item.id === 'bookmark-1').title, 'x.com.evil.test/Example/status/123');
    assert.equal(results.find(item => item.id === 'bookmark-2').title, 'Home improvement guide');
    assert.equal(results.find(item => item.id === 'bookmark-3').title, 'example.test/search?q=desk');
});


test('history deletion removes only exact observed fragment/issuer variants, preserving distinct queries', async () => {
    for (const urls of [
        ['https://history.test/document?q=one#first', 'https://history.test/document?q=one#second', 'https://history.test/document?q=two#first'],
        ['https://tenant.okta.com/app/UserHome?iss=old#one', 'https://tenant.okta.com/app/UserHome?iss=new#two', 'https://tenant.okta.com/app/UserHome?tab=work&iss=other'],
    ]) {
        const rows = mergeSearchResults({ history: urls.map((url, id) => ({ id, url, title: 'History document', lastVisitTime: id + 1 })) }, 'history', context);
        const group = rows.find(row => row.historyUrls.length === 2);
        assert.deepEqual(new Set(group.historyUrls), new Set(urls.slice(0, 2)));
        const calls = [];
        const api = { windows: { get: async () => context }, history: { deleteUrl: async options => calls.push(options) } };
        assert.deepEqual(await deleteHistoryResult(group, context, api), { deleted: group.historyUrls, failed: [] });
        assert.deepEqual(calls, group.historyUrls.map(url => ({ url })));
        assert.equal(calls.some(call => call.url === urls[2]), false);
    }
});

test('history deletion rejects explicit sources, incognito and invalid, unrelated or unbounded provenance', async () => {
    const url = 'https://history.test/document#one';
    const [item] = mergeSearchResults({ history: [{ id: 'h', url, title: 'Document' }] }, '', context);
    const api = { windows: { get: async () => context }, history: { deleteUrl: () => assert.fail('Must not delete') } };
    for (const bad of [{ ...item, source: 'tab' }, { ...item, source: 'bookmark' }, { ...item, source: 'google' },
        { ...item, historyUrls: undefined }, { ...item, historyUrls: [] },
        { ...item, historyUrls: [url, 'https://history.test/document?q=other'] },
        { ...item, historyUrls: [url, 'javascript:alert(1)'] }, { ...item, historyUrls: Array(101).fill(url) }]) {
        await assert.rejects(deleteHistoryResult(bad, context, api));
    }
    await assert.rejects(deleteHistoryResult(item, { ...context, incognito: true }, api));
    await assert.rejects(deleteHistoryResult(item, context, { ...api, windows: { get: async () => ({ ...context, incognito: true }) } }));
    for (const explicit of [{ tabs: [tab(1, url)] }, { bookmarks: [{ id: 'saved', url }] }]) {
        const [row] = mergeSearchResults({ ...explicit, history: [{ id: 'h', url }] }, '', context);
        assert.equal(row.historyUrls, undefined);
    }
});

test('history deletion deduplicates native URLs and reports partial failure without rollback', async () => {
    const urls = ['https://history.test/document#one', 'https://history.test/document#two'];
    const calls = [];
    const api = { windows: { get: async () => context }, history: { deleteUrl: async ({ url }) => {
        calls.push(url); if (url === urls[1]) throw new Error('Native failure');
    } } };
    const outcome = await deleteHistoryResult({ source: 'history', url: urls[0], historyUrls: [...urls, urls[0]] }, context, api);
    assert.deepEqual(calls, urls);
    assert.deepEqual(outcome, { deleted: [urls[0]], failed: [urls[1]] });
});
