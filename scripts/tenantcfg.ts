/**
 * Usage examples:
 *
 * Read:
 * npm run tenantcfg -- --tenant titan-spring
 *
 * Hot swap STT URL:
 * npm run tenantcfg -- --tenant titan-spring --set stt.mode=whisper_http --set stt.config.url=http://VERATITAN_IP:9000/transcribe
 *
 * Disable STT:
 * npm run tenantcfg -- --tenant titan-spring --set stt.mode=disabled
 *
 * Dry run:
 * npm run tenantcfg -- --tenant titan-spring --set stt.mode=http_wav_json --dryRun
 *
 * Unset a field:
 * npm run tenantcfg -- --tenant titan-spring --unset stt.whisperUrl
 */

import { getRedisClient, type RedisClient } from '../src/redis/client';
import { buildTenantConfigKey, RuntimeTenantConfigSchema } from '../src/tenants/tenantConfig';

type PatchReport = {
  path: string;
  oldValue: unknown;
  newValue: unknown;
};

type ParsedArgs = {
  tenantId?: string;
  sets: string[];
  unsets: string[];
  mergeJson: string[];
  dryRun: boolean;
};

class ValidationError extends Error {
  public readonly issues: Array<{ path: Array<string | number>; message: string }>;

  constructor(issues: Array<{ path: Array<string | number>; message: string }>) {
    super('tenant config validation failed');
    this.issues = issues;
  }
}

function parseArgs(argv: string[]): ParsedArgs {
  const parsed: ParsedArgs = {
    sets: [],
    unsets: [],
    mergeJson: [],
    dryRun: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--dryRun') {
      parsed.dryRun = true;
      continue;
    }

    if (arg === '--tenant') {
      parsed.tenantId = argv[i + 1];
      i += 1;
      continue;
    }

    if (arg.startsWith('--tenant=')) {
      parsed.tenantId = arg.slice('--tenant='.length);
      continue;
    }

    if (arg === '--set') {
      const value = argv[i + 1];
      if (!value) {
        throw new Error('missing value for --set');
      }
      parsed.sets.push(value);
      i += 1;
      continue;
    }

    if (arg.startsWith('--set=')) {
      parsed.sets.push(arg.slice('--set='.length));
      continue;
    }

    if (arg === '--unset') {
      const value = argv[i + 1];
      if (!value) {
        throw new Error('missing value for --unset');
      }
      parsed.unsets.push(value);
      i += 1;
      continue;
    }

    if (arg.startsWith('--unset=')) {
      parsed.unsets.push(arg.slice('--unset='.length));
      continue;
    }

    if (arg === '--mergeJson') {
      const value = argv[i + 1];
      if (!value) {
        throw new Error('missing value for --mergeJson');
      }
      parsed.mergeJson.push(value);
      i += 1;
      continue;
    }

    if (arg.startsWith('--mergeJson=')) {
      parsed.mergeJson.push(arg.slice('--mergeJson='.length));
      continue;
    }

    throw new Error(`unknown argument: ${arg}`);
  }

  return parsed;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function parsePath(path: string): string[] {
  const trimmed = path.trim();
  if (!trimmed) {
    throw new Error('path cannot be empty');
  }
  const segments = trimmed.split('.');
  if (segments.some((segment) => segment.trim() === '')) {
    throw new Error(`invalid path: ${path}`);
  }
  return segments;
}

function getAtPath(obj: Record<string, unknown>, path: string): unknown {
  const segments = parsePath(path);
  let current: unknown = obj;
  for (const segment of segments) {
    if (!isPlainObject(current)) {
      return undefined;
    }
    if (!(segment in current)) {
      return undefined;
    }
    current = current[segment];
  }
  return current;
}

function setAtPath(obj: Record<string, unknown>, path: string, value: unknown): void {
  const segments = parsePath(path);
  let current: Record<string, unknown> = obj;

  for (let i = 0; i < segments.length - 1; i += 1) {
    const segment = segments[i];
    const existing = current[segment];
    if (existing === undefined) {
      current[segment] = {};
    } else if (!isPlainObject(existing)) {
      throw new Error(`invalid path segment "${segment}" in ${path}`);
    }
    current = current[segment] as Record<string, unknown>;
  }

  current[segments[segments.length - 1]] = value;
}

function unsetAtPath(obj: Record<string, unknown>, path: string): void {
  const segments = parsePath(path);
  let current: Record<string, unknown> = obj;

  for (let i = 0; i < segments.length - 1; i += 1) {
    const segment = segments[i];
    const existing = current[segment];
    if (!isPlainObject(existing)) {
      throw new Error(`invalid path segment "${segment}" in ${path}`);
    }
    current = existing;
  }

  const leaf = segments[segments.length - 1];
  if (!(leaf in current)) {
    throw new Error(`path not found for unset: ${path}`);
  }
  delete current[leaf];
}

