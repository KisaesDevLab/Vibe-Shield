/**
 * API key auth.
 *
 * Expects ``Authorization: Bearer vs_live_<24 chars>``. On success,
 * attaches ``{ tenantId, appId, keyName }`` to ``req.auth`` for
 * downstream handlers. Failures throw the appropriate ``HttpError``
 * which the global handler converts to the Anthropic-shaped envelope.
 */

import type { NextFunction, Request, Response } from 'express';
import {
  ApiKeyInvalidError,
  ApiKeyRevokedError,
  type ApiKeyStore,
} from '@kisaesdevlab/vibe-shield-schema';
import { AuthenticationError, PermissionError } from '../errors.js';

export interface AuthContext {
  tenantId: string;
  appId: string;
  keyName: string;
}

// ``req.auth`` augmentation lives in ../types/express.d.ts so it picks
// up the global ``Express.Request`` namespace without per-file imports.

const BEARER = /^Bearer\s+(\S+)$/;

export function apiKeyMiddleware(store: ApiKeyStore) {
  return async (req: Request, _res: Response, next: NextFunction): Promise<void> => {
    const header = req.header('authorization');
    if (header === undefined) {
      next(new AuthenticationError('missing Authorization header'));
      return;
    }
    const m = BEARER.exec(header);
    if (m === null || m[1] === undefined) {
      next(new AuthenticationError('Authorization must be a Bearer token'));
      return;
    }
    try {
      const resolved = await store.resolve(m[1]);
      req.auth = {
        tenantId: resolved.tenantId,
        appId: resolved.appId,
        keyName: resolved.name,
      };
      next();
    } catch (err) {
      if (err instanceof ApiKeyRevokedError) {
        next(new PermissionError('API key revoked'));
        return;
      }
      if (err instanceof ApiKeyInvalidError) {
        next(new AuthenticationError('invalid API key'));
        return;
      }
      next(err);
    }
  };
}
