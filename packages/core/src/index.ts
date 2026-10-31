export type {
  Audience,
  CaseEventRow,
  CaseRow,
  MockCustomer,
  OwnershipState,
} from "./types.js";
export { CoreError } from "./types.js";

export { checkDb, createDb, withTransaction } from "./db.js";
export type { Db, DbClient } from "./db.js";

export { getMockCustomer } from "./customers.js";

export {
  appendCustomerMessage,
  createCase,
  createCaseAndAppendMessage,
  getCaseForCustomer,
  listCaseEvents,
} from "./cases.js";
export type { AppendCustomerMessageResult } from "./cases.js";

export {
  appendEventWithEpoch,
  claimCase,
  releaseCase,
} from "./leases.js";
export type { ClaimResult } from "./leases.js";

export {
  advanceVirtualClock,
  getVirtualNow,
  scheduleExternalWait,
  setVirtualClock,
  wakeDueCases,
} from "./clock.js";

export {
  DESK_AGENTS,
  appendHumanMessage,
  applyDeskCommand,
  buildPromotionHint,
  getCaseById,
  getCaseForDesk,
  getDeskAgent,
  handBackCase,
  listCaseEventsAfter,
  listDeskQueue,
  listPendingApprovals,
  requestHumanTransfer,
  requestReplyApproval,
  requestWriteApproval,
  takeoverCase,
  transferCaseToHumanWithEpoch,
} from "./desk.js";
export type {
  ApplyDeskCommandInput,
  ApplyDeskCommandResult,
  DeskActor,
  DeskAgent,
  DeskCommandType,
  DeskQueueItem,
  PendingApproval,
  TransferResult,
} from "./desk.js";

export {
  emitCaseEventNotice,
  notifyCaseEvent,
  onCaseEvent,
  startCaseEventListenBridge,
} from "./notify.js";
export type { CaseEventNotice } from "./notify.js";

export {
  getCaseTicket,
  inferHandoffCategory,
  raiseHandoffTicket,
} from "./tickets.js";
export type { HandoffTicket, HandoffTicketCategory } from "./tickets.js";

export {
  DEFAULT_WORKFLOW_NAME,
  KNOWN_WORKFLOWS,
  PROMOTION_CLEAN_RUNS,
  ensureDefaultWorkflow,
  ensureKnownWorkflows,
  ensureWorkflow,
  forcePromoteWorkflow,
  getWorkflowStatus,
  listWorkflowStatuses,
  recordWorkflowRun,
  setWorkflowLevel,
} from "./workflows.js";
export type {
  WorkflowLevel,
  WorkflowRow,
  WorkflowRunOutcome,
  WorkflowStatus,
} from "./workflows.js";
