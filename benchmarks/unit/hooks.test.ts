/**
 * Layer 1b — Hook unit tests with mock HookApi.
 *
 * No server needed. Tests registerHooks() lifecycle behavior, caching,
 * graceful degradation, and content filtering.
 */

import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
  vi,
} from "vitest";
import { registerHooks } from "../../openclaw-plugin/hooks";
import type { MemoryBackend } from "../../openclaw-plugin/backend";
import type {
  Memory,
  SearchResult,
  CreateMemoryInput,
  UpdateMemoryInput,
  SearchInput,
} from "../../openclaw-plugin/types";

// ---------------------------------------------------------------------------
// Mock helpers
// ---------------------------------------------------------------------------

function makeMemory(overrides: Partial<Memory> = {}): Memory {
  return {
    id: `mem-${Math.random().toString(36).slice(2)}`,
    content: "test memory content",
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    version: 1,
    ...overrides,
  };
}

class MockBackend implements MemoryBackend {
  storedMemories: CreateMemoryInput[] = [];
  searchResults: SearchResult = { data: [], total: 0, limit: 10, offset: 0 };
  shouldThrow = false;

  async store(input: CreateMemoryInput): Promise<Memory> {
    if (this.shouldThrow) throw new Error("mock store error");
    this.storedMemories.push(input);
    return makeMemory({ content: input.content, key: input.key });
  }

  async search(_input: SearchInput): Promise<SearchResult> {
    if (this.shouldThrow) throw new Error("mock search error");
    return this.searchResults;
  }

  async get(_id: string): Promise<Memory | null> {
    return null;
  }

  async update(_id: string, _input: UpdateMemoryInput): Promise<Memory | null> {
    return null;
  }

  async remove(_id: string): Promise<boolean> {
    return true;
  }
}

class MockHookApi {
  handlers = new Map<string, ((...args: unknown[]) => unknown)>();

  on(hookName: string, handler: (...args: unknown[]) => unknown, _opts?: { priority?: number }) {
    this.handlers.set(hookName, handler);
  }

  async dispatch(hookName: string, event: unknown): Promise<unknown> {
    const handler = this.handlers.get(hookName);
    if (!handler) throw new Error(`No handler for ${hookName}`);
    return handler(event);
  }
}

class MockLogger {
  infos: string[] = [];
  errors: string[] = [];

  info = (msg: string) => { this.infos.push(msg); };
  error = (msg: string) => { this.errors.push(msg); };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Layer 1b — Hooks", () => {
  let backend: MockBackend;
  let api: MockHookApi;
  let logger: MockLogger;

  beforeEach(() => {
    backend = new MockBackend();
    api = new MockHookApi();
    logger = new MockLogger();
    registerHooks(api, backend, logger);
  });

  // -------------------------------------------------------------------------
  // before_prompt_build
  // -------------------------------------------------------------------------

  describe("before_prompt_build", () => {
    it("injects memories as prependContext when cache cold", async () => {
      backend.searchResults = {
        data: [makeMemory({ content: "remember this" })],
        total: 1,
        limit: 10,
        offset: 0,
      };

      const searchSpy = vi.spyOn(backend, "search");
      const result = (await api.dispatch("before_prompt_build", {
        prompt: "what do you know about my project?",
      })) as { prependContext?: string } | undefined;

      expect(result?.prependContext).toContain("<relevant-memories>");
      expect(result?.prependContext).toContain("remember this");
      expect(searchSpy).toHaveBeenCalledTimes(1);
      expect(searchSpy).toHaveBeenCalledWith({
        q: "what do you know about my project?",
        limit: 10,
      });
    });

    it("cache hit on second call", async () => {
      backend.searchResults = {
        data: [makeMemory()],
        total: 1,
        limit: 10,
        offset: 0,
      };

      const searchSpy = vi.spyOn(backend, "search");

      await api.dispatch("before_prompt_build", { prompt: "first call" });
      await api.dispatch("before_prompt_build", { prompt: "second call" });

      expect(searchSpy).toHaveBeenCalledTimes(1);
    });

    it("skips short prompts (< 5 chars)", async () => {
      const searchSpy = vi.spyOn(backend, "search");
      const result = await api.dispatch("before_prompt_build", {
        prompt: "hi",
      });

      expect(result).toBeUndefined();
      expect(searchSpy).not.toHaveBeenCalled();
    });

    it("skips missing prompt", async () => {
      const searchSpy = vi.spyOn(backend, "search");
      const result = await api.dispatch("before_prompt_build", {});

      expect(result).toBeUndefined();
      expect(searchSpy).not.toHaveBeenCalled();
    });

    it("returns nothing for empty search results", async () => {
      backend.searchResults = { data: [], total: 0, limit: 10, offset: 0 };

      const result = await api.dispatch("before_prompt_build", {
        prompt: "a valid prompt here",
      });

      expect(result).toBeUndefined();
    });
  });

