/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Config } from '@qwen-code/qwen-code-core';
import {
  AgentEventEmitter,
  AgentEventType,
  AgentTerminateMode,
  ContextState,
  type ExternalAgentExecutorParams,
  type SubagentExecutor,
} from '@qwen-code/qwen-code-core/subagentRuntime';
import { codexExternalAgentExecutor } from './codex-subagent-executor.js';

const fixture = String.raw`
import { createInterface } from 'node:readline';
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
const scenario = process.argv[1];
if (scenario.startsWith('slow-')) process.on('SIGTERM', () => {
  if (scenario === 'slow-error') writeFileSync(process.argv[2], 'cleaning');
});
let thread;
let task;
let descendant;
let interaction;
const send = (value) => process.stdout.write(JSON.stringify(value) + '\n');
const reply = (id, result) => send({id, result});
const notify = (method, params) => send({method, params: {threadId:'thread', ...params}});
const finish = () => {
  notify('item/completed', {turnId:'turn', item:{type:'agentMessage',phase:'commentary',text:'not final'}});
  if (scenario !== 'missing-answer') notify('item/completed', {
    turnId: scenario === 'wrong-turn' ? 'foreign' : 'turn',
    item:{type:'agentMessage',phase: scenario === 'unphased' ? null : 'final_answer',
      text:JSON.stringify({thread,task,pid:process.pid,descendant,interaction,env:process.env.CODEX_THREAD_ID ?? null})}
  });
  notify('turn/completed', {turn:{id:'turn',status: scenario === 'failed' ? 'failed' : 'completed'}});
};
createInterface({input:process.stdin}).on('line', line => {
  const frame = JSON.parse(line);
  if (frame.method === 'initialize') {
    if (scenario === 'init-hang') return;
    return reply(frame.id, {});
  }
  if (frame.method === 'thread/start') {
    thread = frame.params;
    return reply(frame.id, {thread:{id:'thread',ephemeral:scenario !== 'durable'}});
  }
  if (frame.method === 'turn/start') {
    task = frame.params;
    reply(frame.id, {turn:{id:'turn'}});
    if (scenario.startsWith('slow-')) {
      writeFileSync(process.argv[2], 'ready');
      if (scenario === 'slow-error') process.stdout.write('invalid json\n');
      return;
    }
    if (scenario === 'hold') return;
    if (scenario === 'bad-json') return process.stdout.write('invalid json\n');
    if (scenario === 'close') return process.stdout.end();
    if (scenario === 'tree') {
      const child = spawn(process.execPath, ['-e','process.on("SIGTERM",()=>{});process.send("ready");setInterval(()=>{},1000)'], {stdio:['ignore','ignore','ignore','ipc']});
      descendant = child.pid;
      child.once('message', finish);
      return;
    }
    const requests = {
      approval:'item/commandExecution/requestApproval',
      'file-approval':'item/fileChange/requestApproval',
      permissions:'item/permissions/requestApproval',
      question:'item/tool/requestUserInput',
      elicitation:'mcpServer/elicitation/request',
      'unknown-request':'future/request',
    };
    if (requests[scenario]) {
      return send({id:100,method:requests[scenario],params:{availableDecisions:['accept','decline']}});
    }
    finish();
  }
  if (frame.id === 100 && !frame.method) {
    interaction = frame.result;
    if (scenario === 'approval' && frame.result?.decision !== 'decline') process.exit(42);
    finish();
  }
});
setInterval(()=>{},1000);
`;

