/**
 * Argument redaction — deep-clones and masks specified dot-paths.
 *
 * Supports "a.b.c", "a[0].b" and the trailing wildcard "a.*" (redacts every
 * own key one level below "a"). Missing paths are silently ignored.
 * Never mutates the input.
 */

// ---------------------------------------------------------------------------
// Path parsing (shared with eval, but intentionally self-contained here)
// ---------------------------------------------------------------------------

function parsePath(path: string): string[] {
  return path.split('.').flatMap(seg => {
    const m = /^(.+?)\[(\d+)\]$/.exec(seg);
    if (m) return [m[1]!, m[2]!];
    return [seg];
  });
}

// ---------------------------------------------------------------------------
// Deep clone
// ---------------------------------------------------------------------------

function deepClone<T>(value: T): T {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(deepClone) as unknown as T;
  const clone: Record<string, unknown> = {};
  for (const key of Object.keys(value as Record<string, unknown>)) {
    clone[key] = deepClone((value as Record<string, unknown>)[key]);
  }
  return clone as T;
}

// ---------------------------------------------------------------------------
// Navigator: get the container and last key for a path so we can write.
// Returns null when the path does not exist (silently ignored).
// ---------------------------------------------------------------------------

interface PathTarget {
  container: Record<string, unknown> | unknown[];
  key: string | number;
}

function resolvePathTarget(obj: unknown, path: string): PathTarget | null {
  const parts = parsePath(path);
  if (parts.length === 0) return null;

  let cur: any = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const p = parts[i]!;
    if (cur === null || cur === undefined) return null;
    if (Array.isArray(cur)) {
      const idx = Number(p);
      if (!Number.isInteger(idx) || idx < 0 || idx >= cur.length) return null;
      cur = cur[idx];
    } else if (typeof cur === 'object') {
      if (!(p in cur)) return null;
      cur = (cur as Record<string, unknown>)[p];
    } else {
      return null;
    }
  }

  const last = parts[parts.length - 1]!;
  if (Array.isArray(cur)) {
    const idx = Number(last);
    if (!Number.isInteger(idx) || idx < 0 || idx >= cur.length) return null;
    return { container: cur, key: idx };
  } else if (typeof cur === 'object' && cur !== null) {
    if (!(last in cur)) return null;
    return { container: cur as Record<string, unknown>, key: last };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function redactArgs(
  args: Record<string, unknown>,
  paths: string[],
): Record<string, unknown> {
  const cloned = deepClone(args);

  for (const path of paths) {
    if (path.endsWith('.*')) {
      // Wildcard: redact every own key one level below the prefix.
      const prefix = path.slice(0, -2);
      if (prefix === '') {
        // ".*" → redact every top-level key
        for (const key of Object.keys(cloned)) {
          cloned[key] = '[REDACTED]';
        }
      } else {
        const target = resolvePathTarget(cloned, prefix);
        if (target) {
          const container = target.container;
          const key = target.key;
          const val = Array.isArray(container)
            ? container[key as number]
            : container[key as string];
          if (val !== null && typeof val === 'object' && !Array.isArray(val)) {
            for (const k of Object.keys(val as Record<string, unknown>)) {
              (val as Record<string, unknown>)[k] = '[REDACTED]';
            }
          }
        }
      }
    } else {
      const target = resolvePathTarget(cloned, path);
      if (target) {
        const { container, key } = target;
        if (Array.isArray(container)) {
          container[key as number] = '[REDACTED]';
        } else {
          container[key as string] = '[REDACTED]';
        }
      }
    }
  }

  return cloned;
}
