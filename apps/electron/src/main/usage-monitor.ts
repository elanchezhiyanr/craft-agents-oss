import { existsSync, watch } from 'fs';
import type { FSWatcher } from 'fs';
import { join } from 'path';
import type { WindowManager } from './window-manager';
import { IPC_CHANNELS, type UsageMonitorSnapshot } from '../shared/types';
import { loadUsageMonitorConfig } from '@craft-agent/shared/config';

type CcusageLoader = {
  getClaudePaths: () => string[];
  loadSessionBlockData: () => Promise<unknown>;
};

let ccusageLoader: CcusageLoader | null = null;

async function getCcusageLoader(): Promise<CcusageLoader> {
  if (!ccusageLoader) {
    ccusageLoader = await import('ccusage/data-loader');
  }
  return ccusageLoader;
}

const WINDOW_MS = 5 * 60 * 60 * 1000;
const POLL_INTERVAL_MS = 30 * 1000;
const DEBOUNCE_MS = 200;

function getClaudeProjectsDirs(baseDirs: string[]): string[] {
  return baseDirs
    .map(base => join(base, 'projects'))
    .filter(dir => existsSync(dir));
}

function parseBlockTimestampMs(value: unknown): number | null {
  if (value instanceof Date) {
    const ms = value.getTime();
    return Number.isNaN(ms) ? null : ms;
  }
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? null : parsed;
  }
  return null;
}

function getBlockTokenTotal(block: any): number {
  if (typeof block?.totalTokens === 'number') return block.totalTokens;
  const tokenCounts = block?.tokenCounts ?? block?.token_counts;
  if (tokenCounts) {
    const input = typeof tokenCounts?.inputTokens === 'number' ? tokenCounts.inputTokens : 0;
    const output = typeof tokenCounts?.outputTokens === 'number' ? tokenCounts.outputTokens : 0;
    const cacheCreate = typeof tokenCounts?.cacheCreationInputTokens === 'number' ? tokenCounts.cacheCreationInputTokens : 0;
    const cacheRead = typeof tokenCounts?.cacheReadInputTokens === 'number' ? tokenCounts.cacheReadInputTokens : 0;
    return input + output + cacheCreate + cacheRead;
  }

  const input = typeof block?.inputTokens === 'number' ? block.inputTokens : 0;
  const output = typeof block?.outputTokens === 'number' ? block.outputTokens : 0;
  const cacheCreate = typeof block?.cacheCreationTokens === 'number' ? block.cacheCreationTokens : 0;
  const cacheRead = typeof block?.cacheReadTokens === 'number' ? block.cacheReadTokens : 0;
  const fallbackTotal = input + output + cacheCreate + cacheRead;
  if (fallbackTotal > 0) return fallbackTotal;

  if (Array.isArray(block?.entries)) {
    let total = 0;
    for (const entry of block.entries) {
      const usage = entry?.usage;
      if (!usage) continue;
      total += (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0) +
        (usage.cacheCreationInputTokens ?? 0) + (usage.cacheReadInputTokens ?? 0);
    }
    return total;
  }

  return 0;
}

function getBlockStartMs(block: any): number | null {
  return (
    parseBlockTimestampMs(block?.blockStart) ??
    parseBlockTimestampMs(block?.startTime) ??
    parseBlockTimestampMs(block?.start_time) ??
    null
  );
}

function getBlockEndMs(block: any): number | null {
  return (
    parseBlockTimestampMs(block?.blockEnd) ??
    parseBlockTimestampMs(block?.endTime) ??
    parseBlockTimestampMs(block?.end_time) ??
    null
  );
}

