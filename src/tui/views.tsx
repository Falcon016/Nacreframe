import { Box, Text, useAnimation, useWindowSize } from 'ink';
import type { ApprovalMode } from '../config/schema.js';
import type { TodoItem } from '../tools/types.js';
import { NAME, VERSION } from '../version.js';
import { agentColor, useTheme } from './context.js';
import { diffColor, Markdown } from './markdown.js';
import type { Item, LiveAgent, UiSnapshot } from './store.js';
import { Mascot } from './mascot.js';
import { GLYPH, MODE_STYLE } from './theme.js';

export function useSpinner(active: boolean): string {
  const { frame } = useAnimation({ interval: 110, isActive: active });
  return GLYPH.spinner[frame % GLYPH.spinner.length]!;
}

const fmtTokens = (n: number) =>
  n >= 1_000_000
    ? `${(n / 1e6).toFixed(1)}M`
    : n >= 1000
      ? `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k`
      : String(n);
const elapsed = (ms: number) =>
  ms < 60_000
    ? `${Math.floor(ms / 1000)}s`
    : `${Math.floor(ms / 60_000)}m ${Math.floor((ms % 60_000) / 1000)}s`;

export interface BannerInfo {
  model: string;
  cwd: string;
  mode: ApprovalMode;
  sandbox: string;
  warnings: string[];
}

/** Key hints: the key in a brighter tone, what it does in a quieter one, groups set apart by space. */
export function Keys({ items }: { items: [key: string, what: string][] }) {
  const t = useTheme();
  return (
    <Text>
      {items.map(([k, w], i) => (
        <Text key={k}>
          {i ? '   ' : ''}
          <Text color={t.dim}>{k}</Text>
          <Text color={t.faint}> {w}</Text>
        </Text>
      ))}
    </Text>
  );
}

/**
 * The welcome panel printed at launch: a framed space with the wordmark set into its top edge, the mascot,
 * where you are, and the handful of keys worth knowing. It fills the top of the terminal instead of leaving
 * it bare, then scrolls away with the conversation.
 */
export function Banner({ info }: { info: BannerInfo }) {
  const t = useTheme();
  const { columns } = useWindowSize();
  const home = process.env.HOME ?? process.env.USERPROFILE ?? '';
  const cwd = home && info.cwd.startsWith(home) ? '~' + info.cwd.slice(home.length) : info.cwd;
  // As wide as the input box below it, so the two frames line up.
  const width = Math.max(40, columns);
  const showMascot = t.name !== 'mono' && width >= 72;
  const title = ` ${NAME.toLowerCase()} `;
  const version = ` v${VERSION} `;
  // ╭─[●] nacreframe ─────────────── v0.1.0 ─╮
  const rule = '─'.repeat(Math.max(1, width - 2 - 3 - title.length - version.length - 2));
  const tips: [string, string][] = [
    ['/model', 'pick or switch the model'],
    ['/swarm duo', 'start a planner and a builder'],
    ['/resume', 'pick up an earlier session'],
    ['shift+tab', 'change how much it may do on its own'],
    ['/help', 'everything else'],
  ];
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text>
        <Text color={t.frame}>╭─</Text>
        <Text color={t.accent} bold>
          {GLYPH.mark[0]}
        </Text>
        <Text color={t.text}>{GLYPH.mark[1]}</Text>
        <Text color={t.accent} bold>
          {GLYPH.mark[2]}
        </Text>
        <Text bold>{title}</Text>
        <Text color={t.frame}>{rule}</Text>
        <Text color={t.faint}>{version}</Text>
        <Text color={t.frame}>─╮</Text>
      </Text>
      <Box
        width={width}
        borderStyle="round"
        borderTop={false}
        borderColor={t.frame}
        paddingX={3}
        paddingY={1}
        columnGap={5}
      >
        {showMascot ? (
          <Box flexDirection="column" flexShrink={0}>
            <Mascot />
          </Box>
        ) : null}
        <Box flexDirection="column" flexGrow={1} flexShrink={1}>
          <Text wrap="truncate-end">
            <Text bold color={t.text}>
              {info.model}
            </Text>
            <Text color={t.faint}> in </Text>
            <Text color={t.dim}>{cwd}</Text>
          </Text>
          <Text>
            <Text color={t[MODE_STYLE[info.mode].color]}>{info.mode}</Text>
            <Text color={t.faint}> mode, </Text>
            <Text color={t.dim}>{info.sandbox}</Text>
          </Text>
          <Box flexDirection="column" marginTop={1}>
            {tips.map(([k, what]) => (
              <Text key={k} wrap="truncate-end">
                <Text color={t.lavender}>{k.padEnd(12)}</Text>
                <Text color={t.faint}>{what}</Text>
              </Text>
            ))}
          </Box>
        </Box>
      </Box>
      {info.warnings.map((w, i) => (
        <Box key={i} paddingLeft={1}>
          <Box width={2} flexShrink={0}>
            <Text color={t.gold}>!</Text>
          </Box>
          <Box flexShrink={1}>
            <Text color={t.gold}>{w}</Text>
          </Box>
        </Box>
      ))}
    </Box>
  );
}

