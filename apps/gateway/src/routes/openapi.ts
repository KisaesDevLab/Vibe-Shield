/**
 * Hand-written OpenAPI 3.1 spec. Phase 7's surface is small enough to
 * maintain by hand; Phase 8 onwards will probably switch to a
 * zod-to-openapi generator as the proxy paths grow.
 */

import { Router } from 'express';
import { z } from 'zod';

const errorSchema = {
  type: 'object',
  required: ['type', 'error'],
  properties: {
    type: { type: 'string', enum: ['error'] },
    error: {
      type: 'object',
      required: ['type', 'message'],
      properties: {
        type: {
          type: 'string',
          enum: [
            'invalid_request_error',
            'authentication_error',
            'permission_error',
            'not_found_error',
            'rate_limit_error',
            'api_error',
            'overloaded_error',
          ],
        },
        message: { type: 'string' },
      },
    },
    correlation_id: { type: ['string', 'null'] },
  },
};

const spec = {
  openapi: '3.1.0',
  info: {
    title: 'Vibe Shield Gateway',
    version: '0.0.0',
    description:
      'Anthropic-Messages-compatible gateway. Requires Authorization: Bearer vs_live_… on every protected route.',
  },
  components: {
    securitySchemes: {
      bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'vs_live_*' },
    },
    schemas: {
      AnthropicError: errorSchema,
    },
  },
  security: [{ bearerAuth: [] }],
  paths: {
    '/health': {
      get: {
        security: [],
        summary: 'Liveness',
        responses: {
          '200': {
            description: 'Service is up',
            content: {
              'application/json': {
                schema: { type: 'object', properties: { status: { type: 'string' } } },
              },
            },
          },
        },
      },
    },
    '/ready': {
      get: {
        security: [],
        summary: 'Readiness — DB connectivity',
        responses: {
          '200': { description: 'Ready' },
          '500': {
            description: 'Not ready',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/AnthropicError' } } },
          },
        },
      },
    },
    '/v1/messages': {
      post: {
        summary: 'Anthropic Messages API (Phase 8 proxy)',
        responses: {
          '501': {
            description: 'Not yet implemented in Phase 7',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/AnthropicError' } } },
          },
        },
      },
    },
    '/v1/sessions': {
      post: {
        summary: 'Create a token-vault session',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['user_id'],
                properties: {
                  user_id: { type: 'string' },
                  policy_id: { type: 'string', format: 'uuid' },
                  ttl_minutes: { type: 'integer', minimum: 1, maximum: 1440 },
                },
              },
            },
          },
        },
        responses: {
          '201': { description: 'Created' },
          '401': { description: 'Authentication required' },
        },
      },
    },
    '/v1/sessions/{id}': {
      get: {
        summary: 'Fetch a session by id',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
        responses: {
          '200': { description: 'OK' },
          '404': { description: 'Not found' },
        },
      },
      delete: {
        summary: 'Purge a session (cascades vs_tokens, vs_token_index)',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
        responses: {
          '204': { description: 'Deleted' },
          '404': { description: 'Not found' },
        },
      },
    },
  },
};

// Lightweight tightening: assert the spec parses as an object before serving.
const specSchema = z.object({ openapi: z.string(), info: z.object({ title: z.string() }) }).passthrough();
specSchema.parse(spec);

export function openapiRouter(): Router {
  const router: Router = Router();
  router.get('/openapi.json', (_req, res) => {
    res.json(spec);
  });
  return router;
}
