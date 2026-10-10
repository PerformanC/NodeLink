import assert from 'node:assert/strict';
import test from 'node:test';
import AdmissionManager from '../managers/admissionManager.js';
import { isLoopbackRequest, normalizeAddress, resolveClientAddress, TrustedProxyList } from './clientAddress.js';
const proxies = new TrustedProxyList(['127.0.0.1', '10.0.0.0/8', 'fd00::/8']);
test('normalizeAddress strips mapping, brackets and ports', () => {
    assert.equal(normalizeAddress('::ffff:203.0.113.7'), '203.0.113.7');
    assert.equal(normalizeAddress('203.0.113.7:5123'), '203.0.113.7');
    assert.equal(normalizeAddress('[2001:db8::1]:443'), '2001:db8::1');
    assert.equal(normalizeAddress('fe80::1%eth0'), 'fe80::1');
    assert.equal(normalizeAddress('unknown'), null);
    assert.equal(normalizeAddress(''), null);
});
test('TrustedProxyList matches IPv4/IPv6 CIDRs and rejects bad entries', () => {
    const list = new TrustedProxyList([
        '192.168.0.0/16',
        '2001:db8::/32',
        '1.2.3.4/33',
        'nope'
    ]);
    assert.equal(list.size, 2);
    assert.deepEqual(list.invalidEntries, ['1.2.3.4/33', 'nope']);
    assert.equal(list.contains('192.168.44.1'), true);
    assert.equal(list.contains('::ffff:192.168.44.1'), true);
    assert.equal(list.contains('192.169.0.1'), false);
    assert.equal(list.contains('2001:db8:ffff::1'), true);
    assert.equal(list.contains('2001:db9::1'), false);
    assert.equal(new TrustedProxyList(['0.0.0.0/0']).contains('8.8.8.8'), true);
});
test('forwarding headers from untrusted peers are ignored', () => {
    const client = resolveClientAddress('203.0.113.7', { 'x-forwarded-for': '198.51.100.1', 'x-real-ip': '198.51.100.2' }, proxies);
    assert.equal(client, '203.0.113.7');
});
test('X-Forwarded-For is walked from the nearest hop', () => {
    // A client-supplied leftmost entry must not override what the proxy appended.
    assert.equal(resolveClientAddress('127.0.0.1', { 'x-forwarded-for': '6.6.6.6, 198.51.100.1' }, proxies), '198.51.100.1');
    // Trusted intermediate hops are skipped.
    assert.equal(resolveClientAddress('10.0.0.1', { 'x-forwarded-for': '198.51.100.1, 10.2.0.9' }, proxies), '198.51.100.1');
    // When every hop is trusted, the farthest one is the client.
    assert.equal(resolveClientAddress('10.0.0.1', { 'x-forwarded-for': '10.9.9.9, 10.2.0.9' }, proxies), '10.9.9.9');
    // A malformed hop stops the walk at the last trusted address.
    assert.equal(resolveClientAddress('10.0.0.1', { 'x-forwarded-for': '198.51.100.1, garbage' }, proxies), '10.0.0.1');
    assert.equal(resolveClientAddress('::ffff:127.0.0.1', { 'x-forwarded-for': '[2001:db8::5]:8080' }, proxies), '2001:db8::5');
});
test('X-Real-IP is used only without X-Forwarded-For', () => {
    assert.equal(resolveClientAddress('127.0.0.1', { 'x-real-ip': '198.51.100.3' }, proxies), '198.51.100.3');
    assert.equal(resolveClientAddress('127.0.0.1', {}, proxies), '127.0.0.1');
});
test('isLoopbackRequest rejects proxied loopback traffic', () => {
    assert.equal(isLoopbackRequest('127.0.0.1', {}), true);
    assert.equal(isLoopbackRequest('::ffff:127.0.0.1', {}), true);
    assert.equal(isLoopbackRequest('::1', {}), true);
    assert.equal(isLoopbackRequest('127.0.0.1', { 'x-forwarded-for': '198.51.100.1' }), false);
    assert.equal(isLoopbackRequest('127.0.0.1', { forwarded: 'for=1.2.3.4' }), false);
    assert.equal(isLoopbackRequest('198.51.100.1', {}), false);
});
function createAdmission(config) {
    const nodelink = {
        options: { server: { password: 'test-password' } }
    };
    return new AdmissionManager(nodelink, config);
}
function proxiedRequest(clientIp) {
    return {
        method: 'GET',
        url: '/v4/info',
        headers: { 'x-forwarded-for': clientIp },
        socket: { remoteAddress: '::ffff:127.0.0.1' }
    };
}
test('auth bans behind a trusted proxy apply per client', (t) => {
    const admission = createAdmission({
        trustProxy: true,
        trustedProxies: ['127.0.0.1']
    });
    t.after(() => admission.destroy());
    const attacker = proxiedRequest('198.51.100.66');
    const bystander = proxiedRequest('198.51.100.10');
    for (let attempt = 0; attempt < 5; attempt++) {
        admission.recordAuthFailure(admission.resolveClientAddress(attacker));
    }
    const url = new URL('http://localhost/v4/info');
    const attackerDecision = admission.admit(admission.resolveContext(attacker, url));
    const bystanderDecision = admission.admit(admission.resolveContext(bystander, url));
    assert.equal(attackerDecision.allowed, false);
    assert.equal(attackerDecision.status, 403);
    assert.equal(bystanderDecision.allowed, true);
    // The proxy itself keeps accepting connections.
    assert.equal(admission.admitConnection('::ffff:127.0.0.1'), true);
    admission.releaseConnection('::ffff:127.0.0.1');
});
test('trusted proxies use an aggregate pool that is released on close', (t) => {
    const admission = createAdmission({
        trustProxy: true,
        trustedProxies: ['127.0.0.1'],
        ip: { maxConcurrentSockets: 2, maxProxySockets: 3 }
    });
    t.after(() => admission.destroy());
    const proxy = '::ffff:127.0.0.1';
    for (let index = 0; index < 3; index++) {
        assert.equal(admission.admitConnection(proxy), true);
    }
    assert.equal(admission.admitConnection(proxy), false);
    admission.releaseConnection(proxy);
    assert.equal(admission.admitConnection(proxy), true);
    // Direct peers keep their per-IP limit.
    assert.equal(admission.admitConnection('203.0.113.7'), true);
    assert.equal(admission.admitConnection('203.0.113.7'), true);
    assert.equal(admission.admitConnection('203.0.113.7'), false);
});
test('trustProxy without trustedProxies ignores forwarding headers', (t) => {
    const admission = createAdmission({ trustProxy: true, trustedProxies: [] });
    t.after(() => admission.destroy());
    const request = proxiedRequest('198.51.100.66');
    assert.equal(admission.resolveClientAddress(request), '127.0.0.1');
    assert.equal(admission.isTrustedProxy('127.0.0.1'), false);
});
