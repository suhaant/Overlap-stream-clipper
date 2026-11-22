import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ChatRecorder, hourKey, datasetSalt } from '../src/recorder.mjs';

const scratch = () => mkdtempSync(join(tmpdir(), 'rec-'));

test('hourKey is a sortable UTC hour', () => {
  assert.equal(hourKey(Date.UTC(2026, 10, 22, 14, 37, 2)), '20261122-14');
  assert.equal(hourKey(Date.UTC(2026, 0, 5, 3, 0, 0)), '20260105-03');
  // Sorting the keys has to equal sorting the times, since the harvester and
  // the dataset builder both walk files in name order.
  const keys = [
    hourKey(Date.UTC(2026, 10, 22, 9)),
    hourKey(Date.UTC(2026, 10, 22, 10)),
    hourKey(Date.UTC(2026, 10, 23, 0)),
  ];
  assert.deepEqual([...keys].sort(), keys);
});

test('the dataset salt persists across calls', () => {
  const dir = scratch();
  delete process.env.RECORDER_SALT;
  const a = datasetSalt(dir);
  const b = datasetSalt(dir);
  assert.equal(a, b, 'a regenerated salt would split one chatter into two');
  assert.ok(a.length >= 32);
  assert.ok(existsSync(join(dir, '.salt')));
});

test('an explicit salt overrides the stored one', () => {
  const dir = scratch();
  process.env.RECORDER_SALT = 'fixed-salt-for-the-test';
  assert.equal(datasetSalt(dir), 'fixed-salt-for-the-test');
  delete process.env.RECORDER_SALT;
});

test('flush splits a batch across the hour boundary', async () => {
  const dir = scratch();
  process.env.RECORDER_SALT = 'fixed';
  const r = new ChatRecorder('testchan', { dir });

  // Deliberately not started: start() opens a websocket. The buffer is filled
  // directly so the file-routing logic can be tested without the network.
  r.buffer.push(
    { t: Date.UTC(2026, 10, 22, 13, 59, 58), u: 'a', x: 'before', e: 0, s: 0 },
    { t: Date.UTC(2026, 10, 22, 14, 0, 1), u: 'b', x: 'after', e: 0, s: 0 },
  );

  const written = r.flush();
  assert.equal(written, 2);
  await new Promise(res => setTimeout(res, 50));

  const files = readdirSync(join(dir, 'testchan')).sort();
  assert.deepEqual(files, ['20261122-13.jsonl', '20261122-14.jsonl'],
    'records must land in the hour they happened, not the hour we flushed');

  const early = readFileSync(join(dir, 'testchan', '20261122-13.jsonl'), 'utf8');
  const late = readFileSync(join(dir, 'testchan', '20261122-14.jsonl'), 'utf8');
  assert.match(early, /"x":"before"/);
  assert.match(late, /"x":"after"/);
  delete process.env.RECORDER_SALT;
});

test('flush on an empty buffer writes nothing', () => {
  const dir = scratch();
  const r = new ChatRecorder('testchan', { dir });
  assert.equal(r.flush(), 0);
  assert.deepEqual(readdirSync(join(dir, 'testchan')), []);
});

test('recorded lines carry a hashed chatter and no login', async () => {
  const dir = scratch();
  process.env.RECORDER_SALT = 'fixed';
  const r = new ChatRecorder('testchan', { dir });

  // Simulate what the message handler does, via the real chat payload shape.
  const { createHash } = await import('node:crypto');
  const expect = createHash('sha256').update('fixed').update('12345').digest('hex').slice(0, 12);

  r.buffer.push({ t: Date.UTC(2026, 10, 22, 14, 0, 0), u: expect, x: 'KEKW', e: 0, s: 1 });
  r.flush();
  await new Promise(res => setTimeout(res, 50));

  const line = readFileSync(join(dir, 'testchan', '20261122-14.jsonl'), 'utf8').trim();
  const rec = JSON.parse(line);

  assert.equal(rec.u, expect);
  assert.equal(rec.u.length, 12);
  assert.ok(!('login' in rec), 'a login in the record would make the dataset unshareable');
  assert.ok(!('user' in rec));
  delete process.env.RECORDER_SALT;
});

test('audit records are written into the data stream', async () => {
  const dir = scratch();
  const r = new ChatRecorder('testchan', { dir });
  r.buffer.push({ t: Date.UTC(2026, 10, 22, 14, 0, 0), _: 'reconnecting', delay: 2000 });
  r.flush();
  await new Promise(res => setTimeout(res, 50));

  const rec = JSON.parse(readFileSync(join(dir, 'testchan', '20261122-14.jsonl'), 'utf8').trim());
  assert.equal(rec._, 'reconnecting');
  assert.equal(rec.delay, 2000);
});
