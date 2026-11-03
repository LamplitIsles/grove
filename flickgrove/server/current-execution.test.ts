import { test, expect } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { CodexRuntime } from './codex';
import { Workspace } from './workspace';
import { HostService, qualify } from './hosts';
import { snapshotSchema, detailSchema } from '../src/chord-contract';

const until = async (f: () => boolean | Promise<boolean>) => { for (let n = 0; n < 500; n++) { if (await f()) return; await Bun.sleep(10); } throw new Error('fixture condition timed out'); };
function setup(root: string) {
  const runtime = new CodexRuntime({
    cwd: root, origin: () => 'http://127.0.0.1:9',
    codexPath: fileURLToPath(new URL('../tests/fake-codex.mjs', import.meta.url)),
    env: {
      ...Object.fromEntries(Object.keys(process.env).map(k => [k, undefined])), PATH: process.env.PATH,
      HOME: join(root, 'home'), CODEX_HOME: join(root, 'codex'), XDG_CONFIG_HOME: join(root, 'config'), XDG_CACHE_HOME: join(root, 'cache'), XDG_DATA_HOME: join(root, 'data'), TMPDIR: root,
      FAKE_SERVER_ROOT: root,
    },
  });
  const app = new Workspace({ directory: join(root, 'workspace'), runtime, projects: async () => [{ alias: 'fixture', name: 'fixture', path: root }], branches: { read: async () => null } });
  return { runtime, app };
}
function createRoot() { const root = mkdtempSync(join(tmpdir(), 'grove-current-view-')); for (const n of ['home', 'codex', 'config', 'cache', 'data']) mkdirSync(join(root, n)); return root; }
function controls(root: string, value: object) { writeFileSync(join(root, '.fake-app-server-control.json'), JSON.stringify(value)); }
test('cold restart original thread projects current idle and interrupted while prior outcome remains guarded', async () => {
  const root = createRoot(); controls(root, { hold: true, projectInterrupted: true });
  let f = setup(root);
  try {
    const owner = await f.app.createOrc('fixture');
    await f.app.send(owner.id, 'original input', 'operation-original');
    const before = f.app.detail(owner.id), threadId = before.threadId!, priorTurn = before.turnId!;
    expect(before.state).toBe('working');
    await f.app.enqueueFollowUp(owner.id, 'queued A', 'queued-a');
    await f.runtime.close(); f.app.dispose();
    const db = new Database(join(root, 'workspace', 'workspace.sqlite'));
    db.query("UPDATE deliveries SET status='uncertain', turn_id=NULL WHERE session_id=? AND operation_id=?").run(owner.id, 'operation-original');
    db.query("UPDATE sessions SET state='error', recovery=json_set(json_remove(recovery,'$.turnId'),'$.turnEnded',json('false'),'$.stop',json(?)), diagnostics=json_set(diagnostics,'$.error','App-server disconnected. Send a message to resume the thread.') WHERE id=?").run(JSON.stringify({ turnId: priorTurn, status: 'unknown' }), owner.id);
    db.close();
    f = setup(root);
    await f.app.reconcileSettings(owner.id);
    const restored = f.app.detail(owner.id);
    expect(restored.threadId).toBe(threadId); expect(restored.turnId).toBeUndefined(); expect(restored.workUnconfirmed).toBe(true);
    await until(() => f.app.detail(owner.id).currentExecution?.state === 'idle');
    expect(f.app.detail(owner.id).currentExecution).toEqual({ state: 'idle', lastInterrupted: true });
    const service = new HostService(f.app, { directory: join(root, 'host'), origin: () => 'http://127.0.0.1:9' });
    try {
      const qualified = qualify(service.identity.id, owner.id);
      expect(snapshotSchema.parse(service.snapshot()).agents.find((a) => a.id === qualified)?.currentExecution).toEqual({ state: 'idle', lastInterrupted: true });
      expect(detailSchema.parse(await service.detail(qualified)).currentExecution).toEqual({ state: 'idle', lastInterrupted: true });
    } finally { service.dispose(); }
    expect(f.app.lookup(owner.id, 'operation-original')).toBeNull();
    expect(f.app.recovery(owner.id, 'operation-original').text).toBe('original input');
    expect(f.app.detail(owner.id).stop).toMatchObject({ turnId: priorTurn, status: 'unknown' });
    await expect(f.app.stop(owner.id, priorTurn)).rejects.toThrow();
    expect(f.app.detail(owner.id).followUpPaused).toBe(true);
    expect(f.app.lookupFollowUp(owner.id, 'queued-a')?.status).toBe('waiting');
    expect(f.app.instanceBusy()).toBe(true);
    await expect(f.app.closeTree(owner.id)).rejects.toThrow();
    const calls = readFileSync(join(root, '.fake-app-server-requests.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
    expect(calls.filter(x => x.method === 'thread/turns/list' && x.params.threadId === threadId)).toHaveLength(1);
    expect(calls.filter(x => x.method === 'turn/start' && x.params.clientUserMessageId === 'operation-original')).toHaveLength(1);
    expect(calls.filter(x => x.method === 'turn/start' && x.params.clientUserMessageId === 'queued-a')).toHaveLength(0);
    expect(calls.filter(x => x.method === 'turn/interrupt')).toHaveLength(0);
    expect(f.app.detail(owner.id).workUnconfirmed).toBe(true);
    await f.runtime.close(); f.app.dispose();
    controls(root, { hold: true, projectInterrupted: true, holdResume: true });
    f = setup(root);
    expect(f.app.detail(owner.id).currentExecution).toBeUndefined();
    expect(f.app.lookup(owner.id, 'operation-original')).toBeNull();
    controls(root, { hold: true, projectInterrupted: true });
    await until(() => f.app.detail(owner.id).currentExecution?.state === 'idle');
  } finally { await f.runtime.close(); f.app.dispose(); rmSync(root, { recursive: true, force: true }); }
}, 30000);

async function seedInterrupted(root: string) {
  controls(root, { hold: true, projectInterrupted: true, trackThreadStatus: true });
  const old = setup(root);
  const owner = await old.app.createOrc('fixture');
  await old.app.rename(owner.id, 'Fixture');
  await old.app.send(owner.id, 'original input', 'operation-original');
  const { threadId, turnId } = old.app.detail(owner.id);
  await old.app.enqueueFollowUp(owner.id, 'queued A', 'queued-a');
  await old.runtime.close(); old.app.dispose();
  const db = new Database(join(root, 'workspace', 'workspace.sqlite'));
  db.query("UPDATE deliveries SET status='uncertain', turn_id=NULL WHERE session_id=? AND operation_id=?").run(owner.id, 'operation-original');
  db.query("UPDATE sessions SET state='error', recovery=json_set(json_remove(recovery,'$.turnId'),'$.turnEnded',json('false')) WHERE id=?").run(owner.id);
  db.close();
  return { owner, threadId: threadId!, turnId: turnId! };
}
function requests(root: string) {
  return readFileSync(join(root, '.fake-app-server-requests.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
}

test('a source-modeled writer lock prevents passive idle from establishing ownership', async () => {
  const root = createRoot();
  const { owner, threadId } = await seedInterrupted(root);
  controls(root, { hold: true, projectInterrupted: true, lockedThreads: [threadId] });
  const f = setup(root);
  try {
    const client = await f.runtime['getCatalog']();
    expect((await client.threadRead({ threadId, includeTurns: false })).thread.status.type).toBe('idle');
    await expect(f.app.reconcileSettings(owner.id)).rejects.toThrow('in use by another Codex instance');
    expect(f.app.detail(owner.id).currentExecution).toBeUndefined();
    expect(f.app.detail(owner.id).workUnconfirmed).toBe(true);
    expect(f.app.lookup(owner.id, 'operation-original')).toBeNull();
    await expect(f.app.closeTree(owner.id)).rejects.toThrow();
    expect(requests(root).filter((r) => r.method === 'turn/start' && r.params.clientUserMessageId === 'operation-original')).toHaveLength(1);
  } finally { await f.runtime.close(); f.app.dispose(); rmSync(root, { recursive: true, force: true }); }
}, 30000);

test('a resume response for a different thread never acquires the old identity', async () => {
  const root = createRoot();
  const { owner, threadId } = await seedInterrupted(root);
  controls(root, { hold: true, projectInterrupted: true, resumeThreadId: 'other-thread' });
  const f = setup(root);
  try {
    await expect(f.app.reconcileSettings(owner.id)).rejects.toThrow('Resumed thread identity changed');
    expect(f.app.detail(owner.id).threadId).toBe(threadId);
    expect(f.app.detail(owner.id).currentExecution).toBeUndefined();
    expect(f.app.lookup(owner.id, 'operation-original')).toBeNull();
  } finally { await f.runtime.close(); f.app.dispose(); rmSync(root, { recursive: true, force: true }); }
}, 30000);

test('the interruption marker belongs to the newest native turn only', async () => {
  const root = createRoot();
  const { owner, threadId } = await seedInterrupted(root);
  const path = join(root, '.fake-app-server-state.json');
  const native = JSON.parse(readFileSync(path, 'utf8'));
  const turns = native.threads[threadId].turns;
  turns.push({ ...turns[0], id: 'later-completed', status: 'completed', items: [] });
  writeFileSync(path, JSON.stringify(native));
  controls(root, { hold: true, projectInterrupted: true, trackThreadStatus: true });
  const f = setup(root);
  try {
    await until(() => f.app.detail(owner.id).currentExecution?.state === 'idle');
    expect(f.app.detail(owner.id).currentExecution).toEqual({ state: 'idle' });
    expect(f.app.lookup(owner.id, 'operation-original')).toBeNull();
  } finally { await f.runtime.close(); f.app.dispose(); rmSync(root, { recursive: true, force: true }); }
}, 30000);

test('a pending start invalidates an in-flight idle read; new B leaves A paused', async () => {
  const root = createRoot();
  const { owner, threadId } = await seedInterrupted(root);
  controls(root, { hold: true, projectInterrupted: true, trackThreadStatus: true, holdTurnsList: true, holdTurnAdmission: true });
  const f = setup(root);
  let pending: Promise<unknown> | undefined;
  try {
    await until(() => requests(root).some((r) => r.method === 'thread/turns/list' && r.params.threadId === threadId));
    pending = f.app.send(owner.id, 'new B', 'operation-b');
    await until(() => requests(root).some((r) => r.method === 'turn/start' && r.params.clientUserMessageId === 'operation-b'));
    controls(root, { hold: true, projectInterrupted: true, trackThreadStatus: true, holdTurnAdmission: true });
    await Bun.sleep(100);
    expect(f.app.detail(owner.id).currentExecution).toBeUndefined();
    expect(f.app.lookup(owner.id, 'operation-b')).toBeNull();
    expect(f.app.detail(owner.id).workUnconfirmed).toBe(true);
    controls(root, { hold: true, projectInterrupted: true, trackThreadStatus: true });
    await pending;
    expect(f.app.detail(owner.id).state).toBe('working');
    controls(root, {
      hold: true, projectInterrupted: true, trackThreadStatus: true,
      notifications: [{ id: 'active-after-b', method: 'thread/status/changed', params: { threadId, status: { type: 'active', activeFlags: [] } } }]
    });
    await until(() => f.app.detail(owner.id).currentExecution?.state === 'working');
    expect(f.app.detail(owner.id).followUpPaused).toBe(true);
    expect(f.app.lookupFollowUp(owner.id, 'queued-a')?.status).toBe('waiting');
    expect(f.app.lookup(owner.id, 'operation-original')).toBeNull();
    expect(requests(root).filter((r) => r.method === 'turn/start' && r.params.clientUserMessageId === 'queued-a')).toHaveLength(0);
  } finally { controls(root, {}); await pending?.catch(() => { }); await f.runtime.close(); f.app.dispose(); rmSync(root, { recursive: true, force: true }); }
}, 30000);

test('a published idle view is removed immediately by new work and disconnect', async () => {
  const root = createRoot();
  const { owner } = await seedInterrupted(root);
  controls(root, { hold: true, projectInterrupted: true, trackThreadStatus: true });
  const f = setup(root);
  try {
    await until(() => f.app.detail(owner.id).currentExecution?.state === 'idle');
    expect(f.app.snapshot().agents.find((a) => a.id === owner.id)?.currentExecution?.state).toBe('idle');
    controls(root, { hold: true, projectInterrupted: true, trackThreadStatus: true, holdTurnsList: true });
    await f.app.send(owner.id, 'new B', 'operation-b');
    expect(f.app.detail(owner.id).currentExecution).toBeUndefined();
    expect(f.app.detail(owner.id).state).toBe('working');
    await f.runtime.close();
    controls(root, { hold: true, projectInterrupted: true, trackThreadStatus: true });
    await Bun.sleep(100);
    expect(f.app.detail(owner.id).currentExecution).toBeUndefined();
    expect(f.app.detail(owner.id).workUnconfirmed).toBe(true);
    expect(f.app.lookup(owner.id, 'operation-original')).toBeNull();
  } finally { controls(root, {}); await f.runtime.close(); f.app.dispose(); rmSync(root, { recursive: true, force: true }); }
}, 30000);

test('thread status notifications invalidate a published view while rechecking', async () => {
  const root = createRoot();
  const { owner, threadId } = await seedInterrupted(root);
  controls(root, { hold: true, projectInterrupted: true, trackThreadStatus: true });
  const f = setup(root);
  try {
    await until(() => f.app.detail(owner.id).currentExecution?.state === 'idle');
    await f.app.send(owner.id, 'new B', 'operation-b');
    controls(root, {
      hold: true, projectInterrupted: true, trackThreadStatus: true,
      notifications: [{ id: 'status-initial', method: 'thread/status/changed', params: { threadId, status: { type: 'active', activeFlags: [] } } }]
    });
    await until(() => f.app.detail(owner.id).currentExecution?.state === 'working');
    const before = requests(root).filter((r) => r.method === 'thread/turns/list').length;
    controls(root, {
      hold: true, projectInterrupted: true, trackThreadStatus: true, holdTurnsList: true,
      notifications: [{ id: 'status-active', method: 'thread/status/changed', params: { threadId, status: { type: 'active', activeFlags: [] } } }]
    });
    await until(() => requests(root).filter((r) => r.method === 'thread/turns/list').length > before);
    expect(f.app.detail(owner.id).currentExecution).toBeUndefined();
    controls(root, { hold: true, projectInterrupted: true, trackThreadStatus: true });
    await until(() => f.app.detail(owner.id).currentExecution?.state === 'working');
    expect(f.app.lookup(owner.id, 'operation-original')).toBeNull();
  } finally { controls(root, {}); await f.runtime.close(); f.app.dispose(); rmSync(root, { recursive: true, force: true }); }
}, 30000);

test('read failure, notLoaded, identity mismatch and disconnect cannot publish an idle view', async () => {
  for (const mode of ['turnListError', 'notLoaded', 'systemError', 'wrongThread', 'disconnect'] as const) {
    const root = createRoot();
    const { owner, threadId } = await seedInterrupted(root);
    const config: Record<string, unknown> = { hold: true, projectInterrupted: true, holdTurnsList: true };
    controls(root, config);
    const f = setup(root);
    try {
      await until(() => requests(root).some((r) => r.method === 'thread/turns/list' && r.params.threadId === threadId));
      if (mode === 'disconnect') {
        await f.runtime.close();
        controls(root, { hold: true, projectInterrupted: true });
      } else {
        delete config.holdTurnsList;
        if (mode === 'turnListError') config.turnListError = true;
        if (mode === 'notLoaded') config.readStatus = 'notLoaded';
        if (mode === 'systemError') config.readStatus = 'systemError';
        if (mode === 'wrongThread') config.historyThreads = [{ thread: { id: threadId, ephemeral: false, status: { type: 'idle' } } }];
        // A distinct identity in the read response after resume.
        if (mode === 'wrongThread') config.readThreadId = 'other-thread';
        controls(root, config);
      }
      await Bun.sleep(200);
      expect(f.app.detail(owner.id).currentExecution).toBeUndefined();
      expect(f.app.detail(owner.id).workUnconfirmed).toBe(true);
      expect(f.app.lookup(owner.id, 'operation-original')).toBeNull();
    } finally { controls(root, {}); await f.runtime.close(); f.app.dispose(); rmSync(root, { recursive: true, force: true }); }
  }
}, 30000);
