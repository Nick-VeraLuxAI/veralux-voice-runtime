import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setTestEnv } from './testEnv';

setTestEnv();

test('sessionManager creates and tears down sessions', async () => {
  const { SessionManager } = await import('../src/calls/sessionManager');

  const manager = new SessionManager({
    capacityRelease: async () => {
      return;
    },
  });

  const session = manager.createSession(
    {
      callControlId: 'call-1',
      tenantId: 'tenant-1',
    },
    {},
    { autoAnswer: false },
  );

  assert.equal(session.callControlId, 'call-1');
  assert.equal(manager.pushAudio('call-1', Buffer.from([0, 1, 2])), true);

  manager.teardown('call-1', 'test');

  assert.equal(manager.pushAudio('call-1', Buffer.from([0])), false);
});