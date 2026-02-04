import { existsSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { CONFIG_DIR } from './paths.ts';
import { ensureConfigDir } from './storage.ts';

export type UsageMonitorPlan = 'pro' | 'max5' | 'max20';

export const DEFAULT_PRO_LIMIT = 5_500_000;

export interface UsageMonitorConfig {
  plan: UsageMonitorPlan;
  limits: {
    pro: number;
  };
}

const USAGE_MONITOR_FILE = join(CONFIG_DIR, 'usage-monitor.json');
const DEFAULT_CONFIG: UsageMonitorConfig = {
  plan: 'pro',
  limits: {
    pro: DEFAULT_PRO_LIMIT,
  },
};

function sanitizeConfig(raw: unknown): UsageMonitorConfig {
  const config = (raw && typeof raw === 'object' ? raw : {}) as Partial<UsageMonitorConfig>;
  const plan = config.plan === 'max5' || config.plan === 'max20' ? config.plan : 'pro';
  const limits = {
    pro: typeof config.limits?.pro === 'number' && config.limits.pro > 0 ? config.limits.pro : DEFAULT_CONFIG.limits.pro,
  };
  return {
    plan,
    limits,
  };
}

export function loadUsageMonitorConfig(): UsageMonitorConfig {
  try {
    if (!existsSync(USAGE_MONITOR_FILE)) {
      ensureConfigDir();
      writeFileSync(USAGE_MONITOR_FILE, JSON.stringify(DEFAULT_CONFIG, null, 2), 'utf-8');
      return DEFAULT_CONFIG;
    }
    const content = readFileSync(USAGE_MONITOR_FILE, 'utf-8');
    const parsed = JSON.parse(content);
    const sanitized = sanitizeConfig(parsed);
    return sanitized;
  } catch {
    return DEFAULT_CONFIG;
  }
}

export function saveUsageMonitorConfig(config: UsageMonitorConfig): void {
  ensureConfigDir();
  writeFileSync(USAGE_MONITOR_FILE, JSON.stringify(config, null, 2), 'utf-8');
}

export function getUsageMonitorPlan(): UsageMonitorPlan {
  return loadUsageMonitorConfig().plan;
}

export function setUsageMonitorPlan(plan: UsageMonitorPlan): void {
  const current = loadUsageMonitorConfig();
  saveUsageMonitorConfig({
    ...current,
    plan: plan === 'max5' || plan === 'max20' ? plan : 'pro',
  });
}

export function getUsageMonitorLimits(): { pro: number; max5: number; max20: number } {
  const { limits } = loadUsageMonitorConfig();
  return {
    pro: limits.pro,
    max5: limits.pro * 5,
    max20: limits.pro * 20,
  };
}

export function setUsageMonitorProLimit(limit: number): void {
  const current = loadUsageMonitorConfig();
  const nextLimit = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : DEFAULT_PRO_LIMIT;
  saveUsageMonitorConfig({
    ...current,
    limits: {
      ...current.limits,
      pro: nextLimit,
    },
  });
}