const MAX_THOUGHT_LINES = 40;

const fmtSeconds = (ms: number) => (ms >= 1000 ? `${Math.round(ms / 1000)}s` : '<1s');

/**
 * An agent's reasoning. Hidden (the default) it is one quiet line, so you know it happened and how long it
 * took. Shown (/thinking or ctrl+t) it is set off by a rule in the agent's colour, in a quieter italic than
 * the answer, so it reads as working notes rather than as the reply.
 */
export function ThinkingView({
  agent,
  text,
  ms,
  shown,
}: {
  agent: string;
  text: string;
  ms: number;
  shown: boolean;
}) {
  const t = useTheme();
  const c = agent === 'main' ? t.lavender : agentColor(t, agent);
  const header = (
    <Text>
      <Text color={c}>{GLYPH.think}</Text>
      <Text color={t.faint}>
        {' '}
        {agent === 'main' ? '' : `${agent} `}thought{ms ? ` for ${fmtSeconds(ms)}` : ''}
      </Text>
    </Text>
  );
  if (!shown) return <Box paddingLeft={1}>{header}</Box>;
  const lines = text.split('\n');
  const extra = lines.length - MAX_THOUGHT_LINES;
  return (
    <Box marginTop={1} paddingLeft={1} flexDirection="column">
      {header}
      <Box
        marginLeft={1}
        paddingLeft={1}
        borderStyle="single"
        borderTop={false}
        borderRight={false}
        borderBottom={false}
        borderColor={c}
        flexDirection="column"
      >
        <Text color={t.dim} italic wrap="wrap">
          {lines.slice(0, MAX_THOUGHT_LINES).join('\n')}
        </Text>
        {extra > 0 ? <Text color={t.faint}>… {extra} more lines (/export saves all of it)</Text> : null}
      </Box>
    </Box>
  );
}

export function ItemView({
  item,
  banner,
  showThinking = false,
}: {
  item: Item;
  banner: BannerInfo;
  showThinking?: boolean;
}) {
  const t = useTheme();
  switch (item.kind) {
    case 'banner':
      return <Banner info={banner} />;
    case 'thinking':
      return <ThinkingView agent={item.agent} text={item.text} ms={item.ms} shown={showThinking} />;
    case 'user':
      return (
        <Box marginTop={1} paddingLeft={1}>
          <Text color={t.accent}>{GLYPH.user} </Text>
          <Text bold>{item.text}</Text>
        </Box>
      );
    case 'assistant': {
      const c = item.agent === 'main' ? t.text : agentColor(t, item.agent);
      return (
        <Box marginTop={1} paddingLeft={1} flexDirection="column">
          {item.agent !== 'main' ? (
            <Text bold color={c}>
              {GLYPH.pearl} {item.agent}
            </Text>
          ) : null}
          <Box>
            <Box marginRight={1}>
              <Text color={item.agent === 'main' ? t.accent : c}>
                {item.agent === 'main' ? GLYPH.tool : ' '}
              </Text>
            </Box>
            <Box flexDirection="column" flexGrow={1}>
              <Markdown text={item.text} />
            </Box>
          </Box>
        </Box>
      );
    }
    case 'tool': {
      const color = item.status === 'ok' ? t.teal : item.status === 'denied' ? t.gold : t.red;
      const detail = item.detail ? item.detail.split('\n') : [];
      return (
        <Box flexDirection="column" paddingLeft={1}>
          <Text>
            <Text color={color}>{GLYPH.tool} </Text>
            {item.agent !== 'main' ? <Text color={agentColor(t, item.agent)}>{item.agent} </Text> : null}
            <Text bold>{item.name}</Text>
            <Text color={t.dim}> {item.description === item.name ? '' : item.description}</Text>
          </Text>
          <Text color={item.status === 'ok' ? t.dim : color}>
            {' '}
            {GLYPH.result} {item.summary}
          </Text>
          {detail.slice(0, 14).map((l, i) => (
            <Text key={i} color={item.name === 'bash' ? t.dim : diffColor(l, t)} wrap="truncate-end">
              {' '}
              {l || ' '}
            </Text>
          ))}
          {detail.length > 14 ? <Text color={t.faint}> … +{detail.length - 14} more lines</Text> : null}
        </Box>
      );
    }
    case 'notice': {
      const color = { info: t.dim, warn: t.gold, error: t.red, success: t.green }[item.level];
      const glyph = { info: '·', warn: '!', error: GLYPH.fail, success: GLYPH.ok }[item.level];
      return (
        <Box paddingLeft={1}>
          <Box width={2} flexShrink={0}>
            <Text color={color}>{glyph}</Text>
          </Box>
          <Box flexShrink={1}>
            <Text color={color}>{item.text}</Text>
          </Box>
        </Box>
      );
    }
    case 'channel': {
      const from = agentColor(t, item.from);
      return (
        <Box paddingLeft={1} marginTop={item.from === 'you' ? 1 : 0}>
          <Text>
            <Text bold color={from}>
              {item.from}
            </Text>
            {item.to ? (
              <Text color={t.faint}>
                {' '}
                → <Text color={agentColor(t, item.to)}>{item.to}</Text>
              </Text>
            ) : null}
            <Text color={t.faint}> </Text>
            {/* An automatic report repeats what the agent just wrote above; just show where it went. */}
            {item.auto ? (
              <Text color={t.faint}>report delivered</Text>
            ) : (
              <Text color={item.from === 'system' ? t.faint : t.text}>{item.text}</Text>
            )}
          </Text>
        </Box>
      );
    }
  }
}

