'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { requestAgentRuntime } = require('../electron/agent-runtime-client.cjs');

const cache = path.resolve(__dirname, '../..', '.test-cache');
fs.mkdirSync(cache, { recursive: true });
function fixture(t) {
  const root = fs.mkdtempSync(path.join(cache, 'agent-runtime-client-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}
function token(state, content) {
  fs.mkdirSync(state, { recursive: true });
  fs.writeFileSync(path.join(state, 'agent-runtime-ui.token'), content);
}

test('missing source-instance token gives an actionable error and never contacts another installation', async t => {
  const root = fixture(t);
  token(path.join(root, 'other-live', 'data', 'state'), 'other-instance');
  let requests = 0;
  await assert.rejects(requestAgentRuntime({ root, config: {}, env: {}, action: 'list',
    fetch: async () => { ++requests; }
  }), error => error.message.includes('安装目录') && !error.message.includes('ENOENT') && !error.message.includes(root));
  assert.equal(requests, 0);
});

test('configured state directory and rotated token recover without opening a new window', async t => {
  const root = fixture(t);
  const state = path.join(root, 'configured-state');
  token(state, 'original-token\n');
  const seen = [];
  const list = await requestAgentRuntime({ root, env: {}, action: 'list',
    config: { stateDir: state, port: 17689 },
    fetch: async (url, request) => {
      assert.equal(url, 'http://127.0.0.1:17689/agent-runtime/local');
      seen.push(request.headers['x-devspace-agent-token']);
      if (seen.length === 1) {
        token(state, 'rotated-token');
        return new Response('', { status: 403 });
      }
      return Response.json([{ id: 'agent-test' }]);
    },
  });
  assert.deepEqual(seen, ['original-token', 'rotated-token']);
  assert.deepEqual(list, [{ id: 'agent-test' }]);
});

test('missing service or stable token mismatch returns a local-service error and does not replay mutations', async t => {
  const root = fixture(t);
  const state = path.join(root, 'data', 'state');
  token(state, 'test-token');
  const params = { root, config: {}, env: {}, action: 'clear-history' };
  let calls = 0;
  await assert.rejects(requestAgentRuntime({ ...params, fetch: async () => { ++calls; throw Error('socket closed'); } }),
    /AGENT_RUNTIME_UNAVAILABLE.*无法连接/);
  await assert.rejects(requestAgentRuntime({ ...params, fetch: async () => { ++calls; return new Response('', { status: 403 }); } }),
    /AGENT_RUNTIME_UNAVAILABLE.*不匹配/);
  assert.equal(calls, 2);
});
