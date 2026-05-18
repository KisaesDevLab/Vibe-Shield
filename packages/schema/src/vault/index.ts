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
