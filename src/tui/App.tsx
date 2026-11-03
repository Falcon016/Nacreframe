import { Box, Static, useApp, useStdout } from 'ink';
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { ApprovalRequest, ApprovalResponse } from '../agent/agent.js';
import type { ApprovalMode } from '../config/schema.js';
import type { Runtime } from '../runtime.js';
import type { Question, TodoItem } from '../tools/types.js';
import { BUILTINS, type CmdCtx, type Overlay } from './commands.js';
import { ThemeContext } from './context.js';
import { ApprovalDialog, QuestionDialog, SelectList } from './dialogs.js';
import { Input } from './Input.js';
import type { UiStore } from './store.js';
import type { Theme } from './theme.js';
import { Footer, ItemView, LiveArea, type BannerInfo } from './views.js';

const MODE_ORDER: ApprovalMode[] = ['ask', 'edits', 'auto', 'plan'];

interface Props {
  runtime: Runtime;
  store: UiStore;
  theme: Theme;
  initialPrompt?: string;
}

export function App({ runtime, store, theme, initialPrompt }: Props) {
  const { exit } = useApp();
  const snap = useSyncExternalStore(store.subscribe, store.getSnapshot);

  const [mode, setMode] = useState<ApprovalMode>(runtime.policy.mode);
  const [sandbox, setSandbox] = useState(runtime.sandbox.describe());
  const [todos, setTodos] = useState<TodoItem[]>(runtime.todos);
  const [approval, setApproval] = useState<{
    req: ApprovalRequest;
    resolve(r: ApprovalResponse): void;
  } | null>(null);
  const [question, setQuestion] = useState<{ agent: string; q: Question; resolve(a: string): void } | null>(
    null,
  );
  const [overlay, setOverlay] = useState<Overlay | null>(null);
  const [showPanes, setShowPanes] = useState(true);
  const [history, setHistory] = useState<string[]>([]);
  const [, force] = useState(0);
  const exitArmed = useRef(0);
  const stdout = useStdout().stdout as NodeJS.WriteStream;
  // Bumped after a resize to print the whole transcript again (see below).
  const [staticKey, setStaticKey] = useState(0);

  // Print the whole transcript again from a clean screen (after a resize, or when reasoning is shown or hidden).
  const reprint = useCallback(() => {
    if (stdout?.isTTY) stdout.write('\x1b[2J\x1b[3J\x1b[H');
    setStaticKey((k) => k + 1);
  }, [stdout]);

  const toggleThinking = useCallback(
    (on?: boolean) => {
      const next = on ?? !store.getSnapshot().showThinking;
      store.setShowThinking(next);
      reprint(); // transcript lines are printed once; redraw them in the new form
      store.notice(next ? 'Showing thinking. ctrl+t hides it.' : 'Thinking hidden. ctrl+t shows it.');
    },
    [store, reprint],
  );

  // Terminals reflow their contents when the window changes size (windowed to fullscreen, a split pane
  // dragged), so what Ink believes is on screen no longer matches what is there. Redrawing in place then
  // leaves stale copies of the live area behind. Once the resizing settles, start from a clean screen and
  // print everything again at the new width.
  useEffect(() => {
    if (!stdout?.isTTY) return;
    let size = `${stdout.columns}x${stdout.rows}`;
    let timer: NodeJS.Timeout | undefined;
    const onResize = () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        const now = `${stdout.columns}x${stdout.rows}`;
        if (now === size) return;
        size = now;
        reprint();
      }, 150);
    };
    stdout.on('resize', onResize);
    return () => {
      clearTimeout(timer);
      stdout.off('resize', onResize);
    };
  }, [stdout, reprint]);

  const banner = useMemo<BannerInfo>(
    () => ({
      model: runtime.modelSpec ?? 'no model selected — /model',
      cwd: runtime.cwd,
      mode: runtime.policy.mode,
      sandbox: `sandbox ${runtime.sandbox.mode}`,
      warnings: runtime.warnings,
    }),
    [runtime],
  );

  // Runtime → UI wiring (once).
  useEffect(() => {
    runtime.events.on('mode', setMode);
    runtime.events.on('sandbox', setSandbox);
    runtime.events.on('todos', setTodos);
    runtime.events.on('model', () => force((n) => n + 1));
    runtime.broker.approvalHandler = (req, signal) =>
      new Promise<ApprovalResponse>((resolve) => {
        const done = (r: ApprovalResponse) => {
          setApproval(null);
          resolve(r);
        };
        signal.addEventListener('abort', () => done({ allow: false }), { once: true });
        setApproval({ req, resolve: done });
      });
    runtime.broker.questionHandler = (agent, q) =>
      new Promise<string>((resolve) => {
        setQuestion({
          agent,
          q,
          resolve: (a) => {
            setQuestion(null);
            resolve(a);
          },
        });
      });
    if (runtime.config.showThinking) store.setShowThinking(true);
    store.attachAgent(runtime.agent, 'main');
    if (runtime.browser) store.attachBrowser(runtime.browser.events);
    if (runtime.swarm) store.attachSwarm(runtime.swarm);
    return () => {
      runtime.broker.approvalHandler = undefined;
      runtime.broker.questionHandler = undefined;
      store.dispose();
    };
  }, [runtime, store]);

  const quit = useCallback(() => {
    void runtime.dispose().finally(() => exit());
  }, [runtime, exit]);

  const prompt = useCallback(
    (text: string) => {
      if (runtime.swarm) {
        // The channel feed already shows the user's message, so there is no separate local echo.
        const m = /^@([a-z][a-z0-9_-]*)\s+([\s\S]*)$/i.exec(text);
        runtime.swarm.say(m ? m[2]! : text, m?.[1]?.toLowerCase());
        return;
      }
      store.user(text);
      if (runtime.agent.isRunning) runtime.agent.steer(text);
      else void runtime.agent.run(text);
    },
    [runtime, store],
  );

  const cmdCtx = useMemo<CmdCtx>(
    () => ({
      runtime,
      store,
      prompt,
      overlay: setOverlay,
      exit: quit,
      togglePanes: () => setShowPanes((s) => !s),
      setThinking: (on?: boolean) => toggleThinking(on),
      ask: (question: string) =>
        new Promise<string | undefined>((resolve) =>
          setQuestion({
            agent: 'main',
            q: { question },
            resolve: (a) => {
              setQuestion(null);
              resolve(a === '(skipped)' || a === '(no answer)' ? undefined : a);
            },
          }),
        ),
      refresh: () => force((n) => n + 1),
    }),
    [runtime, store, prompt, quit, toggleThinking],
  );

  const allCommands = useMemo(
    () => [
      ...BUILTINS.map((c) => ({ name: c.name, description: c.description })),
      ...runtime.commands.map((c) => ({ name: c.name, description: c.description })),
    ],
    [runtime],
  );

  const submit = useCallback(
    (text: string) => {
      setHistory((h) => (h.at(-1) === text ? h : [...h, text]));
      if (text.startsWith('/')) {
        const [name = '', ...rest] = text.slice(1).split(/\s+/);
        const args = rest.join(' ');
        const builtin = BUILTINS.find((c) => c.name === name);
        const custom = runtime.commands.find((c) => c.name === name);
        const run = builtin
          ? builtin.run(args, cmdCtx)
          : custom
            ? custom.run(args, { cwd: runtime.cwd, prompt, notify: (m) => store.notice(m) })
            : undefined;
        if (!builtin && !custom) store.notice(`Unknown command /${name}. Try /help.`, 'warn');
        else
          void Promise.resolve(run).catch((e: Error) =>
            store.notice(`/${name} failed: ${e.message}`, 'error'),
          );
        return;
      }
      prompt(text);
    },
    [runtime, cmdCtx, prompt, store],
  );

  const interrupt = useCallback(
    (kind: 'esc' | 'ctrl-c') => {
      const busy = runtime.agent.isRunning || !!runtime.swarm?.roster().some((t) => t.running);
      if (busy) {
        runtime.agent.abort();
        runtime.swarm?.abortAll();
        exitArmed.current = 0;
        return;
      }
      if (kind === 'ctrl-c') {
        const now = Date.now();
        if (now - exitArmed.current < 2000) return quit();
        exitArmed.current = now;
        store.notice('Press Ctrl+C again to exit.');
      }
    },
    [runtime, store, quit],
  );

  const cycleMode = useCallback(() => {
    const next = MODE_ORDER[(MODE_ORDER.indexOf(runtime.policy.mode) + 1) % MODE_ORDER.length]!;
    runtime.setApprovalMode(next);
  }, [runtime]);

  // One-shot prompt from the command line.
  const started = useRef(false);
  useEffect(() => {
    if (initialPrompt && !started.current) {
      started.current = true;
      prompt(initialPrompt);
    }
  }, [initialPrompt, prompt]);

  // No default model is chosen for you: open the picker on first run.
  const asked = useRef(false);
  useEffect(() => {
    if (!runtime.modelSpec && !asked.current) {
      asked.current = true;
      submit('/model');
    }
  }, [runtime, submit]);

  const items = useMemo(() => [{ id: 0, kind: 'banner' as const }, ...snap.items], [snap.items]);
  const dialogOpen = !!(approval || question || overlay);
  const busy = snap.live.some((a) => a.running);

  return (
    <ThemeContext.Provider value={theme}>
      <Static key={staticKey} items={items}>
        {(item) => <ItemView key={item.id} item={item} banner={banner} showThinking={snap.showThinking} />}
      </Static>
      {/* Panes give way to a one-line roster while a dialog needs the room. */}
      <LiveArea snap={snap} todos={todos} showPanes={showPanes && !dialogOpen} />
      <Box flexDirection="column" marginTop={1}>
        {approval ? (
          <ApprovalDialog req={approval.req} pending={runtime.broker.pending} onResolve={approval.resolve} />
        ) : question ? (
          <QuestionDialog
            agent={question.agent}
            question={question.q.question}
            {...(question.q.options ? { options: question.q.options } : {})}
            onAnswer={question.resolve}
          />
        ) : overlay ? (
          <SelectList
            title={overlay.title}
            items={overlay.items}
            {...(overlay.initial !== undefined ? { initial: overlay.initial } : {})}
            onSelect={(v) => {
              setOverlay(null);
              overlay.onSelect(v as never);
            }}
            onCancel={() => {
              setOverlay(null);
              overlay.onCancel?.();
            }}
          />
        ) : null}
        <Input
          isActive={!dialogOpen}
          busy={busy}
          commands={allCommands}
          history={history}
          onSubmit={submit}
          onCycleMode={cycleMode}
          onToggleThinking={() => toggleThinking()}
          onInterrupt={interrupt}
          placeholder={
            runtime.swarm
              ? `Message the team (lead: ${runtime.swarm.names[0]}), or @name to address one agent`
              : busy
                ? 'Type to steer the agent…'
                : 'Ask anything, or type / for commands'
          }
        />
        <Footer
          mode={mode}
          sandbox={sandbox}
          snap={snap}
          contextWindow={runtime.agent.model.contextWindow}
          swarmCount={runtime.swarm?.names.length ?? 0}
          queued={snap.queued}
        />
      </Box>
    </ThemeContext.Provider>
  );
}
