/**
 * Root component: owns the panes and the chrome around them.
 *
 * Data flow is a loop, once per pane:
 *   keystrokes -> PaneSet.write -> PTY -> claude
 *   claude -> PTY -> TerminalBuffer (emulator) -> snapshot -> SessionPanel
 *
 * The wrapper sits on both sides of that loop without reading what passes through.
 *
 * Two decisions live here and nowhere else, because both are about *where bytes
 * go* rather than what they mean:
 *
 *   - which surface owns the keyboard — a wrapper screen, or the session grid;
 *   - which pane is focused, when the grid owns it.
 *
 * `useRawInput` stays deliberately ignorant of both. It forwards everything but
 * the leader, and this file decides the destination, so no amount of pane
 * machinery can start intercepting keys the child was supposed to receive.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Box, useApp, useStdout } from 'ink';
import { useRawInput } from './input/useRawInput.js';
import { encodeKeyName } from './input/keymap.js';
import { PaneSet } from './panes/PaneSet.js';
import {
  MIN_PANE_COLS,
  MIN_PANE_ROWS,
  capacityFor,
  computeLayout,
  layoutFits,
  splitRefusal,
} from './panes/layout.js';
import { liveRecordIds, type PaneView } from './panes/types.js';
import { PaneGrid } from './components/PaneGrid.js';
import { StatusBar } from './components/StatusBar.js';
import { ErrorScreen } from './components/ErrorScreen.js';
import { Sidebar, reduceHistory, sidebarWidth } from './components/Sidebar.js';
import { compact, readSessions } from './sessionHistory/store.js';
import type { SessionRecord } from './sessionHistory/types.js';
import {
  SettingsScreen,
  createSettingsState,
  reduceSettings,
  type SettingsState,
} from './components/SettingsScreen.js';
import { ThemeProvider } from './theme/ThemeContext.js';
import { DEFAULT_THEME, resolveTheme } from './theme/themes.js';
import { loadConfig, saveConfig } from './config/store.js';
import { DEFAULT_CONFIG, type Config } from './config/schema.js';
import { debug } from './util/logger.js';
import type { ExitInfo } from './types.js';

/** ~30fps. Fast enough to feel immediate, slow enough to survive a build log. */
const FRAME_INTERVAL_MS = 1000 / 30;

/**
 * Rows the content area never gets: one for the status bar, and one for the
 * newline Ink appends to every frame. Claiming that last row makes the terminal
 * scroll on each repaint and the layout drifts upward.
 *
 * Everything else a pane gives up — borders, the focus gutter, the rules between
 * panes — is the layout module's arithmetic, not this file's.
 */
const RESERVED_ROWS = 2;

const NOTICE_TIMEOUT_MS = 4000;

/** How often sidebar ages are recomputed while the panel is visible. */
const SIDEBAR_TICK_MS = 30_000;

/** Pane the leader plus a digit jumps to. Not rebindable, and checked last. */
const PANE_DIGIT = /^[1-9]$/;

type View = 'session' | 'settings' | 'history';

export interface AppProps {
  binaryPath: string;
  claudeArgs: string[];
  cwd: string;
  initialConfig: Config;
  configPath: string;
  initialProblems: string[];
  configUnknown: Record<string, unknown>;
  /** Recorded alongside each session so old history stays interpretable. */
  appVersion: string;
  /** Called once per pane that exits, not once per process. */
  onSessionExit: (info: ExitInfo) => void;
}

