import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { isTrustedExtensionMessage } from '../../message-security.js';
import { Utils } from '../../utils.js';
import { CALENDAR_EVENTS_ENDPOINT, CALENDAR_REVOKE_ENDPOINT } from '../../calendar-config.js';

const root = new URL('../../', import.meta.url);
const manifest = JSON.parse(readFileSync(new URL('manifest.json', root), 'utf8'));
const runtime = { id: 'arcify', getURL: path => new URL(path, 'chrome-extension://arcify/').href };

test('privileged handlers reject other extensions, web content scripts and malformed messages', () => {
    for (const message of [null, undefined, 'searchTabs', [], 42]) {
        assert.equal(isTrustedExtensionMessage(message, { id: 'arcify' }, { runtime }), false);
    }
    const message = { type: 'spaceStore', action: 'get' };
    for (const sender of [undefined, {}, { id: 'other' }, { id: 'arcify', url: 'https://example.org/' },
        { id: 'arcify', url: 'chrome-extension://arcify-other/sidebar.html' }]) {
        assert.equal(isTrustedExtensionMessage(message, sender, { runtime }), false);
    }
    assert.equal(isTrustedExtensionMessage(message, { id: 'arcify', url: runtime.getURL('sidebar.html') }, { runtime }), true);
    assert.equal(isTrustedExtensionMessage(message, { id: 'arcify' }, { runtime }), true);
    assert.equal(isTrustedExtensionMessage(message, {}, { runtime: {} }), false);
});

test('manifest denies outside messaging and confines the optional Recent Tabs embedding to one document', () => {
    assert.deepEqual(manifest.externally_connectable, { ids: [] });
    assert.deepEqual(manifest.web_accessible_resources, [{
        resources: ['tab-switcher.html'], matches: ['http://*/*', 'https://*/*'], use_dynamic_url: true,
    }]);
    assert.equal(manifest.host_permissions, undefined);
    assert.deepEqual(manifest.optional_host_permissions, ['<all_urls>']);
    assert.deepEqual(manifest.optional_permissions, ['identity', 'scripting']);
    assert.equal(manifest.permissions.includes('identity'), false);
    assert.equal(manifest.content_scripts, undefined);
    assert.equal(manifest.permissions.filter(permission => permission === 'history').length, 1);
    assert.equal(manifest.permissions.filter(permission => permission === 'activeTab').length, 1);
    for (const permission of ['scripting', 'debugger', 'tabCapture', 'desktopCapture', 'cookies', 'clipboardRead']) {
        assert.equal(manifest.permissions.includes(permission), false);
    }
    const csp = manifest.content_security_policy.extension_pages;
    for (const directive of [`connect-src ${CALENDAR_EVENTS_ENDPOINT} ${CALENDAR_REVOKE_ENDPOINT}`, "script-src 'self'", "img-src 'self' data:", "font-src 'self'", "object-src 'none'", "form-action 'none'"]) {
        assert.ok(csp.split(';').map(value => value.trim()).includes(directive));
    }
    assert.doesNotMatch(csp.replace(CALENDAR_EVENTS_ENDPOINT, '').replace(CALENDAR_REVOKE_ENDPOINT, ''), /https?:|script-src[^;]*(unsafe-inline|unsafe-eval)/);
});

test('preferences read and write local storage even if synced data differs', async () => {
    const data = { defaultSpaceName: 'Local space', debugLoggingEnabled: false };
    globalThis.chrome = {
        runtime,
        storage: {
            onChanged: { addListener() {} },
            local: { get: async defaults => ({ ...defaults, ...data }), set: async values => Object.assign(data, values) },
            sync: { get() { assert.fail('cloud-backed settings must not be read'); }, set() { assert.fail('cloud-backed settings must not be written'); } }
        }
    };
    try {
        assert.equal((await Utils.getSettings()).defaultSpaceName, 'Local space');
        await Utils.setArchiveTime(240);
        await Utils.setArchivingEnabled(true);
        await Utils.setInvertTabOrder(false);
        assert.equal(data.autoArchiveIdleMinutes, 240);
        assert.equal(data.autoArchiveEnabled, true);
        assert.equal(data.invertTabOrder, false);
        const favicon = new URL(Utils.getFaviconUrl('https://example.org/private?secret=value'));
        assert.equal(favicon.protocol, 'chrome-extension:');
        assert.equal(favicon.hostname, 'arcify');
        assert.equal(favicon.pathname, '/_favicon/');
    } finally { delete globalThis.chrome; }
});

test('runtime sources restrict remote requests to the Calendar integration and deny direct remote favicons and Chrome Sync', () => {
    for (const name of readdirSync(root).filter(name => /\.(js|html|css)$/.test(name) && !name.startsWith('vite.') && name !== 'jest.config.js')) {
        const source = readFileSync(new URL(name, root), 'utf8');
        if (name !== 'tab-switcher-previews.js') assert.doesNotMatch(source, /\bcaptureVisibleTab\s*\(/, name);
        if (!['calendar-events.js', 'calendar-auth.js'].includes(name)) assert.doesNotMatch(source, /\bfetch\s*\(/, name);
        assert.doesNotMatch(source, /chrome\.storage\.sync|(?:XMLHttpRequest|WebSocket|EventSource)\s*\(|sendBeacon\s*\(/, name);
        if (name !== 'tab-switcher-inline-registration.js') {
            assert.doesNotMatch(source, /scripting\.(?:executeScript|registerContentScripts)/, name);
        }
        assert.doesNotMatch(source, /(?:src|href)\s*=\s*["']https?:\/\/|\.src\s*=\s*tab\.favIconUrl/, name);
        assert.doesNotMatch(source, /\bhistory\.(?:addUrl|deleteAll|deleteRange)\s*\(/, name);
        if (name !== 'quick-switcher-search.js') assert.doesNotMatch(source, /\bhistory\.deleteUrl\s*\(/, name);
    }
});