/**
 * The last `n` lines of `text` once word-wrapped to `width`, for reasoning that streams in. Reasoning often
 * runs for paragraphs without a line break; cutting such a line to fit made it slide sideways like a ticker
 * instead of flowing. Wrapping it first lets new words land at the end of the last line, as in an editor.
 * Only the tail is wrapped, so the cost stays flat however long the reasoning gets.
 */
export function wrapTail(text: string, width: number, n: number): string[] {
  const w = Math.max(12, width);
  const cut = text.length > w * n * 3;
  const src = (cut ? text.slice(-w * n * 3) : text).replace(/\n{3,}/g, '\n\n');
  const out: string[] = [];
  src.split('\n').forEach((para, pi) => {
    if (!para.trim()) {
      if (out.length && out.at(-1) !== '') out.push('');
      return;
    }
    let line = pi === 0 && cut ? '…' : '';
    for (const word of para.trim().split(/\s+/)) {
      for (let rest = word; rest;) {
        const room = w - (line ? line.length + 1 : 0);
        if (rest.length <= room) {
          line = line ? `${line} ${rest}` : rest;
          rest = '';
        } else if (line) {
          out.push(line);
          line = '';
        } else {
          out.push(rest.slice(0, w)); // a single word wider than the column
          rest = rest.slice(w);
        }
      }
    }
    if (line) out.push(line);
  });
  while (out.at(-1) === '') out.pop();
  return out.slice(-n);
}

function tail(text: string, n: number): string[] {
  const lines = text.split('\n');
  return lines.slice(-n);
}

export function TodoPanel({ todos }: { todos: TodoItem[] }) {
  const t = useTheme();
  if (!todos.length || todos.every((x) => x.status === 'completed')) return null;
  return (
    <Box flexDirection="column" paddingLeft={1} marginTop={1}>
      {todos.map((x, i) => (
        <Text
          key={i}
          color={x.status === 'completed' ? t.faint : x.status === 'in_progress' ? t.accent : t.dim}
          {...(x.status === 'completed' ? { strikethrough: true } : {})}
        >
          {x.status === 'completed' ? '☑' : x.status === 'in_progress' ? '◐' : '☐'} {x.content}
        </Text>
      ))}
    </Box>
  );
}

function AgentChip({ a, spin }: { a: LiveAgent; spin: string }) {
  const t = useTheme();
  const c = agentColor(t, a.name, a.color);
  return (
    <Text>
      <Text color={c}>
        {a.running ? spin : '○'} {a.name}
      </Text>
      {a.running && a.thought && !a.text ? (
        <Text color={t.faint}> {GLYPH.think} thinking</Text>
      ) : a.running && a.lastTool ? (
        <Text color={t.faint}> {a.lastTool.slice(0, 28)}</Text>
      ) : null}
    </Text>
  );
}

