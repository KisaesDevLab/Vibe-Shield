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
  CreateApiKeyInput,
  IssuedKey,
  ResolvedKey,
} from './api-key-store.js';
