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

export function ItemView({ item, banner }: { item: Item; banner: BannerInfo }) {
  const t = useTheme();
  switch (item.kind) {
    case 'banner':
      return <Banner info={banner} />;
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
      {a.running && a.lastTool ? <Text color={t.faint}> {a.lastTool.slice(0, 28)}</Text> : null}
    </Text>
  );
}

/** Split view: one pane per agent, live. */
export function SwarmPanes({ agents, spin }: { agents: LiveAgent[]; spin: string }) {
  const t = useTheme();
  const { columns, rows } = useWindowSize();
  // The live area is redrawn in place, which only works while it fits on screen: anything taller scrolls
  // out of reach and every redraw leaves a copy behind. So panes sit side by side, at most a quarter of
  // the window tall, and give way to the one-line roster when there is no room for them.
  const height = Math.max(5, Math.min(9, Math.floor(rows / 4)));
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
        const body = a.text ? tail(a.text, Math.max(1, height - 4)) : [];
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

  return (
    <Box flexDirection="column">
      {snap.swarmActive ? (
        showPanes ? (
          <SwarmPanes agents={snap.live} spin={spin} />
        ) : (
          <Box paddingLeft={1} marginTop={1} gap={2}>
            {snap.live.map((a) => (
              <AgentChip key={a.name} a={a} spin={spin} />
            ))}
          </Box>
        )
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
      </Text>
      <Text color={t.faint}>
        context <Text color={pct > 80 ? t.red : pct > 60 ? t.gold : t.dim}>{pct}%</Text>
        {'   '}↑{fmtTokens(snap.tokens.input)} ↓{fmtTokens(snap.tokens.output)}
      </Text>
    </Box>
  );
}
