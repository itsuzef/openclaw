import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SubagentRunRecord } from "../registry/subagent-registry.types.js";
import type { SubagentAnnounceDeliveryResult } from "./subagent-announce-dispatch.js";

const deliverSpy = vi.fn(async (_params: Record<string, unknown>) => ({
  delivered: true,
  path: "direct",
}));
const completeBatchSpy = vi.fn();
let sessionStore: Record<string, { sessionId?: string }>;
let runs: SubagentRunRecord[];

const { registryRuntimeMock } = vi.hoisted(() => ({
  registryRuntimeMock: {
    countPendingDescendantRuns: vi.fn(() => 0),
    hasDescendantRunAwaitingSettle: vi.fn(() => false),
    isSubagentSessionRunActive: vi.fn(() => true),
    getLatestSubagentRunByChildSessionKey: vi.fn(() => undefined),
    listSubagentRunsForRequester: vi.fn((): unknown[] => []),
    resolveRequesterForChildSession: vi.fn(() => null),
    shouldIgnorePostCompletionAnnounceForSession: vi.fn(() => false),
  },
}));

vi.mock("../registry/subagent-registry-read.js", () => registryRuntimeMock);
vi.mock("./subagent-announce.runtime.js", () => ({
  callGateway: vi.fn(async () => ({})),
  dispatchGatewayMethodInProcess: vi.fn(async () => ({})),
  isEmbeddedAgentRunActive: vi.fn(() => false),
  getRuntimeConfig: () => ({ session: { mainKey: "main", scope: "per-sender" } }),
  loadSessionStore: vi.fn(() => ({})),
  readSessionMessagesAsync: vi.fn(async () => []),
  readSubagentSessionEntry: vi.fn(() => undefined),
  resolveAgentIdFromSessionKey: vi.fn(() => "main"),
  resolveMainSessionKey: vi.fn(() => "agent:main:main"),
  resolveSessionStorePathCore: vi.fn(() => "/tmp/sessions.json"),
  waitForEmbeddedAgentRunEnd: vi.fn(async () => true),
}));
vi.mock("./subagent-announce-delivery.js", () => ({
  deliverSubagentAnnouncement: (params: Record<string, unknown>) => deliverSpy(params),
  loadRequesterSessionEntry: (sessionKey: string) => ({
    entry: sessionStore[sessionKey],
    canonicalKey: sessionKey,
  }),
  loadSessionEntryByKey: (sessionKey: string) => sessionStore[sessionKey],
  runAnnounceDeliveryWithRetry: async <T>(params: { run: () => Promise<T> }) => await params.run(),
  resolveSubagentAnnounceTimeoutMs: () => 10_000,
  resolveSubagentCompletionOrigin: async (params: { requesterOrigin?: unknown }) =>
    params.requesterOrigin,
}));
vi.mock("../spawn/subagent-depth.js", () => ({
  getSubagentDepthFromSessionStore: (sessionKey: string) =>
    sessionKey.split(":subagent:").length - 1,
}));

import { maybeWakeRequesterAfterAllChildrenSettled } from "./subagent-announce.requester-settle-wake.js";

const requesterSessionKey = "agent:main:subagent:orchestrator";

function makeChild(
  runId: string,
  batchRunIds: string[],
  rearmGeneration: number,
): SubagentRunRecord {
  return {
    runId,
    childSessionKey: `agent:main:subagent:${runId}`,
    requesterSessionKey,
    requesterDisplayKey: "main",
    task: "investigate",
    cleanup: "keep",
    createdAt: 1_000,
    execution: { status: "terminal", startedAt: 2_000, endedAt: 3_000 },
    expectsCompletionMessage: true,
    completion: { required: true, resultText: `${runId} complete` },
    delivery: { status: "delivered" },
    requesterSettleWake: {
      status: "pending",
      attemptCount: 0,
      batchRunIds,
      requesterYieldBatch: true,
      rearmGeneration,
    },
  };
}

describe("yielded nested requester settle wake", () => {
  beforeEach(() => {
    deliverSpy.mockClear();
    completeBatchSpy.mockClear();
    sessionStore = { [requesterSessionKey]: { sessionId: "sess-orchestrator" } };
    runs = [];
    registryRuntimeMock.listSubagentRunsForRequester.mockImplementation(() => runs);
  });

  it("rearms once per complete relay and four-worker batch", async () => {
    const batches = [
      ["run-relay"],
      ["run-worker-a", "run-worker-b", "run-worker-c", "run-worker-d"],
    ];
    for (const [index, batchRunIds] of batches.entries()) {
      runs = batchRunIds.map((runId) => makeChild(runId, batchRunIds, index + 1));
      if (runs.length > 1) {
        for (const worker of runs.slice(1)) {
          worker.execution = { status: "running", startedAt: 2_000 };
        }
        await expect(
          maybeWakeRequesterAfterAllChildrenSettled({
            requesterSessionKey,
            settledEntry: runs[0]!,
            transitionBatch: vi.fn(),
            completeBatch: completeBatchSpy,
          }),
        ).resolves.toBe(false);
        expect(deliverSpy).toHaveBeenCalledTimes(index);
        expect(completeBatchSpy).toHaveBeenCalledTimes(index);
        for (const worker of runs.slice(1)) {
          worker.execution = { status: "terminal", startedAt: 2_000, endedAt: 3_000 };
        }
      }
      await expect(
        maybeWakeRequesterAfterAllChildrenSettled({
          requesterSessionKey,
          settledEntry: runs.at(-1)!,
          transitionBatch: vi.fn(),
          completeBatch: completeBatchSpy,
        }),
      ).resolves.toBe(true);
    }

    expect(deliverSpy).toHaveBeenCalledTimes(2);
    expect(deliverSpy.mock.calls.map(([call]) => call)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          targetRequesterSessionKey: requesterSessionKey,
          requireDirectDelivery: true,
          requireVisibleReply: true,
          directIdempotencyKey: expect.stringContaining(":yield-1"),
        }),
        expect.objectContaining({ directIdempotencyKey: expect.stringContaining(":yield-2") }),
      ]),
    );
    expect(completeBatchSpy).toHaveBeenNthCalledWith(1, batches[0], 1, {
      delivered: true,
      path: "direct",
    } satisfies SubagentAnnounceDeliveryResult);
    expect(completeBatchSpy).toHaveBeenNthCalledWith(2, batches[1], 2, {
      delivered: true,
      path: "direct",
    } satisfies SubagentAnnounceDeliveryResult);
  });
});
