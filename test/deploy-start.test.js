'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');

async function exerciseStartup(outcome) {
  const calls = [];
  const errors = [];
  const exits = [];
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../scripts/deploy-start.js'), 'utf8'), {
    require(name) {
      assert.equal(name, 'child_process');
      return { spawn(command, args, options) {
        calls.push({ command, args: Array.from(args), options });
        const child = new EventEmitter();
        queueMicrotask(() => outcome instanceof Error
          ? child.emit('error', outcome)
          : child.emit('exit', outcome));
        return child;
      } };
    },
    process: { platform: 'linux', exit(code) { exits.push(code); } },
    console: { error(error) { errors.push(error); } },
  });
  await new Promise(resolve => setImmediate(resolve));
  return { calls, errors, exits };
}

test('normal deploy startup spawns only the application, never migration or financial maintenance', async () => {
  const result = await exerciseStartup(0);
  assert.deepEqual(result.calls.map(({ command, args }) => ({ command, args })), [
    { command: 'node', args: ['index.js'] },
  ]);
  assert.equal(result.calls[0].options.stdio, 'inherit');
  assert.equal(result.calls[0].options.shell, false);
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.exits, []);
});

test('application failure stops startup without a maintenance fallback', async () => {
  for (const outcome of [1, new Error('spawn failed')]) {
    const result = await exerciseStartup(outcome);
    assert.equal(result.calls.length, 1);
    assert.deepEqual(result.calls[0].args, ['index.js']);
    assert.equal(result.errors.length, 1);
    assert.deepEqual(result.exits, [1]);
  }
});
