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
