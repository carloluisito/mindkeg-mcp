/**
 * Services barrel export.
 * Exposes LearningService and EmbeddingService.
 * Available via the "mindkeg-mcp/services" subpath export.
 */
export { LearningService } from './learning-service.js';
export type {
  StoreLearningInput,
  SearchLearningsInput,
  UpdateLearningInput,
  DeprecateLearningInput,
  DeleteLearningInput,
  FlagStaleLearningInput,
  DeleteResult,
} from './learning-service.js';

export {
  FastEmbedEmbeddingService,
  OpenAIEmbeddingService,
  NoneEmbeddingService,
  createEmbeddingService,
} from './embedding-service.js';
export type { EmbeddingService } from './embedding-service.js';

export { EntityService } from './entity-service.js';
export type {
  StoreDecisionInput,
  StoreFindingInput,
  StoreGotchaInput,
  CompleteRunInputRaw,
  StoreGotchaResult,
  ContextBudget,
  RelevantContextResult,
} from './entity-service.js';
