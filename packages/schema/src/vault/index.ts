export {
  SessionExpiredError,
  SessionManager,
  SessionNotFoundError,
} from './session-manager.js';
export type { CreateSessionInput, SessionRecord } from './session-manager.js';

export {
  SessionUnavailableError,
  TokenVault,
} from './token-vault.js';
export type { AllocateResult, TenantKeyResolver } from './token-vault.js';

export { tokenDedupeHash, HASH_LENGTH } from './hash.js';

export {
  ApiKeyInvalidError,
  ApiKeyRevokedError,
  ApiKeyStore,
  KEY_BODY_LENGTH,
  KEY_PREFIX,
  generateApiKey,
  isPlausibleKey,
} from './api-key-store.js';
export type {
  AdminApiKeyView,
  CreateApiKeyInput,
  IssuedKey,
  ResolvedKey,
} from './api-key-store.js';

export { AuditLogger } from './audit-logger.js';
export type {
  AdminAuditView,
  AuditEntry,
  AuditEventType,
} from './audit-logger.js';

export { RecognizerMissStore } from './recognizer-miss-store.js';
export type {
  AdminMissView,
  RecognizerMissInput,
} from './recognizer-miss-store.js';

export {
  ApplianceSecretStore,
  ApplianceSettingsMissingError,
  fingerprintOf,
} from './appliance-secret-store.js';
export type {
  AnthropicKeyRecord,
  AnthropicKeyStatus,
} from './appliance-secret-store.js';

export {
  UserExistsError,
  UserNotFoundError,
  UserStore,
  roleSatisfies,
} from './user-store.js';
export type {
  CreateUserInput,
  Module,
  Role,
  UserRecord,
  UserWithRoles,
} from './user-store.js';

export {
  MagicLinkExpiredError,
  MagicLinkInvalidError,
  MagicLinkStore,
  generateToken as generateMagicLinkToken,
  hashToken as hashMagicLinkToken,
} from './magic-link-store.js';
export type { IssueResult as MagicLinkIssueResult } from './magic-link-store.js';

export {
  SessionInvalidError,
  UserSessionStore,
  generateSessionToken,
  hashSessionToken,
} from './user-session-store.js';
export type {
  IssuedSession,
  ResolvedSession,
} from './user-session-store.js';

export {
  RedactJobNotFoundError,
  RedactJobStore,
} from './redact-job-store.js';
export type {
  CreateRedactJobInput,
  RedactJobRecord,
  RedactJobStatus,
} from './redact-job-store.js';

export { RedactBatchStore } from './redact-batch-store.js';
export type {
  CreateRedactBatchInput,
  RedactBatchRecord,
} from './redact-batch-store.js';

export {
  ScanJobNotFoundError,
  ScanJobStore,
} from './scan-job-store.js';
export type {
  AddScanFileInput,
  AddScanFindingInput,
  CreateScanJobInput,
  ScanFileRecord,
  ScanFindingRecord,
  ScanJobRecord,
  ScanJobStatus,
  ScanRedactLinkRecord,
  ScanSeverity,
} from './scan-job-store.js';

export {
  ScheduledScanNotFoundError,
  ScheduledScanStore,
} from './scheduled-scan-store.js';
export type {
  CreateScheduledScanInput,
  ScheduledScanRecord,
  UpdateScheduledScanInput,
} from './scheduled-scan-store.js';