export function App({
  binaryPath,
  claudeArgs,
  cwd,
  initialConfig,
  configPath,
  initialProblems,
  configUnknown,
  appVersion,
  onSessionExit,
}: AppProps): React.ReactElement {
  const { stdout } = useStdout();
  const { exit } = useApp();

  const [cols, setCols] = useState(() => stdout.columns || 80);
  const [rows, setRows] = useState(() => stdout.rows || 24);

  const [config, setConfig] = useState<Config>(initialConfig);
  const [unknown, setUnknown] = useState<Record<string, unknown>>(configUnknown);
  const [problems, setProblems] = useState<string[]>(initialProblems);
  const [view, setView] = useState<View>('session');
  const [settings, setSettings] = useState<SettingsState | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const [paneViews, setPaneViews] = useState<readonly PaneView[]>([]);
  const [focusIndex, setFocusIndex] = useState(0);

  const [sessions, setSessions] = useState<readonly SessionRecord[]>([]);
  const [sidebarOpen, setSidebarOpen] = useState(initialConfig.history.sidebar);
  const [historyIndex, setHistoryIndex] = useState(0);

  // While settings are open the draft drives the chrome, so changes preview live
  // and Esc reverts them along with everything else.
  const active = view === 'settings' && settings ? settings.draft : config;
  const theme = resolveTheme(active.theme) ?? DEFAULT_THEME;
  const framed = active.frame;
  const orientation = active.panes.orientation;

  // The settings screen takes the whole content area, so the sidebar yields to
  // it rather than the two fighting over the same columns. The sidebar is global
  // chrome: it is subtracted once, before the panes divide what is left, because
  // one list of past sessions serves every pane.
  const barWidth = sidebarOpen && view !== 'settings' ? sidebarWidth(cols) : 0;

  const contentRows = Math.max(1, rows - RESERVED_ROWS);
  const gridCols = Math.max(1, cols - barWidth);

  // Clamped rather than left dangling: a pane can close while the index still
  // points past the end, and every read of it would otherwise be undefined.
  const focus = paneViews.length === 0 ? 0 : Math.min(focusIndex, paneViews.length - 1);

  const geometry = useMemo(
    () => ({ cols: gridCols, rows: contentRows, orientation, framed }),
    [gridCols, contentRows, orientation, framed],
  );

  const layout = useMemo(
    () => computeLayout({ ...geometry, count: Math.max(1, paneViews.length) }),
    [geometry, paneViews.length],
  );

  const paneSetRef = useRef<PaneSet | null>(null);

  // Latest values for callbacks that must not re-subscribe when they change.
  const paneViewsRef = useRef(paneViews);
  paneViewsRef.current = paneViews;
  const focusRef = useRef(focus);
  focusRef.current = focus;
  const geometryRef = useRef(geometry);
  geometryRef.current = geometry;
  const onSessionExitRef = useRef(onSessionExit);
  onSessionExitRef.current = onSessionExit;
  const viewRef = useRef(view);
  viewRef.current = view;
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  const configRef = useRef(config);
  configRef.current = config;
  const unknownRef = useRef(unknown);
  unknownRef.current = unknown;
  const sessionsRef = useRef(sessions);
  sessionsRef.current = sessions;
  const historyIndexRef = useRef(historyIndex);
  historyIndexRef.current = historyIndex;
  const sidebarOpenRef = useRef(sidebarOpen);
  sidebarOpenRef.current = sidebarOpen;
  // Full terminal width, unlike geometry.cols, which is the grid's share and has
  // already had the sidebar subtracted from it.
  const colsRef = useRef(cols);
  colsRef.current = cols;

  /**
   * Whether sessions are recorded is fixed when the app starts, so the mount
   * effect reads this through a ref instead of taking a dependency on config —
   * see the comment on that effect. Toggling recording in settings therefore
   * applies from the next launch, which is also the honest behaviour: a session
   * already in the log cannot be un-started.
   */
  const recordingRef = useRef({
    enabled: initialConfig.history.enabled,
    recordArgs: initialConfig.history.recordArgs,
    limit: initialConfig.history.limit,
    startCount: initialConfig.panes.startCount,
  });

  /** Armed by the first quit press while several sessions are alive. */
  const quitArmedRef = useRef(false);

  const refreshSessions = useCallback(() => {
    if (!recordingRef.current.enabled) return;
    setSessions(readSessions(configRef.current.history.limit));
  }, []);

  /**
   * A pane's child finished.
   *
   * The pane itself stays on screen as a placeholder — closing it here would
   * reflow every surviving pane at whatever moment a background task happened to
   * end. The app only quits once nothing is running, which keeps the single-pane
   * case behaving exactly as it always has.
   */
  const handlePaneExit = useCallback(
    (_id: string, info: ExitInfo) => {
      onSessionExitRef.current(info);
      refreshSessions();
      if ((paneSetRef.current?.runningCount ?? 0) === 0) {
        debug('app:last-pane-exited', { exitCode: info.exitCode });
        exit();
      }
    },
    [exit, refreshSessions],
  );
  const handlePaneExitRef = useRef(handlePaneExit);
  handlePaneExitRef.current = handlePaneExit;

  // Start the panes exactly once. Neither resizing nor changing settings may
  // appear in these dependencies: re-running this would kill the user's sessions
  // and silently start new ones.
  useEffect(() => {
    const recording = recordingRef.current;
    const start = geometryRef.current;
    debug('effect:mount', { cols: start.cols, rows: start.rows });

    const set = new PaneSet({
      binaryPath,
      args: claudeArgs,
      cwd,
      appVersion,
      recording: { enabled: recording.enabled, recordArgs: recording.recordArgs },
      frameIntervalMs: FRAME_INTERVAL_MS,
      onViews: setPaneViews,
      onExit: (id, info) => handlePaneExitRef.current(id, info),
    });
    paneSetRef.current = set;

    // Asking for more panes than the terminal can hold is not an error — the
    // window may simply be small right now. Open what fits and say so.
    const capacity = capacityFor(start);
    const count = Math.max(1, Math.min(recording.startCount, capacity));
    const initial = computeLayout({ ...start, count });
    for (let index = 0; index < count; index++) {
      const box = initial.panes[index];
      if (box) set.spawn({ cols: box.cols, rows: box.rows });
    }
    if (count < recording.startCount) {
      setNotice(`Terminal fits ${count} pane${count === 1 ? '' : 's'} right now`);
    }

    if (recording.enabled) {
      compact(recording.limit);
      setSessions(readSessions(recording.limit));
    }

    return () => {
      // Kills every child and closes every open history record. The store
      // ignores an id it has already closed, so racing with the PTY exit events
      // is harmless — whichever arrives first wins.
      set.dispose();
      paneSetRef.current = null;
    };
  }, [appVersion, binaryPath, claudeArgs, cwd]);

  useEffect(() => {
    const handleResize = (): void => {
      setCols(stdout.columns || 80);
      setRows(stdout.rows || 24);
    };
    stdout.on('resize', handleResize);
    return () => {
      stdout.off('resize', handleResize);
    };
  }, [stdout]);

  // Resize every emulator and PTY together, then repaint. This also covers
  // toggling the frame, changing orientation, and opening the sidebar — anything
  // that changes what a child actually has to draw into.
  useEffect(() => {
    debug('resize', { cols: layout.panes[0]?.cols, rows: layout.panes[0]?.rows });
    paneSetRef.current?.applyLayout(layout);
  }, [layout]);

  useEffect(() => {
    if (!notice) return;
    const id = setTimeout(() => {
      setNotice(null);
      quitArmedRef.current = false;
    }, NOTICE_TIMEOUT_MS);
    return () => clearTimeout(id);
  }, [notice]);

  // Ages in the sidebar are coarse — minutes at the finest — so a half-minute
  // tick is enough, and it runs only while the panel is actually on screen.
  // Passing a fresh Date.now() on every render instead would defeat the memo.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (barWidth === 0) return;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), SIDEBAR_TICK_MS);
    return () => clearInterval(id);
  }, [barWidth]);

  const closeSettings = useCallback(() => {
    setView('session');
    setSettings(null);
  }, []);

  const handleData = useCallback(
    (data: string) => {
      if (viewRef.current === 'history') {
        const outcome = reduceHistory(data, historyIndexRef.current, sessionsRef.current.length);
        if (outcome.kind === 'close') {
          // Focus returns to the focused pane, but the panel stays on screen:
          // hiding it here would make Esc do two things at once.
          setView('session');
          return;
        }
        setHistoryIndex(outcome.index);
        return;
      }

      if (viewRef.current === 'settings') {
        const current = settingsRef.current;
        if (!current) return;

        const outcome = reduceSettings(current, data, DEFAULT_CONFIG);
        if (outcome.kind === 'state') {
          setSettings(outcome.state);
          return;
        }
        if (outcome.kind === 'close') {
          closeSettings();
          return;
        }

        const result = saveConfig(outcome.config, unknownRef.current);
        if (!result.ok) {
          // Stay open: the user's edits are still in the draft and would be lost.
          setSettings({ ...current, message: `Save failed: ${result.error ?? 'unknown error'}` });
          return;
        }
        setConfig(outcome.config);
        setProblems([]);
        setNotice('Settings saved');
        closeSettings();
        return;
      }

      const target = paneViewsRef.current[focusRef.current];
      if (!target) return;

      // The whole app is one failed pane: there is nothing to type into, so any
      // key dismisses the error rather than disappearing into a dead PTY.
      if (target.status === 'error' && paneViewsRef.current.length === 1) {
        exit();
        return;
      }

      paneSetRef.current?.write(target.id, data);
    },
    [closeSettings, exit],
  );

  const handleCommand = useCallback(
    (key: string) => {
      const currentConfig = configRef.current;
      const keymap = currentConfig.keymap;
      const set = paneSetRef.current;

      // Any command other than a second quit disarms the confirmation, so it
      // cannot be satisfied by a keypress the user made for another reason.
      const quitArmed = quitArmedRef.current;
      quitArmedRef.current = false;

      if (key === keymap.quit) {
        const running = set?.runningCount ?? 0;
        // One keystroke should not end three live sessions without a word.
        if (running > 1 && !quitArmed) {
          quitArmedRef.current = true;
          setNotice(`Press ${currentConfig.leader} ${key} again to quit ${running} sessions`);
          return;
        }
        set?.dispose();
        exit();
        return;
      }

      if (key === keymap.settings) {
        setSettings(createSettingsState(currentConfig));
        setView('settings');
        return;
      }

      if (key === keymap.reload) {
        const loaded = loadConfig();
        setConfig(loaded.config);
        setUnknown(loaded.unknown);
        setProblems(loaded.problems);
        setNotice(
          loaded.problems.length > 0
            ? `Reloaded — ${loaded.problems.length} problem(s)`
            : 'Config reloaded',
        );
        return;
      }

      if (key === keymap.split) {
        if (!set) return;
        const refusal = splitRefusal(geometryRef.current, set.count);
        if (refusal) {
          setNotice(refusal);
          return;
        }
        // Sized from the layout the split is about to produce, so the child is
        // told the truth on its first byte instead of being resized immediately
        // afterwards and having to redraw.
        const next = computeLayout({ ...geometryRef.current, count: set.count + 1 });
        const box = next.panes[set.count];
        if (!box) return;
        const id = set.spawn({ cols: box.cols, rows: box.rows });
        setFocusIndex(set.indexOf(id));
        refreshSessions();
        return;
      }

      if (key === keymap.closePane) {
        if (!set) return;
        if (set.count <= 1) {
          // Closing the only pane is quitting, and quitting has its own key and
          // its own confirmation. Say so rather than quietly doing it.
          setNotice(`Only one pane — ${currentConfig.leader} ${keymap.quit} quits`);
          return;
        }
        const index = focusRef.current;
        const target = paneViewsRef.current[index];
        if (!target) return;
        set.close(target.id);
        // Focus stays where it was, which is now the pane that moved up into the
        // gap — the same thing a tiling window manager does.
        setFocusIndex(Math.max(0, Math.min(index, set.count - 1)));
        refreshSessions();
        if (set.runningCount === 0) exit();
        return;
      }

      if (key === keymap.focusNext) {
        const total = paneViewsRef.current.length;
        if (total > 1) setFocusIndex((focusRef.current + 1) % total);
        return;
      }

      if (key === keymap.toggleOrientation) {
        if (!set) return;
        const current = geometryRef.current.orientation;
        const next = current === 'columns' ? 'rows' : 'columns';

        // Checked before committing, for the same reason a split is: a terminal
        // that is wide but short holds three columns and no stacked panes at
        // all, and silently squeezing them to seven rows each would be worse
        // than saying no.
        if (!layoutFits(computeLayout({ ...geometryRef.current, orientation: next, count: set.count }))) {
          setNotice(
            next === 'rows'
              ? `Too short to stack ${set.count} panes — each needs ${MIN_PANE_ROWS} rows`
              : `Too narrow for ${set.count} columns — each needs ${MIN_PANE_COLS} columns`,
          );
          return;
        }

        // Applies to this run only. The settings screen is what writes to disk,
        // so a chord cannot quietly change a saved preference — and `reload`
        // putting it back is the honest consequence of that.
        setConfig((config) => ({ ...config, panes: { ...config.panes, orientation: next } }));
        setNotice(next === 'rows' ? 'Split direction: stacked' : 'Split direction: side by side');
        return;
      }

      if (key === keymap.history) {
        if (!recordingRef.current.enabled) {
          setNotice('History recording is off — enable it in settings');
          return;
        }
        if (sidebarOpenRef.current) {
          setSidebarOpen(false);
          setView((current) => (current === 'history' ? 'session' : current));
          return;
        }
        if (sidebarWidth(colsRef.current) === 0) {
          setNotice('Terminal too narrow for the sidebar');
          return;
        }
        refreshSessions();
        setSidebarOpen(true);
        return;
      }

      // Shifted variants of the same keys do the reverse or the more committed
      // thing. They are derived rather than separately configurable so there is
      // one key to learn per idea; when a binding has no distinct uppercase form
      // (a digit, say) the branch is simply unreachable and the base key works.
      if (key !== keymap.focusNext && key === keymap.focusNext.toUpperCase()) {
        const total = paneViewsRef.current.length;
        if (total > 1) setFocusIndex((focusRef.current - 1 + total) % total);
        return;
      }

      if (key !== keymap.history && key === keymap.history.toUpperCase()) {
        if (!recordingRef.current.enabled) {
          setNotice('History recording is off — enable it in settings');
          return;
        }
        if (sidebarWidth(colsRef.current) === 0) {
          setNotice('Terminal too narrow for the sidebar');
          return;
        }
        refreshSessions();
        setHistoryIndex(0);
        setSidebarOpen(true);
        setView('history');
        return;
      }

      // Checked after every configured binding, so a user who binds an action to
      // a digit simply shadows the jump rather than creating an ambiguity that
      // would need its own validation rule.
      if (PANE_DIGIT.test(key)) {
        const index = Number(key) - 1;
        if (index < paneViewsRef.current.length) setFocusIndex(index);
        else setNotice(`No pane ${key}`);
        return;
      }

      // Unknown command: swallowed rather than forwarded, so a mistyped chord
      // never injects a stray character into the user's prompt.
    },
    [exit, refreshSessions],
  );

  const leaderByte = encodeKeyName(config.leader) ?? '\x07';
  useRawInput({ leader: leaderByte, onData: handleData, onCommand: handleCommand });

  const activeIds = useMemo(() => liveRecordIds(paneViews), [paneViews]);

  const focusedView = paneViews[focus] ?? null;
  const focusedBox = layout.panes[focus] ?? layout.panes[0];

  // A lone pane that never started is the whole app failing to start, and it
  // deserves the full-screen explanation rather than a footer inside a grid of
  // one. With siblings alive, the failure stays in its own pane.
  if (paneViews.length === 1 && focusedView?.status === 'error' && focusedView.spawnError) {
    return (
      <ThemeProvider theme={theme}>
        <ErrorScreen
          cols={cols}
          title="Could not start claude"
          message={focusedView.spawnError.message}
          detail={focusedView.spawnError.detail}
          hint={`Check that \`${binaryPath}\` runs on its own in this terminal.`}
        />
      </ThemeProvider>
    );
  }

  const dirty = settings ? JSON.stringify(settings.draft) !== JSON.stringify(config) : false;

  return (
    <ThemeProvider theme={theme}>
      <Box flexDirection="column" width={cols} height={rows - 1}>
        {view === 'settings' && settings ? (
          <SettingsScreen
            state={settings}
            cols={cols}
            rows={contentRows}
            configPath={configPath}
            problems={problems}
            dirty={dirty}
          />
        ) : (
          <Box flexDirection="row" width={cols} height={contentRows}>
            {barWidth > 0 ? (
              <Sidebar
                sessions={sessions}
                activeIds={activeIds}
                selectedIndex={historyIndex}
                focused={view === 'history'}
                width={barWidth}
                rows={contentRows}
                now={now}
              />
            ) : null}
            <PaneGrid
              views={paneViews}
              layout={layout}
              focusIndex={focus}
              framed={framed}
              closeHint={`${config.leader} ${config.keymap.closePane}`}
              cols={gridCols}
              rows={contentRows}
            />
          </Box>
        )}
        <StatusBar
          cols={cols}
          cwd={focusedView?.cwd ?? cwd}
          status={focusedView?.status ?? 'starting'}
          leaderLabel={config.leader}
          quitKey={config.keymap.quit}
          settingsKey={config.keymap.settings}
          historyKey={config.keymap.history}
          splitKey={config.keymap.split}
          paneIndex={focus}
          paneCount={paneViews.length}
          startedAt={focusedView?.startedAt ?? null}
          paneCols={focusedBox?.cols ?? gridCols}
          paneRows={focusedBox?.rows ?? contentRows}
          notice={notice}
          problemCount={problems.length}
          inSettings={view === 'settings'}
          inHistory={view === 'history'}
        />
      </Box>
    </ThemeProvider>
  );
}
