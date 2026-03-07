/**
 * Layer 1a — ServerBackend unit tests against a live mnemo-server.
 *
 * Skips gracefully when MNEMO_BENCH_API_URL is not set.
 *
 * Setup: provisions a fresh space via POST /api/spaces (unauthenticated),
 * then uses the returned token for all CRUD operations.
 */

import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";
import { ServerBackend } from "../../openclaw-plugin/server-backend";
import type { Memory } from "../../openclaw-plugin/types";

const apiUrl = process.env.MNEMO_BENCH_API_URL;
const describeWithServer = apiUrl ? describe : describe.skip;

describeWithServer("Layer 1a — ServerBackend", () => {
  let backend: ServerBackend;
  let keyPrefix: string;
  let createdIds: string[];

  beforeAll(async () => {
    // Provision a bench space via the unauthenticated bootstrap endpoint.
    const resp = await fetch(`${apiUrl}/api/spaces`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: `bench-${Date.now()}`,
        agent_name: "bench-agent",
        agent_type: "benchmark",
      }),
    });
    expect(resp.ok).toBe(true);
    const body = (await resp.json()) as { ok: boolean; space_id: string; api_token: string };
    expect(body.ok).toBe(true);

    backend = new ServerBackend(apiUrl!, body.api_token, "bench-agent");
  });

  beforeEach(() => {
    keyPrefix = `bench-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    createdIds = [];
  });

  afterEach(async () => {
    for (const id of createdIds) {
      await backend.remove(id).catch(() => {});
    }
  });

  function track(mem: Memory): Memory {
    createdIds.push(mem.id);
    return mem;
  }

  // ---------------------------------------------------------------------------
  // store
  // ---------------------------------------------------------------------------

  describe("store", () => {
    it("creates new memory without key", async () => {
      const mem = track(
        await backend.store({ content: `${keyPrefix} hello world` }),
      );
      expect(mem.id).toBeTruthy();
      expect(mem.content).toBe(`${keyPrefix} hello world`);
      expect(mem.version).toBe(1);
      expect(mem.created_at).toBeTruthy();
      expect(mem.updated_at).toBeTruthy();
    });

    it("creates with unique key", async () => {
      const key = `${keyPrefix}:keyed`;
      const mem = track(await backend.store({ content: "keyed content", key }));
      expect(mem.key).toBe(key);
      expect(mem.version).toBe(1);
    });

    it("upserts by key, increments version", async () => {
      const key = `${keyPrefix}:upsert`;
      const first = track(await backend.store({ content: "v1", key }));
      const second = await backend.store({ content: "v2", key });

      expect(second.id).toBe(first.id);
      expect(second.content).toBe("v2");
      expect(second.version).toBeGreaterThanOrEqual(2);
    });

    it("stores with tags", async () => {
      const mem = track(
        await backend.store({
          content: `${keyPrefix} tagged`,
          tags: ["bench", "test"],
        }),
      );
      expect(mem.tags).toEqual(expect.arrayContaining(["bench", "test"]));
    });

    it("stores with metadata", async () => {
      const metadata = { env: "bench", num: 42 };
      const mem = track(
        await backend.store({
          content: `${keyPrefix} meta`,
          metadata,
        }),
      );
      expect(mem.metadata).toEqual(expect.objectContaining(metadata));
    });

    it("rejects empty content", async () => {
      await expect(backend.store({ content: "" })).rejects.toThrow();
    });
  });

  // ---------------------------------------------------------------------------
  // search
  // ---------------------------------------------------------------------------

  describe("search", () => {
    it("finds memory by keyword query", async () => {
      const unique = `xylophone-${keyPrefix}`;
      track(await backend.store({ content: unique }));

      // Small delay for FTS indexing
      await new Promise((r) => setTimeout(r, 500));

      const result = await backend.search({ q: unique, limit: 5 });
      expect(result.data.length).toBeGreaterThanOrEqual(1);
      expect(result.data.some((m) => m.content.includes(unique))).toBe(true);
    });

    it("filters by tag", async () => {
      const tag = `tag-${keyPrefix}`;
      track(await backend.store({ content: `${keyPrefix} a`, tags: [tag] }));
      track(
        await backend.store({ content: `${keyPrefix} b`, tags: ["other"] }),
      );

      await new Promise((r) => setTimeout(r, 500));

      const result = await backend.search({ tags: tag, limit: 10 });
      expect(result.data.length).toBeGreaterThanOrEqual(1);
      for (const m of result.data) {
        expect(m.tags).toEqual(expect.arrayContaining([tag]));
      }
    });

    it("filters by source", async () => {
      track(await backend.store({ content: `${keyPrefix} source-test` }));

      await new Promise((r) => setTimeout(r, 500));

      const result = await backend.search({
        source: "bench-agent",
        limit: 5,
      });
      for (const m of result.data) {
        expect(m.source).toBe("bench-agent");
      }
    });

    it("respects limit and offset", async () => {
      // Store 5 distinct memories
      for (let i = 0; i < 5; i++) {
        track(
          await backend.store({
            content: `${keyPrefix} paginate-${i}`,
            key: `${keyPrefix}:page-${i}`,
          }),
        );
      }

      await new Promise((r) => setTimeout(r, 500));

      const page1 = await backend.search({
        key: `${keyPrefix}:page-`,
        limit: 2,
        offset: 0,
      });
      const page2 = await backend.search({
        key: `${keyPrefix}:page-`,
        limit: 2,
        offset: 2,
      });

      expect(page1.data.length).toBeLessThanOrEqual(2);
      expect(page2.data.length).toBeLessThanOrEqual(2);

      // Pages should not overlap
      const ids1 = new Set(page1.data.map((m) => m.id));
      for (const m of page2.data) {
        expect(ids1.has(m.id)).toBe(false);
      }
    });

    it("returns empty for non-matching query", async () => {
      const result = await backend.search({
        q: `zzz-nonexistent-${Date.now()}-${Math.random()}`,
        limit: 5,
      });
      expect(result.data).toEqual([]);
    });
  });

  // ---------------------------------------------------------------------------
  // get
  // ---------------------------------------------------------------------------

  describe("get", () => {
    it("retrieves existing memory by id", async () => {
      const mem = track(
        await backend.store({ content: `${keyPrefix} get-test` }),
      );
      const fetched = await backend.get(mem.id);
      expect(fetched).not.toBeNull();
      expect(fetched!.id).toBe(mem.id);
      expect(fetched!.content).toBe(mem.content);
    });

    it("returns null for non-existent id", async () => {
      const result = await backend.get("00000000-0000-0000-0000-000000000000");
      expect(result).toBeNull();
    });
  });

  // ---------------------------------------------------------------------------
  // update
  // ---------------------------------------------------------------------------

  describe("update", () => {
    it("updates content", async () => {
      const mem = track(
        await backend.store({ content: `${keyPrefix} update-me` }),
      );
      const updated = await backend.update(mem.id, {
        content: `${keyPrefix} updated`,
      });
      expect(updated).not.toBeNull();
      expect(updated!.content).toBe(`${keyPrefix} updated`);
      expect(updated!.version).toBeGreaterThan(mem.version!);
    });

    it("partial update (tags only)", async () => {
      const mem = track(
        await backend.store({
          content: `${keyPrefix} partial`,
          tags: ["original"],
        }),
      );
      const updated = await backend.update(mem.id, { tags: ["changed"] });
      expect(updated).not.toBeNull();
      expect(updated!.tags).toEqual(expect.arrayContaining(["changed"]));
      // Content should be preserved
      expect(updated!.content).toBe(`${keyPrefix} partial`);
    });

    it("returns null for non-existent id", async () => {
      const result = await backend.update(
        "00000000-0000-0000-0000-000000000000",
        { content: "nope" },
      );
      expect(result).toBeNull();
    });

    it("increments version on each update", async () => {
      const mem = track(
        await backend.store({ content: `${keyPrefix} version-inc` }),
      );
      const v2 = await backend.update(mem.id, { content: "v2" });
      const v3 = await backend.update(mem.id, { content: "v3" });

      expect(v2!.version).toBeGreaterThan(mem.version!);
      expect(v3!.version).toBeGreaterThan(v2!.version!);
    });
  });

  // ---------------------------------------------------------------------------
  // remove
  // ---------------------------------------------------------------------------

  describe("remove", () => {
    it("removes existing memory", async () => {
      const mem = await backend.store({
        content: `${keyPrefix} remove-me`,
      });
      const removed = await backend.remove(mem.id);
      expect(removed).toBe(true);

      const gone = await backend.get(mem.id);
      expect(gone).toBeNull();
    });

    it("returns false for non-existent id", async () => {
      const result = await backend.remove(
        "00000000-0000-0000-0000-000000000000",
      );
      expect(result).toBe(false);
    });

    it("idempotent second remove", async () => {
      const mem = await backend.store({
        content: `${keyPrefix} remove-twice`,
      });
      const first = await backend.remove(mem.id);
      expect(first).toBe(true);

      // Server uses soft-delete (tombstone), so second remove returns 204 → true
      const second = await backend.remove(mem.id);
      expect(second).toBe(true);
    });
  });
});
