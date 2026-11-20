/**
 * Tiny client-side GET cache with stale-while-revalidate semantics.
 *
 * The Merchant workspace has several independently mounted tabs. Every tab used
 * to re-request its data on first entry, even when nothing had changed. This
 * module gives all of them one shared cache so a tab switch reads locally and a
 * background refresh happens only when the entry is stale. In-flight requests
 * are deduplicated, which also removes the parallel-prefetch duplication.
 */

type Entry = { data: unknown; at: number };

const PREFIX = "savour:api-cache:v1:";
const DEFAULT_TTL = 30_000;
const PERSIST_TTL = 12 * 60 * 60 * 1000;

const entries = new Map<string, Entry>();
const inflight = new Map<string, Promise<unknown>>();
let scope = "default";
let generation = 0;
let hydrated = false;

function storage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.sessionStorage;
  } catch {
    return null;
  }
}

function hydrate() {
  if (hydrated) return;
  hydrated = true;
  const store = storage();
  if (!store) return;
  const prefix = `${PREFIX}${scope}:`;
  const keys: string[] = [];
  try {
    for (let index = 0; index < store.length; index += 1) {
      const key = store.key(index);
      if (key?.startsWith(prefix)) keys.push(key);
    }
    for (const key of keys) {
      const raw = store.getItem(key);
      if (!raw) continue;
      try {
        const parsed = JSON.parse(raw) as Entry;
        if (typeof parsed.at === "number" && Date.now() - parsed.at <= PERSIST_TTL) {
          entries.set(key.slice(prefix.length), parsed);
        } else {
          store.removeItem(key);
        }
      } catch {
        store.removeItem(key);
      }
    }
  } catch {
    // Storage is best-effort; the in-memory cache still works.
  }
}

function persistKey(path: string) {
  return `${PREFIX}${scope}:${path}`;
}

function write(path: string, data: unknown, persist: boolean, at: number, gen: number) {
  if (gen !== generation) return;
  entries.set(path, { data, at });
  if (!persist) return;
  try {
    storage()?.setItem(persistKey(path), JSON.stringify({ data, at }));
  } catch {
    // Session storage may be full or unavailable; keep the in-memory entry.
  }
}

function load<T>(path: string, fetcher: () => Promise<T>, ttl: number, persist: boolean): Promise<T> {
  const pending = inflight.get(path);
  if (pending) return pending as Promise<T>;
  const gen = generation;
  const task = fetcher()
    .then((data) => {
      write(path, data, persist, Date.now(), gen);
      return data;
    })
    .finally(() => {
      if (inflight.get(path) === task) inflight.delete(path);
    });
  inflight.set(path, task);
  return task;
}

/** Scope the cache to the signed-in user and active outlet. Changing scope clears everything. */
export function setCacheScope(next: string) {
  if (next === scope) return;
  scope = next;
  clearApiCache();
}

export function getCached<T>(path: string): T | undefined {
  hydrate();
  return entries.get(path)?.data as T | undefined;
}

export function isCachePending(path: string) {
  return inflight.has(path);
}

export function isCacheStale(path: string, ttl = DEFAULT_TTL) {
  hydrate();
  const entry = entries.get(path);
  return !entry || Date.now() - entry.at > ttl;
}

/** Resolve from cache immediately; refresh in the background when stale. */
export function cachedGet<T>(path: string, fetcher: () => Promise<T>, ttl = DEFAULT_TTL, persist = true): Promise<T> {
  hydrate();
  const hit = entries.get(path);
  if (hit) {
    if (Date.now() - hit.at > ttl && !inflight.has(path)) void load(path, fetcher, ttl, persist).catch(() => {});
    return Promise.resolve(hit.data as T);
  }
  return load(path, fetcher, ttl, persist);
}

/** Force a network read but still update the shared cache with the result. */
export function refreshCached<T>(path: string, fetcher: () => Promise<T>, ttl = DEFAULT_TTL, persist = true): Promise<T> {
  hydrate();
  entries.delete(path);
  return load(path, fetcher, ttl, persist);
}

/** Start a request without awaiting it; duplicate calls share the same promise. */
export function preloadCached(path: string, fetcher: () => Promise<unknown>, ttl = DEFAULT_TTL, persist = true) {
  if (!isCacheStale(path, ttl)) return;
  void load(path, fetcher, ttl, persist).catch(() => {});
}

/** Seed a cache entry from server-rendered data so the first tab read is a local hit. */
export function seedCached<T>(path: string, data: T, persist = true) {
  hydrate();
  write(path, data, persist, Date.now(), generation);
}

/** Keep cached data visible after a write, but revalidate it on the next read. */
export function markApiCacheStale(prefix?: string) {
  hydrate();
  const store = storage();
  for (const [path, entry] of entries) {
    if (prefix && !path.startsWith(prefix)) continue;
    entries.set(path, { ...entry, at: 0 });
    if (!store) continue;
    try {
      store.setItem(persistKey(path), JSON.stringify({ data: entry.data, at: 0 }));
    } catch {
      // Ignore storage failures.
    }
  }
}

/** Hard-remove entries (sign-out, outlet switch, epoch change). */
export function clearApiCache(prefix?: string) {
  generation += 1;
  hydrate();
  const store = storage();
  const keys: string[] = [];
  for (const path of [...entries.keys()]) {
    if (prefix && !path.startsWith(prefix)) continue;
    entries.delete(path);
    if (store) keys.push(persistKey(path));
  }
  for (const [path, pending] of [...inflight]) {
    if (!prefix || path.startsWith(prefix)) inflight.delete(path);
    void pending.catch(() => {});
  }
  if (!store) return;
  for (const key of keys) {
    try {
      store.removeItem(key);
    } catch {
      // Ignore storage failures.
    }
  }
}
