import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setTestEnv } from './testEnv';

setTestEnv();

class MockRedis {
  public evalshaCalls: Array<{ sha: string; numKeys: number; keys: string[]; args: string[] }> = [];
  public evalCalls: Array<{ script: string; numKeys: number; keys: string[]; args: string[] }> = [];

  constructor(private readonly result: string) {}

  async script(_command: string, _script: string): Promise<string> {
    return 'mock-sha';
  }

  async evalsha(sha: string, numKeys: number, ...rest: string[]): Promise<string> {
    const keys = rest.slice(0, numKeys);
    const args = rest.slice(numKeys);
    this.evalshaCalls.push({ sha, numKeys, keys, args });
    return this.result;
  }

  async eval(script: string, numKeys: number, ...rest: string[]): Promise<string> {
    const keys = rest.slice(0, numKeys);
    const args = rest.slice(numKeys);
    this.evalCalls.push({ script, numKeys, keys, args });
    return this.result;
  }

  async srem(): Promise<number> {
    return 1;
  }
}

test('tryAcquire maps tenant_at_capacity result', async () => {
  const { tryAcquire } = await import('../src/limits/capacity');
  const mockRedis = new MockRedis('tenant_at_capacity');
  const result = await tryAcquire({
    tenantId: 'tenant-a',
    callControlId: 'call-1',
    redis: mockRedis as never,
    nowEpochMs: Date.UTC(2024, 0, 2, 3, 4, 5),
  });

  assert.deepEqual(result, { ok: false, reason: 'tenant_at_capacity' });
});

test('tryAcquire builds expected keys and args', async () => {
  const { tryAcquire } = await import('../src/limits/capacity');
  const mockRedis = new MockRedis('OK');
  const nowEpochMs = Date.UTC(2024, 0, 2, 3, 4, 5);

  const result = await tryAcquire({
    tenantId: 'tenant-a',
    callControlId: 'call-2',
    redis: mockRedis as never,
    nowEpochMs,
  });

  assert.deepEqual(result, { ok: true });
  assert.equal(mockRedis.evalshaCalls.length, 1);

  const call = mockRedis.evalshaCalls[0];
  assert.deepEqual(call.keys, [
    'cap:global:active',
    'cap:tenant:tenant-a:active',
    'cap:tenant:tenant-a:rpm:202401020304',
    'tenantmap:tenant:tenant-a:cap:concurrency',
    'tenantmap:tenant:tenant-a:cap:rpm',
  ]);
  assert.deepEqual(call.args, ['call-2', '30', '5', '10', '600']);
});