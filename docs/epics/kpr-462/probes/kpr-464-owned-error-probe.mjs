import assert from 'node:assert/strict';
import { AsyncLocalStorage } from 'node:async_hooks';
import { Agent, AgentSession, AgentSessionEventTypes, LLM, LLMStream,
  DEFAULT_API_CONNECT_OPTIONS, DEFAULT_SESSION_CONNECT_OPTIONS, initializeLogger } from '@livekit/agents';
initializeLogger({ pretty: false, level: 'silent' });
const context = new AsyncLocalStorage();
const gate = () => Promise.withResolvers();
async function until(check, label) {
  for (let i = 0; i < 1000; i++) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  throw new Error(`timeout: ${label}`);
}
class OwnedError extends Error { constructor(turnId) { super('test-local bridge error'); this.turnId = turnId; } }
class Stream extends LLMStream {
  constructor(owner, args, assignment) { super(owner, args); this.owner = owner; this.assignment = assignment; }
  async run() {
    const a = this.assignment;
    a.entered.resolve();
    if (a.release) await a.release.promise;
    if (a.mode !== 'text') {
      const error = a.mode === 'owned' ? new OwnedError(a.turnId) : new Error('unrelated provider failure');
      if (error instanceof OwnedError) {
        this.owner.failures.set(error.turnId, error);
        this.owner.events.push({ kind: 'application_failure', turnId: error.turnId });
      }
      throw error;
    }
    this.queue.put({ id: a.turnId, delta: { role: 'assistant', content: 'replacement' } });
  }
}
class Model extends LLM {
  constructor(routeOwned) {
    super(); this.assignments = []; this.events = []; this.failures = new Map();
    if (routeOwned) this.prependListener('error', (event) => {
      const error = event.error;
      if (!(error instanceof OwnedError) || this.failures.get(error.turnId) !== error) return;
      // Same public event reaches SDK listeners after this early listener.
      event.recoverable = true;
      this.failures.delete(error.turnId);
      this.events.push({ kind: 'owned_route', turnId: error.turnId, context: context.getStore()?.turnId });
    });
  }
  label() { return 'owned-error-test-local'; }
  chat({ chatCtx, toolCtx, connOptions = DEFAULT_API_CONNECT_OPTIONS }) {
    const a = this.assignments.shift(); assert.ok(a);
    return context.run(Object.freeze({ turnId: a.turnId }), () => new Stream(this,
      { chatCtx, toolCtx, connOptions: { ...connOptions, maxRetry: 0 } }, a));
  }
}
async function run(routeOwned, mode) {
  const model = new Model(routeOwned);
  const session = new AgentSession({ llm: model, vad: null, turnHandling: { turnDetection: null } });
  session.output.setAudioEnabled(false);
  const errors = [], metrics = [];
  let closed = false;
  session.on(AgentSessionEventTypes.Close, () => { closed = true; });
  session.on(AgentSessionEventTypes.Error, (ev) => errors.push(ev.error));
  session.on(AgentSessionEventTypes.MetricsCollected, ({ metrics: m }) => {
    if (m.type === 'llm_metrics') metrics.push({ speechId: m.speechId, turnId: context.getStore()?.turnId });
  });
  const max = DEFAULT_SESSION_CONNECT_OPTIONS.maxUnrecoverableErrors;
  const handles = [];
  try {
    await session.start({ agent: new Agent({ instructions: 'offline test only' }) });
    for (let i = 0; i < max; i++) {
      const a = { mode, turnId: `prior-${i}`, entered: gate() };
      model.assignments.push(a); const handle = session.generateReply(); handles.push(handle);
      await until(() => handle.done(), 'prior handle settlement');
    }
    assert.equal(closed, false);
    const old = { mode, turnId: 'old-at-threshold', entered: gate(), release: gate() };
    model.assignments.push(old); const oldHandle = session.generateReply(); handles.push(oldHandle);
    await old.entered.promise;
    let nextHandle;
    if (routeOwned && mode === 'owned') {
      const next = { mode: 'text', turnId: 'replacement', entered: gate(), release: gate() };
      model.assignments.push(next); nextHandle = session.generateReply();
      assert.equal(nextHandle.done(), false);
      old.release.resolve();
      await until(() => oldHandle.done(), 'old error settlement with replacement queued');
      assert.equal(closed, false);
      next.release.resolve();
      await until(() => nextHandle.done(), 'replacement text settlement');
      assert.equal(closed, false);
      assert.ok(nextHandle.chatItems.some((item) => item.type === 'message' && item.textContent?.includes('replacement')));
      assert.equal(errors.length, max + 1);
      assert.ok(errors.every((error) => error.recoverable === true));
      for (let i = 0; i < handles.length; i++) {
        const turnId = i < max ? `prior-${i}` : 'old-at-threshold';
        assert.ok(metrics.some((m) => m.turnId === turnId && m.speechId === handles[i].id));
      }
      assert.equal(model.events.filter((e) => e.kind === 'owned_route').length, max + 1);
      for (const event of model.events.filter((e) => e.kind === 'owned_route')) {
        assert.equal(event.context, event.turnId);
        assert.ok(model.events.findIndex((e) => e.kind === 'application_failure' && e.turnId === event.turnId)
          < model.events.indexOf(event), 'application failure precedes routing');
      }
    } else {
      old.release.resolve();
      await until(() => closed, 'SDK closes at original unrecoverable threshold');
      assert.equal(errors.length, max + 1);
      assert.ok(errors.every((error) => error.recoverable === false));
    }
    return { routeOwned, mode, maxUnrecoverableErrors: max, errorCount: errors.length,
      closedBeforeCleanup: closed, replacementCompleted: nextHandle?.done() ?? null,
      metricBindings: metrics, applicationRouteEvents: model.events };
  } finally { await session.close(); }
}
const results = [await run(false, 'owned'), await run(true, 'owned'), await run(true, 'unrelated')];
console.log(JSON.stringify({ node: process.version, results,
  limits: 'Test-local public event routing and real SDK lifecycle. Replacement is text-only; production recovery, TTS/output and live audio are later regressions.' }, null, 2));
