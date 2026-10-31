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
  getCaseById,
  getCaseForDesk,
  getDeskAgent,
  handBackCase,
  listCaseEventsAfter,
  listDeskQueue,
  requestHumanTransfer,
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
  TransferResult,
} from "./desk.js";

export { notifyCaseEvent, onCaseEvent } from "./notify.js";
export type { CaseEventNotice } from "./notify.js";

export {
  getCaseTicket,
  inferHandoffCategory,
  raiseHandoffTicket,
} from "./tickets.js";
export type { HandoffTicket, HandoffTicketCategory } from "./tickets.js";