/** Split view: one pane per agent, live. */
export function SwarmPanes({
  agents,
  spin,
  showThinking,
}: {
  agents: LiveAgent[];
  spin: string;
  showThinking: boolean;
}) {
  const t = useTheme();
  const { columns, rows } = useWindowSize();
  // The live area is redrawn in place, which only works while it fits on screen: anything taller scrolls
  // out of reach and every redraw leaves a copy behind. So panes sit side by side, at most a quarter of
  // the window tall, and give way to the one-line roster when there is no room for them.
  const height = Math.max(5, Math.min(9, Math.floor(rows / 4)));
  // Text width inside one pane: its share of the row, less border and padding.
  const paneWidth = Math.floor((columns - 2) / Math.max(1, agents.length)) - 4;
  if (columns < 90 || rows < 24) {
    return (
      <Box paddingLeft={1} marginTop={1} gap={2} flexWrap="wrap">
        {agents.map((a) => (
          <AgentChip key={a.name} a={a} spin={spin} />
        ))}
      </Box>
    );
  }
  return (
    <Box flexDirection="row" paddingX={1} marginTop={1}>
      {agents.map((a) => {
        const c = agentColor(t, a.name, a.color);
        const room = Math.max(1, height - 4);
        const body = a.text ? tail(a.text, room) : [];
        // While an agent reasons, its pane shows the latest of it (or just that it is thinking).
        const thinking = a.running && !a.text && !!a.thought;
        return (
          <Box
            key={a.name}
            flexDirection="column"
            flexGrow={1}
            flexBasis={0}
            borderStyle="round"
            borderColor={a.running ? c : t.faint}
            paddingX={1}
            height={height}
            overflow="hidden"
          >
            <Text bold color={c} wrap="truncate-end">
              {a.running ? spin : '○'} {a.name}
            </Text>
            <Text color={t.faint} wrap="truncate-end">
              {a.role ?? ''}
            </Text>
            {a.tools.slice(-2).map((x) => (
              <Text key={x.id} color={t.dim} wrap="truncate-end">
                ▸ {x.description}
              </Text>
            ))}
            {body.map((l, i) => (
              <Text key={i} color={t.text} wrap="truncate-end">
                {l}
              </Text>
            ))}
            {thinking ? (
              <Text color={c} wrap="truncate-end">
                {GLYPH.think} <Text color={t.faint}>thinking</Text>
              </Text>
            ) : null}
            {thinking && showThinking
              ? wrapTail(a.thought, paneWidth, Math.max(1, room - 1)).map((l, i) => (
                  <Text key={`t${i}`} color={t.dim} italic wrap="truncate-end">
                    {l || ' '}
                  </Text>
                ))
              : null}
            {!a.running && !body.length ? <Text color={t.faint}>idle</Text> : null}
          </Box>
        );
      })}
    </Box>
  );
}