function parseValue(raw: string): unknown {
  const trimmed = raw.trim();
  const lower = trimmed.toLowerCase();

  if (lower === 'true') return true;
  if (lower === 'false') return false;
  if (lower === 'null') return null;

  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      return JSON.parse(trimmed);
    } catch (error) {
      throw new Error(`invalid JSON value: ${raw}`);
    }
  }

  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    if (trimmed.startsWith('"')) {
      try {
        return JSON.parse(trimmed);
      } catch {
        return trimmed.slice(1, -1);
      }
    }
    return trimmed.slice(1, -1);
  }

  if (/^[-+]?\d+(\.\d+)?$/.test(trimmed)) {
    const num = Number(trimmed);
    if (!Number.isNaN(num)) {
      return num;
    }
  }

  return trimmed;
}

function deepMergeInto(target: Record<string, unknown>, source: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(source)) {
    if (isPlainObject(value) && isPlainObject(target[key])) {
      deepMergeInto(target[key] as Record<string, unknown>, value);
    } else {
      target[key] = value;
    }
  }
}

function formatValue(value: unknown): string {
  if (value === undefined) {
    return '<undefined>';
  }
  return JSON.stringify(value);
}

function printIssues(issues: Array<{ path: Array<string | number>; message: string }>): void {
  process.stderr.write('Validation failed:\n');
  for (const issue of issues) {
    const path = issue.path.length > 0 ? issue.path.join('.') : '<root>';
    process.stderr.write(`- ${path}: ${issue.message}\n`);
  }
}

async function loadTenantConfig(redis: RedisClient, tenantId: string): Promise<Record<string, unknown>> {
  const key = buildTenantConfigKey(tenantId);
  let raw: string | null;

  try {
    raw = await redis.get(key);
  } catch (error) {
    throw new Error(`failed to read tenant config: ${String(error)}`);
  }

  if (!raw) {
    throw new Error(`tenant config not found for "${tenantId}"`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`invalid tenant config JSON for "${tenantId}"`);
  }

  if (!isPlainObject(parsed)) {
    throw new Error(`tenant config for "${tenantId}" must be an object`);
  }

  return parsed;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (!args.tenantId) {
    throw new Error('missing --tenant <tenantId>');
  }

  const redis = getRedisClient();
  try {
    const key = buildTenantConfigKey(args.tenantId);
    const hasPatches =
      args.sets.length > 0 || args.unsets.length > 0 || args.mergeJson.length > 0;

    const baseConfig = await loadTenantConfig(redis, args.tenantId);

    if (!hasPatches) {
      const result = RuntimeTenantConfigSchema.safeParse(baseConfig);
      if (!result.success) {
        throw new ValidationError(result.error.issues);
      }
      process.stdout.write(`${JSON.stringify(result.data, null, 2)}\n`);
      return;
    }

    const originalConfig = JSON.parse(JSON.stringify(baseConfig)) as Record<string, unknown>;
    const updatedConfig = JSON.parse(JSON.stringify(baseConfig)) as Record<string, unknown>;

    for (const rawMerge of args.mergeJson) {
      let mergeValue: unknown;
      try {
        mergeValue = JSON.parse(rawMerge);
      } catch {
        throw new Error(`invalid JSON for --mergeJson: ${rawMerge}`);
      }
      if (!isPlainObject(mergeValue)) {
        throw new Error('--mergeJson must be a JSON object');
      }
      deepMergeInto(updatedConfig, mergeValue);
    }

    const patchReports: PatchReport[] = [];

    for (const rawSet of args.sets) {
      const eqIndex = rawSet.indexOf('=');
      if (eqIndex <= 0) {
        throw new Error(`invalid --set value (expected path=value): ${rawSet}`);
      }
      const path = rawSet.slice(0, eqIndex).trim();
      const valueRaw = rawSet.slice(eqIndex + 1);
      const value = parseValue(valueRaw);
      const oldValue = getAtPath(originalConfig, path);
      setAtPath(updatedConfig, path, value);
      const newValue = getAtPath(updatedConfig, path);
      patchReports.push({ path, oldValue, newValue });
    }

    for (const rawUnset of args.unsets) {
      const path = rawUnset.trim();
      const oldValue = getAtPath(originalConfig, path);
      unsetAtPath(updatedConfig, path);
      const newValue = getAtPath(updatedConfig, path);
      patchReports.push({ path, oldValue, newValue });
    }

    process.stdout.write(`Redis key: ${key}\n`);
    for (const report of patchReports) {
      process.stdout.write(`Path: ${report.path}\n`);
      process.stdout.write(`  old: ${formatValue(report.oldValue)}\n`);
      process.stdout.write(`  new: ${formatValue(report.newValue)}\n`);
    }
    if (args.mergeJson.length > 0 && patchReports.length === 0) {
      process.stdout.write('Merge JSON applied.\n');
    }

    const result = RuntimeTenantConfigSchema.safeParse(updatedConfig);
    if (!result.success) {
      throw new ValidationError(result.error.issues);
    }

    if (args.dryRun) {
      process.stdout.write('Dry run: no changes written.\n');
      return;
    }

    await redis.set(key, JSON.stringify(result.data));
    process.stdout.write('Tenant config updated.\n');
  } finally {
    await redis.quit();
  }
}

main().catch((error) => {
  if (error instanceof ValidationError) {
    printIssues(error.issues);
  } else {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  }
  process.exit(1);
});
