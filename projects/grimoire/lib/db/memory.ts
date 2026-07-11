// In-memory Database impl — for tests and zero-credential local dev. Implements
// the same contract as the Mongo adapter, so business logic is identical against
// either. Not durable; not for production.

import type { Collection, Database, Entity, Filter, FindOneOptions } from "./types";

let idSeq = 0;
function nextId(): string {
  idSeq += 1;
  return `mem_${idSeq.toString(36)}`;
}

function matches<T extends Entity>(doc: T, filter: Filter<T>): boolean {
  return Object.entries(filter).every(
    ([k, v]) => (doc as Record<string, unknown>)[k] === v,
  );
}

class MemoryCollection<T extends Entity> implements Collection<T> {
  private rows: T[] = [];

  async insert(doc: T): Promise<T> {
    const row = { ...doc, _id: doc._id ?? nextId() } as T;
    this.rows.push(row);
    return { ...row };
  }

  async findOne(filter: Filter<T>, opts?: FindOneOptions<T>): Promise<T | null> {
    const candidates = this.rows.filter((r) => matches(r, filter));
    if (candidates.length === 0) return null;
    if (opts?.sort) {
      // Apply the sort spec (first key wins ties to the next) and return the
      // extreme row — mirrors Mongo's findOne({sort}).
      const entries = Object.entries(opts.sort) as Array<[keyof T, 1 | -1]>;
      candidates.sort((a, b) => {
        for (const [key, dir] of entries) {
          const av = a[key];
          const bv = b[key];
          if (av === bv) continue;
          return (av < bv ? -1 : 1) * dir;
        }
        return 0;
      });
    }
    return { ...candidates[0] };
  }

  async find(filter: Filter<T> = {}): Promise<T[]> {
    return this.rows.filter((r) => matches(r, filter)).map((r) => ({ ...r }));
  }

  async findProjected(filter: Filter<T>, project: (keyof T)[]): Promise<Partial<T>[]> {
    const keys = new Set<keyof T>([...project, "_id" as keyof T]);
    return this.rows
      .filter((r) => matches(r, filter))
      .map((r) => {
        const out: Partial<T> = {};
        for (const k of keys) if (k in r) out[k] = r[k];
        return out;
      });
  }

  async update(filter: Filter<T>, patch: Partial<T>): Promise<number> {
    let n = 0;
    this.rows = this.rows.map((r) => {
      if (matches(r, filter)) {
        n += 1;
        return { ...r, ...patch };
      }
      return r;
    });
    return n;
  }

  async upsert(filter: Filter<T>, doc: T): Promise<T> {
    const existing = this.rows.find((r) => matches(r, filter));
    if (existing) {
      Object.assign(existing, doc);
      return { ...existing };
    }
    return this.insert({ ...doc, ...filter } as T);
  }

  async delete(filter: Filter<T>): Promise<number> {
    const before = this.rows.length;
    this.rows = this.rows.filter((r) => !matches(r, filter));
    return before - this.rows.length;
  }

  async count(filter: Filter<T> = {}): Promise<number> {
    return this.rows.filter((r) => matches(r, filter)).length;
  }
}

export class MemoryDatabase implements Database {
  private cols = new Map<string, MemoryCollection<Entity>>();

  collection<T extends Entity>(name: string): Collection<T> {
    let col = this.cols.get(name);
    if (!col) {
      col = new MemoryCollection<Entity>();
      this.cols.set(name, col);
    }
    return col as unknown as Collection<T>;
  }

  async close(): Promise<void> {
    this.cols.clear();
  }
}
