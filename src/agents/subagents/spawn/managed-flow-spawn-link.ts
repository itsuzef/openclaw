import { getTaskFlowByIdForOwner } from "../../../tasks/task-flow-owner-access.js";
import type { SpawnSubagentParams } from "./subagent-spawn-contract.js";

export function validateManagedFlowSpawnLink(params: {
  flow: NonNullable<SpawnSubagentParams["flow"]>;
  ownerKey: string;
}): string | undefined {
  const flow = getTaskFlowByIdForOwner({
    flowId: params.flow.flowId,
    callerOwnerKey: params.ownerKey,
  });
  if (!flow) {
    return "Managed TaskFlow not found.";
  }
  if (flow.syncMode !== "managed") {
    return "TaskFlow does not accept managed child tasks.";
  }
  if (flow.controllerId !== params.flow.controllerId) {
    return "Managed TaskFlow controller mismatch.";
  }
  if (flow.revision !== params.flow.expectedRevision) {
    return "Managed TaskFlow revision conflict.";
  }
  if (flow.cancelRequestedAt != null) {
    return "Flow cancellation has already been requested.";
  }
  if (["succeeded", "failed", "cancelled", "lost"].includes(flow.status)) {
    return `Flow is already ${flow.status}.`;
  }
  return undefined;
}
