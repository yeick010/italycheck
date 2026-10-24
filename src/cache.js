// Tiny TTL + LRU cache for plain data only (never promises/Responses): Workers forbid sharing I/O objects
// across requests. Map keeps insertion order; a hit is re-inserted so the oldest entry is evicted first.
export class PlainCache {
  constructor(max = 500, ttlMs = 3600_000) { this.max = max; this.ttl = ttlMs; this.m = new Map(); }
  get(k) {
    const e = this.m.get(k);
    if (!e) return undefined;
    this.m.delete(k);
    if (Date.now() - e.t > this.ttl) return undefined;
    this.m.set(k, e);
    return e.v;
  }
  set(k, v) {
    this.m.delete(k);
    this.m.set(k, { v, t: Date.now() });
    while (this.m.size > this.max) this.m.delete(this.m.keys().next().value);
  }
  get size() { return this.m.size; }
  clear() { this.m.clear(); }
}
