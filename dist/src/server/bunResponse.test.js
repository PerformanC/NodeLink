import assert from 'node:assert/strict';
import test from 'node:test';
import { BunResponseShim } from './bunResponse.js';
test('BunResponseShim copies written chunks before acknowledging the write', async () => {
    let response;
    const shim = new BunResponseShim({
        resolve: (value) => {
            response = value;
        }
    });
    const original = Buffer.from('original');
    await new Promise((resolve, reject) => {
        shim.write(original, (error) => (error ? reject(error) : resolve()));
    });
    // The producer is allowed to reuse its buffer once the write is acknowledged.
    original.fill(0x78);
    shim.end();
    assert.ok(response);
    assert.equal(await response.text(), 'original');
});
test('BunResponseShim settles a backpressured write when the response is cancelled', async () => {
    let response;
    const shim = new BunResponseShim({
        resolve: (value) => {
            response = value;
        }
    });
    // Fill the ReadableStream queue (high-water mark 8) without consuming it, so
    // the last write is parked waiting for the reader.
    const settled = [];
    for (let i = 0; i < 8; i++) {
        shim.write(Buffer.from(`chunk-${i}`), (error) => {
            settled.push(error);
        });
    }
    await new Promise((resolve) => setImmediate(resolve));
    assert.ok(response);
    assert.equal(settled.length, 7, 'last write is still backpressured');
    assert.equal(shim.writableLength > 0, true);
    await response.body?.cancel();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(settled.length, 8, 'pending write callback was settled');
    const last = settled[7];
    assert.equal(last?.code, 'ERR_STREAM_PREMATURE_CLOSE');
    assert.equal(shim.destroyed, true);
    assert.equal(shim.writableLength, 0, 'no pending write state retained');
});
