import assert from 'node:assert/strict';
import test from 'node:test';
import WebSocketServer from '@performanc/pwsl-server';
import requestHandler from '../api/index.js';
import AdmissionManager from '../managers/admissionManager.js';
import { createHttpServer } from './httpServer.js';
const PASSWORD = 'test-password';
async function startServer(config) {
    const options = {
        server: { password: PASSWORD },
        playback: { voiceReceive: { enabled: false } },
        cluster: {},
        api: {}
    };
    const admission = new AdmissionManager({ options }, config);
    const socketBus = new WebSocketServer();
    const context = {
        options,
        admissionManager: admission,
        socket: socketBus,
        sessions: { isResumable: () => false },
        pluginManager: { callHook: () => { } },
        statsManager: {
            incrementApiRequest: () => { },
            recordHttpRequestDuration: () => { }
        },
        extensions: { middlewares: [], routes: [] }
    };
    const server = createHttpServer(context, () => Promise.resolve(requestHandler));
    /* INFO: Upgraded sockets are not closed by closeAllConnections, so a failing test would hang teardown */
    const sockets = new Set();
    server.on('connection', (socket) => sockets.add(socket));
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address();
    return {
        url: `ws://127.0.0.1:${port}/v4/websocket`,
        restUrl: `http://127.0.0.1:${port}/v4/nodelink-test-route`,
        socketBus,
        close: async () => {
            admission.destroy();
            for (const socket of sockets)
                socket.destroy();
            await new Promise((resolve) => server.close(() => resolve()));
        }
    };
}
function connect(url, forwardedFor, password = PASSWORD) {
    const headers = {
        Authorization: password,
        'Client-Name': 'release-test/1.0.0',
        'User-Id': '123456789012345678'
    };
    if (forwardedFor)
        headers['X-Forwarded-For'] = forwardedFor;
    return new Promise((resolve) => {
        const ws = new WebSocket(url, { headers });
        ws.addEventListener('open', () => resolve(ws), { once: true });
        ws.addEventListener('error', () => resolve(null), { once: true });
    });
}
async function closeClient(ws) {
    if (ws.readyState === WebSocket.CLOSED)
        return;
    const closed = new Promise((resolve) => ws.addEventListener('close', resolve, { once: true }));
    ws.close(1000, 'done');
    await closed;
}
/* INFO: The server releases on its own close handling, which can trail the client's close event */
async function connectEventually(url, forwardedFor) {
    for (let attempt = 0; attempt < 20; attempt++) {
        const ws = await connect(url, forwardedFor);
        if (ws)
            return ws;
        await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return null;
}
test('direct peers get their socket slots back after normal closes', async (t) => {
    const harness = await startServer({
        ip: { maxConcurrentSockets: 2 }
    });
    t.after(() => harness.close());
    for (let round = 0; round < 3; round++) {
        const first = await connectEventually(harness.url);
        const second = await connectEventually(harness.url);
        assert.ok(first && second, `round ${round}: both connections open`);
        assert.equal(await connect(harness.url), null, 'third is over the limit');
        await closeClient(first);
        await closeClient(second);
    }
});
test('proxied clients release both per-client and proxy pools', async (t) => {
    const harness = await startServer({
        trustProxy: true,
        trustedProxies: ['127.0.0.1'],
        ip: {
            maxConcurrentSockets: 2,
            maxProxySockets: 3
        }
    });
    t.after(() => harness.close());
    for (let round = 0; round < 3; round++) {
        const a1 = await connectEventually(harness.url, '198.51.100.1');
        const a2 = await connectEventually(harness.url, '198.51.100.1');
        assert.ok(a1 && a2, `round ${round}: client A gets two sockets`);
        assert.equal(await connect(harness.url, '198.51.100.1'), null, 'client A is capped per client');
        const b1 = await connectEventually(harness.url, '198.51.100.2');
        assert.ok(b1, 'client B is unaffected by client A');
        assert.equal(await connect(harness.url, '198.51.100.3'), null, 'proxy aggregate pool is full');
        await closeClient(a1);
        await closeClient(a2);
        await closeClient(b1);
    }
});
test('server-side destroy releases the slot', async (t) => {
    const harness = await startServer({
        ip: { maxConcurrentSockets: 1 }
    });
    t.after(() => harness.close());
    harness.socketBus.on('/v4/websocket', (ws) => {
        setTimeout(() => ws.destroy(), 10);
    });
    for (let round = 0; round < 3; round++) {
        const ws = await connectEventually(harness.url);
        assert.ok(ws, `round ${round}: slot available after server destroy`);
        await new Promise((resolve) => ws.readyState === WebSocket.CLOSED
            ? resolve(null)
            : ws.addEventListener('close', resolve, { once: true }));
    }
});
async function restStatus(url, forwardedFor, password = PASSWORD) {
    const response = await fetch(url, {
        headers: { Authorization: password, 'X-Forwarded-For': forwardedFor }
    });
    await response.body?.cancel();
    return response.status;
}
const proxyConfig = {
    trustProxy: true,
    trustedProxies: ['127.0.0.1']
};
test('REST auth failures behind a proxy ban only the offending client', async (t) => {
    const harness = await startServer(proxyConfig);
    t.after(() => harness.close());
    for (let attempt = 0; attempt < 5; attempt++) {
        assert.equal(await restStatus(harness.restUrl, '198.51.100.66', 'wrong'), 401);
    }
    assert.equal(await restStatus(harness.restUrl, '198.51.100.66'), 403);
    assert.equal(await restStatus(harness.restUrl, '6.6.6.6, 198.51.100.66'), 403, 'a spoofed leftmost hop does not lift the ban');
    assert.equal(await restStatus(harness.restUrl, '198.51.100.10'), 404);
    const bystander = await connectEventually(harness.url, '198.51.100.10');
    assert.ok(bystander, 'other clients behind the proxy still connect');
    await closeClient(bystander);
});
test('WebSocket auth failures behind a proxy ban only the offending client', async (t) => {
    const harness = await startServer(proxyConfig);
    t.after(() => harness.close());
    for (let attempt = 0; attempt < 5; attempt++) {
        assert.equal(await connect(harness.url, '198.51.100.66', 'wrong'), null);
    }
    assert.equal(await connect(harness.url, '198.51.100.66'), null);
    assert.equal(await restStatus(harness.restUrl, '198.51.100.66'), 403);
    const bystander = await connectEventually(harness.url, '198.51.100.10');
    assert.ok(bystander, 'other clients behind the proxy still connect');
    await closeClient(bystander);
});