export function LiveArea({
  snap,
  todos,
  showPanes,
}: {
  snap: UiSnapshot;
  todos: TodoItem[];
  showPanes: boolean;
}) {
  const t = useTheme();
  const running = snap.live.some((a) => a.running);
  const spin = useSpinner(running);
  const main = snap.live.find((a) => a.name === 'main');
  const started = Math.min(...snap.live.filter((a) => a.running).map((a) => a.startedAt), Date.now());
  const { columns, rows } = useWindowSize();
  // Live reasoning: up to a fifth of the window, so the live area always fits on screen.
  const thoughtLines = Math.max(3, Math.min(8, Math.floor(rows / 5)));

  return (
    <Box flexDirection="column">
      {snap.swarmActive ? (
        showPanes ? (
          <SwarmPanes agents={snap.live} spin={spin} showThinking={snap.showThinking} />
        ) : (
          <Box paddingLeft={1} marginTop={1} gap={2}>
            {snap.live.map((a) => (
              <AgentChip key={a.name} a={a} spin={spin} />
            ))}
          </Box>
        )
      ) : null}

      {!snap.swarmActive && main?.running && main.thought && !main.text && snap.showThinking ? (
        <Box marginTop={1} paddingLeft={1} flexDirection="column">
          <Text color={t.lavender}>
            {GLYPH.think} <Text color={t.faint}>thinking</Text>
          </Text>
          <Box
            marginLeft={1}
            paddingLeft={1}
            borderStyle="single"
            borderTop={false}
            borderRight={false}
            borderBottom={false}
            borderColor={t.lavender}
            flexDirection="column"
          >
            {wrapTail(main.thought, columns - 6, thoughtLines).map((l, i) => (
              <Text key={i} color={t.dim} italic wrap="truncate-end">
                {l || ' '}
              </Text>
            ))}
          </Box>
        </Box>
      ) : null}

      {!snap.swarmActive && main?.text ? (
        <Box marginTop={1} paddingLeft={1}>
          <Box marginRight={1}>
            <Text color={t.accent}>{GLYPH.tool}</Text>
          </Box>
          <Box flexDirection="column" flexGrow={1}>
            <Markdown text={main.text} />
          </Box>
        </Box>
      ) : null}

      {!snap.swarmActive
        ? main?.tools.map((x) => (
            <Box key={x.id} flexDirection="column" paddingLeft={1}>
              <Text>
                <Text color={t.accent}>{spin} </Text>
                <Text bold>{x.name}</Text>
                <Text color={t.dim}> {x.description === x.name ? '' : x.description}</Text>
              </Text>
              {x.output
                ? tail(x.output.trimEnd(), 3).map((l, i) => (
                    <Text key={i} color={t.faint} wrap="truncate-end">
                      {' '}
                      {l}
                    </Text>
                  ))
                : null}
            </Box>
          ))
        : null}

      <TodoPanel todos={todos} />

      {snap.browser.open ? (
        <Box paddingLeft={1} marginTop={1}>
          <Text color={snap.browser.holder === 'user' ? t.gold : t.blue}>
            ◉ browser{snap.browser.holder === 'user' ? ' (you have control)' : ''}
          </Text>
          <Text color={t.faint}>
            {' '}
            {snap.browser.url ? snap.browser.url.slice(0, 60) : ''}
            {snap.browser.lastAction ? ` · ${snap.browser.lastAction}` : ''}
          </Text>
        </Box>
      ) : null}

      {snap.compacting ? (
        <Box paddingLeft={1} marginTop={1}>
          <Text color={t.gold}>
            Compacting context ({snap.compacting.pct}%): chat paused, your input is queued
          </Text>
        </Box>
      ) : null}

      {running ? (
        <Box paddingLeft={1} marginTop={1}>
          <Text color={t.accent}>{spin} </Text>
          <Text color={t.dim}>{snap.status ?? (main?.thinking ? 'Thinking' : 'Working')}… </Text>
          <Text color={t.faint}>
            {elapsed(Date.now() - started)}
            {'   '}
          </Text>
          <Keys items={[['esc', 'interrupt']]} />
        </Box>
      ) : null}
    </Box>
  );
}

/**
 * How many messages the swarm's agents have sent each other since you last spoke, against the limit. It turns
 * amber near the limit and red when the team is paused waiting for you.
 */
function BudgetCounter({ used, limit }: { used: number; limit: number }) {
  const t = useTheme();
  const color = !limit ? t.dim : used >= limit ? t.red : used >= limit * 0.8 ? t.gold : t.dim;
  return (
    <Text>
      messages{' '}
      <Text color={color}>
        {used}/{limit || '∞'}
      </Text>
      {'   '}
    </Text>
  );
}

export function Footer({
  mode,
  sandbox,
  snap,
  contextWindow,
  swarmCount,
  queued,
}: {
  mode: ApprovalMode;
  sandbox: string;
  snap: UiSnapshot;
  contextWindow: number;
  swarmCount: number;
  queued: number;
}) {
  const t = useTheme();
  const m = MODE_STYLE[mode];
  const pct = Math.min(99, Math.round((snap.contextTokens / contextWindow) * 100));
  return (
    <Box justifyContent="space-between" paddingX={2}>
      <Text>
        <Text color={t[m.color]} bold>
          ⏵⏵ {m.label}
        </Text>
        <Text color={t.faint}> shift+tab</Text>
        <Text color={t.dim}>
          {'   '}sandbox {sandbox.split(':')[0]}
        </Text>
        {swarmCount ? (
          <Text color={t.rose}>
            {'   '}swarm ×{swarmCount}
          </Text>
        ) : null}
        {snap.browser.open ? <Text color={t.blue}>{'   '}browser</Text> : null}
        {queued ? (
          <Text color={t.gold}>
            {'   '}
            {queued} queued
          </Text>
        ) : null}
        {snap.showThinking ? (
          <Text color={t.lavender}>
            {'   '}
            {GLYPH.think} thinking shown
          </Text>
        ) : null}
      </Text>
      <Text color={t.faint}>
        {snap.swarmBudget ? (
          <BudgetCounter used={snap.swarmBudget.used} limit={snap.swarmBudget.limit} />
        ) : null}
        context <Text color={pct > 80 ? t.red : pct > 60 ? t.gold : t.dim}>{pct}%</Text>
        {'   '}↑{fmtTokens(snap.tokens.input)} ↓{fmtTokens(snap.tokens.output)}
      </Text>
    </Box>
  );
}
