import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compileAirTrafficRule, findAirTrafficDestination, parseAirTrafficPattern } from '../../air-traffic.js';

const spaces = [{ id: 'work' }, { id: 'home' }];
const rule = (pattern, spaceId = 'work') => compileAirTrafficRule({ pattern, spaceId });
const match = (pattern, url) => findAirTrafficDestination([rule(pattern)], spaces, url)?.id;

test('a bare host matches all paths for either web scheme, using an exact hostname', () => {
    assert.equal(match(' X.COM ', 'https://x.com/thread?a=1#reply'), 'work');
    assert.equal(match('x.com/*', 'http://x.com/'), 'work');
    assert.equal(match('x.com', 'https://x.com./'), 'work');
    for (const url of ['https://www.x.com/thread', 'https://x.com.example.test/', 'https://example.test/x.com', 'file:///x.com', 'about:blank']) {
        assert.equal(match('x.com/*', url), undefined, url);
    }
});

test('paths are exact unless a trailing wildcard asks for a prefix', () => {
    assert.equal(match('google.com/example', 'https://google.com/example?lang=en#intro'), 'work');
    assert.equal(match('google.com/example', 'https://google.com/example/'), undefined);
    assert.equal(match('google.com/example', 'https://google.com/Example'), undefined);
    assert.equal(match('google.com/example', 'https://google.com/examples'), undefined);
    assert.equal(match('google.com/example/*', 'https://google.com/example/subsection'), 'work');
    assert.equal(match('google.com/example*', 'https://google.com/examples'), 'work');
    assert.equal(match('example.test/café', 'https://example.test/caf%C3%A9'), 'work');
});

test('optional scheme and port narrow a match while host normalization supports IDNs and localhost', () => {
    assert.equal(match('https://example.test:443/path', 'https://example.test/path'), 'work');
    assert.equal(match('https://example.test:443/path', 'http://example.test:443/path'), undefined);
    assert.equal(match('localhost:8000/*', 'http://localhost:8000/health'), 'work');
    assert.equal(match('localhost:8000/*', 'http://localhost:9000/health'), undefined);
    assert.equal(match('[::1]:8000/*', 'http://[::1]:8000/health'), 'work');
    assert.equal(match('bücher.example', 'https://xn--bcher-kva.example/'), 'work');
});

test('patterns reject unsupported address syntax and remain plain data', () => {
    for (const input of [null, '', '*.example.test', 'https://', 'ftp://example.test', 'https:///example.test', '/relative',
        'user@example.test', 'example.test:99999', 'example.test/path?lang=en', 'example.test/path#intro',
        'example.test/bad path', 'example.test/tr*/path', 'example.test/**', 'a'.repeat(2049)]) {
        assert.equal(parseAirTrafficPattern(input), null, String(input));
    }
    assert.equal(compileAirTrafficRule({ pattern: 'example.test', spaceId: null }), null);
});

test('the first matching rule whose destination exists wins', () => {
    const rules = [rule('x.com/*', 'removed'), rule('x.com/path', 'home'), rule('x.com/*')];
    assert.equal(findAirTrafficDestination(rules, spaces, 'https://x.com/path'), spaces[1]);
    assert.equal(findAirTrafficDestination(rules, spaces, 'https://x.com/other'), spaces[0]);
    assert.equal(findAirTrafficDestination(rules, spaces, 'https://example.test/'), undefined);
});
