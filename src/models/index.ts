/**
 * Models barrel export.
 * Exposes all public types and schemas from the models layer.
 * Available via the "mindkeg-mcp/models" subpath export.
 */
export type {
  Learning,
  LearningWithScore,
  LearningCategory,
  LearningStatus,
  CreateLearningInput,
  UpdateLearningInput,
  DeprecateLearningInput,
  DeleteLearningInput,
  SearchLearningsInput,
  FlagStaleLearningInput,
} from './learning.js';

export {
  LEARNING_CATEGORIES,
  LEARNING_STATUSES,
  CreateLearningInputSchema,
  UpdateLearningInputSchema,
  DeprecateLearningInputSchema,
  DeleteLearningInputSchema,
  SearchLearningsInputSchema,
  FlagStaleLearningInputSchema,
} from './learning.js';

export type { Repository } from './repository.js';

// Agent Memory Upgrade (AMU) entities
export type { Decision, DecisionStatus, CreateDecisionInput, CreateDecisionRecord, UpdateDecisionRecord } from './decision.js';
export { DECISION_STATUSES, CreateDecisionInputSchema } from './decision.js';

export type { Finding, FindingSeverity, FindingStatus, CreateFindingInput, CreateFindingRecord, UpdateFindingRecord } from './finding.js';
export { FINDING_SEVERITIES, FINDING_STATUSES, CreateFindingInputSchema } from './finding.js';

export type { Gotcha, CreateGotchaInput, CreateGotchaRecord, UpdateGotchaRecord } from './gotcha.js';
export { CreateGotchaInputSchema } from './gotcha.js';

export type { RunSummary, RunOutcome, CompleteRunInput, CreateRunSummaryRecord } from './run-summary.js';
export { RUN_OUTCOMES, CompleteRunInputSchema } from './run-summary.js';