  // -------------------------------------------------------------------------
  // after_compaction
  // -------------------------------------------------------------------------

  describe("after_compaction", () => {
    it("invalidates cache", async () => {
      backend.searchResults = {
        data: [makeMemory()],
        total: 1,
        limit: 10,
        offset: 0,
      };

      const searchSpy = vi.spyOn(backend, "search");

      // Populate cache
      await api.dispatch("before_prompt_build", { prompt: "fill cache" });
      expect(searchSpy).toHaveBeenCalledTimes(1);

      // Invalidate
      await api.dispatch("after_compaction", {});

      // Should re-query
      await api.dispatch("before_prompt_build", { prompt: "after compact" });
      expect(searchSpy).toHaveBeenCalledTimes(2);
    });

    it("logs invalidation message", async () => {
      await api.dispatch("after_compaction", {});

      expect(
        logger.infos.some((m) => m.includes("compaction")),
      ).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // before_reset
  // -------------------------------------------------------------------------

  describe("before_reset", () => {
    it("stores session summary", async () => {
      const storeSpy = vi.spyOn(backend, "store");
      const messages = [
        { role: "user", content: "Tell me about TiDB architecture" },
        { role: "assistant", content: "TiDB is a distributed SQL database..." },
        { role: "user", content: "How does it handle transactions?" },
        { role: "assistant", content: "TiDB uses Percolator model..." },
        { role: "user", content: "What about vector search support?" },
      ];

      await api.dispatch("before_reset", { messages });

      expect(storeSpy).toHaveBeenCalledTimes(1);
      const input = storeSpy.mock.calls[0][0];
      expect(input.content).toMatch(/^\[session-summary\] /);
      expect(input.key).toMatch(/^session:reset:\d+$/);
      expect(input.source).toBe("openclaw-auto");
      expect(input.tags).toEqual(["auto-capture", "session-summary", "pre-reset"]);
    });

    it("takes only last 3 user messages", async () => {
      const storeSpy = vi.spyOn(backend, "store");
      const messages = [
        { role: "user", content: "first user message here" },
        { role: "user", content: "second user message here" },
        { role: "user", content: "third user message here" },
        { role: "user", content: "fourth user message here" },
        { role: "user", content: "fifth user message here" },
      ];

      await api.dispatch("before_reset", { messages });

      const input = storeSpy.mock.calls[0][0];
      // Should contain last 3 (third, fourth, fifth), not first two
      expect(input.content).toContain("third user message");
      expect(input.content).toContain("fourth user message");
      expect(input.content).toContain("fifth user message");
      expect(input.content).not.toContain("first user message");
      expect(input.content).not.toContain("second user message");
    });

    it("no-op for empty messages", async () => {
      const storeSpy = vi.spyOn(backend, "store");
      await api.dispatch("before_reset", { messages: [] });
      expect(storeSpy).not.toHaveBeenCalled();
    });

    it("no-op for missing messages field", async () => {
      const storeSpy = vi.spyOn(backend, "store");
      await api.dispatch("before_reset", {});
      expect(storeSpy).not.toHaveBeenCalled();
    });

    it("skips user messages <= 10 chars", async () => {
      const storeSpy = vi.spyOn(backend, "store");
      const messages = [
        { role: "user", content: "short" },
        { role: "user", content: "This is a sufficiently long user message for testing" },
      ];

      await api.dispatch("before_reset", { messages });

      const input = storeSpy.mock.calls[0][0];
      expect(input.content).toContain("sufficiently long");
      expect(input.content).not.toContain("short");
    });

    it("truncates individual messages to 300 chars", async () => {
      const storeSpy = vi.spyOn(backend, "store");
      const longContent = "A".repeat(500);
      const messages = [{ role: "user", content: longContent }];

      await api.dispatch("before_reset", { messages });

      const input = storeSpy.mock.calls[0][0];
      // The summary part (after "[session-summary] ") should have at most 300 chars from this message
      const summaryPart = input.content.replace("[session-summary] ", "");
      expect(summaryPart.length).toBeLessThanOrEqual(300);
    });
  });

  // -------------------------------------------------------------------------
  // agent_end
  // -------------------------------------------------------------------------

  describe("agent_end", () => {
    it("captures substantial assistant content", async () => {
      const storeSpy = vi.spyOn(backend, "store");
      const content = "A".repeat(100);
      const messages = [
        { role: "user", content: "do something" },
        { role: "assistant", content },
      ];

      await api.dispatch("agent_end", { success: true, messages });

      expect(storeSpy).toHaveBeenCalledTimes(1);
      const input = storeSpy.mock.calls[0][0];
      expect(input.content).toMatch(/^\[auto\] /);
      expect(input.key).toMatch(/^agent-end:\d+$/);
      expect(input.tags).toEqual(["auto-capture", "agent-response"]);
    });

    it("skips short responses (< 50 chars)", async () => {
      const storeSpy = vi.spyOn(backend, "store");
      const messages = [
        { role: "user", content: "do something" },
        { role: "assistant", content: "done" },
      ];

      await api.dispatch("agent_end", { success: true, messages });
      expect(storeSpy).not.toHaveBeenCalled();
    });

    it("skips when success is false", async () => {
      const storeSpy = vi.spyOn(backend, "store");
      const messages = [
        { role: "assistant", content: "A".repeat(100) },
      ];

      await api.dispatch("agent_end", { success: false, messages });
      expect(storeSpy).not.toHaveBeenCalled();
    });

    it("skips content containing <relevant-memories>", async () => {
      const storeSpy = vi.spyOn(backend, "store");
      const messages = [
        {
          role: "assistant",
          content:
            "<relevant-memories>some injected context here that is long enough</relevant-memories> and more text to be over 50 chars",
        },
      ];

      await api.dispatch("agent_end", { success: true, messages });
      expect(storeSpy).not.toHaveBeenCalled();
    });

    it("truncates to 2000 chars", async () => {
      const storeSpy = vi.spyOn(backend, "store");
      const longContent = "B".repeat(3000);
      const messages = [
        { role: "assistant", content: longContent },
      ];

      await api.dispatch("agent_end", { success: true, messages });

      const input = storeSpy.mock.calls[0][0];
      // "[auto] " (7) + 2000 chars + "..." (3)
      expect(input.content.length).toBe("[auto] ".length + 2000 + "...".length);
    });

    it("finds last assistant message among multiple", async () => {
      const storeSpy = vi.spyOn(backend, "store");
      const messages = [
        { role: "assistant", content: "First assistant response that is long enough to capture" },
        { role: "user", content: "follow up question" },
        { role: "assistant", content: "Second and final assistant response that is definitely long enough" },
      ];

      await api.dispatch("agent_end", { success: true, messages });

      const input = storeSpy.mock.calls[0][0];
      expect(input.content).toContain("Second and final");
    });

    it("handles array content blocks", async () => {
      const storeSpy = vi.spyOn(backend, "store");
      const textContent = "C".repeat(100);
      const messages = [
        {
          role: "assistant",
          content: [{ type: "text", text: textContent }],
        },
      ];

      await api.dispatch("agent_end", { success: true, messages });

      expect(storeSpy).toHaveBeenCalledTimes(1);
      const input = storeSpy.mock.calls[0][0];
      expect(input.content).toContain(textContent);
    });
  });

  // -------------------------------------------------------------------------
  // Failure-mode matrix
  // -------------------------------------------------------------------------

  describe("failure modes", () => {
    it("before_prompt_build degrades gracefully when backend throws", async () => {
      backend.shouldThrow = true;

      const result = await api.dispatch("before_prompt_build", {
        prompt: "this should not throw",
      });

      // Should not reject — graceful degradation
      expect(result).toBeUndefined();
      expect(logger.errors.some((m) => m.includes("before_prompt_build"))).toBe(true);
    });

    it("before_reset degrades gracefully when store throws", async () => {
      backend.shouldThrow = true;

      const messages = [
        { role: "user", content: "some long enough message for the session" },
      ];

      // Should not reject
      await api.dispatch("before_reset", { messages });

      expect(logger.errors.some((m) => m.includes("before_reset"))).toBe(true);
    });

    it("agent_end degrades gracefully when store throws", async () => {
      backend.shouldThrow = true;

      const messages = [
        { role: "assistant", content: "A".repeat(100) },
      ];

      // Should not reject (silent catch)
      await api.dispatch("agent_end", { success: true, messages });
      // No logger.errors assertion — agent_end has a bare catch
    });

    it("after_compaction always succeeds even with broken backend", async () => {
      backend.shouldThrow = true;

      // after_compaction doesn't call backend, just invalidates in-memory cache
      await api.dispatch("after_compaction", {});
      // No rejection
    });
  });

  // -------------------------------------------------------------------------
  // Cache TTL
  // -------------------------------------------------------------------------

  describe("cache TTL", () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it("cache expires after 3 minutes", async () => {
      backend.searchResults = {
        data: [makeMemory()],
        total: 1,
        limit: 10,
        offset: 0,
      };

      const searchSpy = vi.spyOn(backend, "search");

      // First call — cache miss
      await api.dispatch("before_prompt_build", { prompt: "first prompt" });
      expect(searchSpy).toHaveBeenCalledTimes(1);

      // Second call within TTL — cache hit
      vi.advanceTimersByTime(60_000); // 1 minute
      await api.dispatch("before_prompt_build", { prompt: "still cached" });
      expect(searchSpy).toHaveBeenCalledTimes(1);

      // Third call after TTL — cache expired
      vi.advanceTimersByTime(120_001); // total > 3 minutes
      await api.dispatch("before_prompt_build", { prompt: "expired cache" });
      expect(searchSpy).toHaveBeenCalledTimes(2);
    });
  });
});