const executors: SubagentExecutor[] = [];
afterEach(async () => {
  await Promise.all(
    executors.splice(0).map((executor) => executor.dispose?.()),
  );
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

function params(scenario = 'normal'): ExternalAgentExecutorParams {
  const runtimeContext = new Config({
    sessionId: 'codex-fixture',
    targetDir: process.cwd(),
    cwd: process.cwd(),
    model: 'unused',
    debugMode: false,
  });
  vi.spyOn(runtimeContext, 'isTrustedFolder').mockReturnValue(true);
  return {
    spec: {
      kind: 'codex',
      command: process.execPath,
      args: ['--input-type=module', '-e', fixture, scenario],
    },
    name: 'codex-fixture',
    promptConfig: { systemPrompt: 'Check the result.' },
    modelConfig: {},
    runConfig: {},
    runtimeContext,
    eventEmitter: new AgentEventEmitter(),
  };
}

async function create(options = params()): Promise<SubagentExecutor> {
  const executor = await codexExternalAgentExecutor.create(options);
  executors.push(executor);
  return executor;
}

function context(): ContextState {
  const state = new ContextState();
  state.set('task_prompt', 'Inspect this repository.');
  return state;
}

describe('Codex subagent executor', () => {
  it.each([
    ['default', 'read-only'],
    ['plan', 'read-only'],
    ['auto-edit', 'workspace-write'],
    ['yolo', 'danger-full-access'],
  ])(
    'maps %s without inheriting a host model or persisting a thread',
    async (approvalMode, sandbox) => {
      vi.stubEnv('CODEX_THREAD_ID', 'parent-thread');
      const options = { ...params(), approvalMode };
      const finish = vi.fn();
      options.eventEmitter!.on(AgentEventType.FINISH, finish);
      const executor = await create(options);
      await executor.execute(context());
      expect(executor.getTerminateMode()).toBe(AgentTerminateMode.GOAL);
      const result = JSON.parse(executor.getFinalText());
      expect(result.thread).toEqual({
        cwd: process.cwd(),
        ephemeral: true,
        approvalPolicy: 'never',
        sandbox,
      });
      expect(result.task).toMatchObject({
        threadId: 'thread',
        input: [
          {
            type: 'text',
            text: expect.stringContaining('Inspect this repository.'),
          },
        ],
      });
      expect(result.task.input[0].text).toContain('Check the result.');
      expect(result.env).toBeNull();
      expect(() => process.kill(result.pid, 0)).toThrow();
      expect(finish).toHaveBeenCalledWith(
        expect.objectContaining({ terminateReason: AgentTerminateMode.GOAL }),
      );
    },
  );

  it.each(['unphased', 'approval'])(
    'accepts %s completion with a final answer',
    async (scenario) => {
      const executor = await create(params(scenario));
      await executor.execute(context());
      expect(executor.getTerminateMode()).toBe(AgentTerminateMode.GOAL);
      expect(JSON.parse(executor.getFinalText()).task.threadId).toBe('thread');
    },
  );

  it.each([
    ['file-approval', { decision: 'decline' }],
    ['permissions', { permissions: {}, scope: 'turn' }],
    ['question', { answers: {} }],
    ['elicitation', { action: 'decline', content: null, _meta: null }],
  ])('denies %s without human interaction', async (scenario, expected) => {
    const executor = await create(params(scenario));
    await executor.execute(context());
    expect(JSON.parse(executor.getFinalText()).interaction).toEqual(expected);
  });

  it('waits for a TERM-resistant descendant before publishing completion', async () => {
    const executor = await create(params('tree'));
    await executor.execute(context());
    const result = JSON.parse(executor.getFinalText());
    expect(typeof result.descendant).toBe('number');
    expect(() => process.kill(result.pid, 0)).toThrow();
    expect(() => process.kill(result.descendant, 0)).toThrow();
  }, 15_000);

  it.each([
    ['missing-answer', /without a final answer/],
    ['failed', /status failed/],
    ['wrong-turn', /another turn/],
    ['bad-json', /JSON/],
    ['durable', /ephemeral/],
    ['close', /closed before completion/],
    ['unknown-request', /unsupported interaction/],
  ])('fails %s instead of publishing success', async (scenario, error) => {
    const executor = await create(params(scenario));
    await expect(executor.execute(context())).rejects.toThrow(error);
    expect(executor.getTerminateMode()).toBe(AgentTerminateMode.ERROR);
    expect(executor.getFinalText()).toMatch(error);
  });

  it('reports a missing executable', async () => {
    const options = params();
    options.spec.command = '/nonexistent/qwen-codex-fixture';
    const executor = await create(options);
    await expect(executor.execute(context())).rejects.toThrow(/Install Codex/);
  });

  it('does not spawn after cancellation or disposal', async () => {
    const options = params();
    options.spec.command = '/nonexistent/qwen-codex-fixture';
    const executor = await create(options);
    await executor.execute(context(), AbortSignal.abort());
    expect(executor.getTerminateMode()).toBe(AgentTerminateMode.CANCELLED);
    const disposed = await create(options);
    await disposed.dispose?.();
    await disposed.execute(context());
    expect(disposed.getTerminateMode()).toBe(AgentTerminateMode.CANCELLED);
  });

  it('cancels an active initialization and awaits cleanup', async () => {
    const executor = await create(params('init-hang'));
    const abort = new AbortController();
    const execution = executor.execute(context(), abort.signal);
    setTimeout(() => abort.abort(), 200);
    await execution;
    expect(executor.getTerminateMode()).toBe(AgentTerminateMode.CANCELLED);
  });

  it('bounds execution time', async () => {
    const options = params('hold');
    options.runConfig = { max_time_minutes: 0.005 };
    const executor = await create(options);
    await executor.execute(context());
    expect(executor.getTerminateMode()).toBe(AgentTerminateMode.TIMEOUT);
    expect(executor.getFinalText()).toContain('exceeded its time limit');
  });

  it.each(['slow-hold', 'slow-error'])(
    'preserves the original outcome during %s cleanup',
    async (scenario) => {
      const directory = await mkdtemp(join(tmpdir(), 'codex-cleanup-'));
      const ready = join(directory, 'ready');
      const options = params(scenario);
      options.spec.args!.push(ready);
      options.runConfig = { max_time_minutes: 0.02 };
      const executor = await create(options);
      const abort = new AbortController();
      const execution = executor.execute(context(), abort.signal);
      const settled = execution.then(
        () => undefined,
        (error: unknown) => error,
      );
      try {
        await vi.waitFor(() => {
          expect(existsSync(ready)).toBe(true);
          if (scenario === 'slow-error')
            expect(readFileSync(ready, 'utf8')).toBe('cleaning');
        });
        abort.abort();
        const error = await settled;
        if (scenario === 'slow-hold') {
          expect(error).toBeUndefined();
          expect(executor.getTerminateMode()).toBe(
            AgentTerminateMode.CANCELLED,
          );
        } else {
          expect(error).toBeInstanceOf(Error);
          expect(executor.getTerminateMode()).toBe(AgentTerminateMode.ERROR);
          expect(executor.getFinalText()).toMatch(/JSON/);
        }
        expect(executor.getFinalText()).not.toContain('time limit');
      } finally {
        await executor.dispose?.();
        await rm(directory, { recursive: true, force: true });
      }
    },
    15_000,
  );

  it('bounds initialization even without a configured task limit', async () => {
    const executor = await create(params('init-hang'));
    await expect(executor.execute(context())).rejects.toThrow(
      /initialization timed out/,
    );
  }, 15_000);

  it('rejects continuation and history import', async () => {
    const executor = await create();
    await executor.execute(context());
    await expect(executor.execute(context())).rejects.toThrow(/one-shot/);
    await expect(executor.executeExternalInputs(['continue'])).rejects.toThrow(
      /one-shot/,
    );
    expect(() => executor.setExternalMessageProvider(() => [])).toThrow(
      /one-shot/,
    );
    const imported = await create();
    const state = context();
    state.set('initial_messages_override', []);
    await expect(imported.execute(state)).rejects.toThrow(
      /conversation history/,
    );
  });

  it('rejects unsupported approval modes and untrusted workspaces before spawning', async () => {
    await expect(create({ ...params(), approvalMode: 'auto' })).rejects.toThrow(
      /approval mode/,
    );
    const options = params();
    vi.mocked(options.runtimeContext.isTrustedFolder).mockReturnValue(false);
    await expect(create(options)).rejects.toThrow(/trusted workspace/);
  });
});