async function computeUsageSnapshot(): Promise<UsageMonitorSnapshot> {
  const { getClaudePaths, loadSessionBlockData } = await getCcusageLoader();
  const baseDirs = getClaudePaths();
  const projectsDirs = getClaudeProjectsDirs(baseDirs);
  const { plan, limits } = loadUsageMonitorConfig();
  const derivedLimits = {
    pro: limits.pro,
    max5: limits.pro * 5,
    max20: limits.pro * 20,
  };
  const limit = plan === 'max20' ? derivedLimits.max20 : plan === 'max5' ? derivedLimits.max5 : derivedLimits.pro;

  if (baseDirs.every(dir => !existsSync(dir))) {
    return {
      status: 'missing',
      totalTokens: 0,
      windowMs: WINDOW_MS,
      oldestTimestampMs: null,
      resetAtMs: null,
      plan,
      limit,
    };
  }

  if (projectsDirs.length === 0) {
    return {
      status: 'unavailable',
      totalTokens: 0,
      windowMs: WINDOW_MS,
      oldestTimestampMs: null,
      resetAtMs: null,
      plan,
      limit,
    };
  }

  let blocks: any[] = [];
  try {
    const result = await loadSessionBlockData();
    if (Array.isArray(result)) {
      blocks = result;
    } else if (result && typeof result === 'object') {
      const candidate = (result as { blocks?: any[]; data?: any[] }).blocks ?? (result as { data?: any[] }).data;
      blocks = Array.isArray(candidate) ? candidate : [];
    }
  } catch {
    return {
      status: 'unavailable',
      totalTokens: 0,
      windowMs: WINDOW_MS,
      oldestTimestampMs: null,
      resetAtMs: null,
      plan,
      limit,
    };
  }

  if (!Array.isArray(blocks) || blocks.length === 0) {
    return {
      status: 'ok',
      totalTokens: 0,
      windowMs: WINDOW_MS,
      oldestTimestampMs: null,
      resetAtMs: null,
      plan,
      limit,
    };
  }

  const inferredLimit = limit;
  const activeBlock = blocks.find(block => block?.isActive && !block?.isGap) ??
    blocks.find(block => !block?.isGap) ??
    blocks[blocks.length - 1];
  const totalTokens = getBlockTokenTotal(activeBlock);
  const oldestTimestampMs = getBlockStartMs(activeBlock);
  const resetAtMs =
    parseBlockTimestampMs(activeBlock?.usageLimitResetTime) ??
    getBlockEndMs(activeBlock);

  return {
    status: 'ok',
    totalTokens,
    windowMs: WINDOW_MS,
    oldestTimestampMs,
    resetAtMs,
    plan,
    limit: inferredLimit,
  };
}

export class UsageMonitorService {
  private windowManager: WindowManager;
  private watchers: FSWatcher[] = [];
  private pollInterval: NodeJS.Timeout | null = null;
  private debounceTimer: NodeJS.Timeout | null = null;
  private lastSnapshotKey: string | null = null;

  constructor(windowManager: WindowManager) {
    this.windowManager = windowManager;
  }

  start(): void {
    void this.refreshAndBroadcast();
    void this.startWatcherOrPolling();
  }

  async getSnapshot(): Promise<UsageMonitorSnapshot> {
    return computeUsageSnapshot();
  }

  async refreshAndBroadcast(): Promise<void> {
    const snapshot = await computeUsageSnapshot();
    const key = JSON.stringify(snapshot);
    if (key !== this.lastSnapshotKey) {
      this.lastSnapshotKey = key;
      this.windowManager.broadcastToAll(IPC_CHANNELS.USAGE_MONITOR_STATS_CHANGED, snapshot);
    }
  }

  private async startWatcherOrPolling(): Promise<void> {
    try {
      const { getClaudePaths } = await getCcusageLoader();
      const baseDirs = getClaudePaths();
      const projectsDirs = getClaudeProjectsDirs(baseDirs);
      if (projectsDirs.length === 0) {
        this.startPolling();
        return;
      }

      for (const dir of projectsDirs) {
        const watcher = watch(dir, { recursive: true }, (_eventType, filename) => {
          if (filename && !filename.endsWith('.jsonl')) return;
          this.scheduleRefresh();
        });
        watcher.on('error', () => {
          this.stopWatcher();
          this.startPolling();
        });
        this.watchers.push(watcher);
      }
    } catch {
      this.startPolling();
    }
  }

  private scheduleRefresh(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }
    this.debounceTimer = setTimeout(() => {
      void this.refreshAndBroadcast();
    }, DEBOUNCE_MS);
  }

  private startPolling(): void {
    if (this.pollInterval) return;
    this.pollInterval = setInterval(() => {
      void this.refreshAndBroadcast();
    }, POLL_INTERVAL_MS);
  }

  private stopWatcher(): void {
    for (const watcher of this.watchers) {
      watcher.close();
    }
    this.watchers = [];
  }
}

export function createUsageMonitorService(windowManager: WindowManager): UsageMonitorService {
  return new UsageMonitorService(windowManager);
}
