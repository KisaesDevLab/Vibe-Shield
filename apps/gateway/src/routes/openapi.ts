/**
 * Hand-written OpenAPI 3.1 spec. v1.0.1 covers the live route surface
 * including /v1/messages proxy, /v1/sessions/:id/materialize, /metrics.
 * Hand-written keeps the spec readable for peer reviewers; v1.1 may
 * switch to zod-to-openapi when the surface grows.
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

const messagesRequestSchema = {
  type: 'object',
  required: ['model', 'max_tokens', 'messages'],
  additionalProperties: true,
  properties: {
    model: { type: 'string' },
    max_tokens: { type: 'integer', minimum: 1 },
    messages: {
      type: 'array',
      minItems: 1,
      items: {
        type: 'object',
        required: ['role', 'content'],
        properties: {
          role: { type: 'string', enum: ['user', 'assistant'] },
          content: {
            oneOf: [
              { type: 'string' },
              { type: 'array', items: { type: 'object' } },
            ],
          },
        },
      },
    },
    system: {
      oneOf: [
        { type: 'string' },
        {
          type: 'array',
          items: {
            type: 'object',
            properties: { type: { const: 'text' }, text: { type: 'string' } },
            required: ['type', 'text'],
          },
        },
      ],
    },
    temperature: { type: 'number', minimum: 0, maximum: 1 },
    top_p: { type: 'number', minimum: 0, maximum: 1 },
    top_k: { type: 'integer', minimum: 0 },
    stop_sequences: { type: 'array', items: { type: 'string' } },
    stream: { type: 'boolean' },
    tools: { type: 'array', items: {} },
    tool_choice: {},
    metadata: { type: 'object', additionalProperties: true },
    session_id: { type: 'string', format: 'uuid' },
    policy_name: { type: 'string', minLength: 1 },
  },
};

const messagesResponseSchema = {
  type: 'object',
  required: ['id', 'type', 'role', 'model', 'content', 'usage'],
  additionalProperties: true,
  properties: {
    id: { type: 'string' },
    type: { const: 'message' },
    role: { const: 'assistant' },
    model: { type: 'string' },
    content: { type: 'array', items: { type: 'object' } },
    stop_reason: { type: ['string', 'null'] },
    stop_sequence: { type: ['string', 'null'] },
    usage: {
      type: 'object',
      properties: {
        input_tokens: { type: 'integer' },
        output_tokens: { type: 'integer' },
      },
    },
  },
};

const sessionShape = {
  type: 'object',
  required: ['id', 'tenant_id', 'app_id', 'user_id', 'created_at', 'expires_at'],
  properties: {
    id: { type: 'string', format: 'uuid' },
    tenant_id: { type: 'string' },
    app_id: { type: 'string' },
    user_id: { type: 'string' },
    policy_id: { type: ['string', 'null'], format: 'uuid' },
    created_at: { type: 'string', format: 'date-time' },
    expires_at: { type: 'string', format: 'date-time' },
  },
};

const spec = {
  openapi: '3.1.0',
  info: {
    title: 'Vibe Shield Gateway',
    version: '1.1.3',
    description:
      'Anthropic-Messages-compatible gateway. Requires Authorization: Bearer vs_live_… on every protected route. Admin routes under /v1/admin/* use X-Admin-Key instead.',
  },
  components: {
    securitySchemes: {
      bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'vs_live_*' },
      adminKey: { type: 'apiKey', in: 'header', name: 'X-Admin-Key' },
    },
    schemas: {
      AnthropicError: errorSchema,
      MessagesRequest: messagesRequestSchema,
      Message: messagesResponseSchema,
      Session: sessionShape,
      ApiKeyRow: {
        type: 'object',
        required: ['id', 'tenant_id', 'app_id', 'label', 'created_at'],
        properties: {
          id: { type: 'string', description: 'Hex-encoded key hash' },
          tenant_id: { type: 'string' },
          app_id: { type: 'string' },
          label: { type: 'string' },
          created_at: { type: 'string', format: 'date-time' },
          last_used_at: { type: ['string', 'null'], format: 'date-time' },
          revoked_at: { type: ['string', 'null'], format: 'date-time' },
        },
      },
      AuditRow: {
        type: 'object',
        required: ['id', 'tenant_id', 'event_type', 'payload_hash', 'created_at'],
        properties: {
          id: { type: 'string' },
          tenant_id: { type: 'string' },
          session_id: { type: ['string', 'null'] },
          event_type: { type: 'string' },
          payload_hash: { type: 'string', description: 'Hex SHA-256' },
          created_at: { type: 'string', format: 'date-time' },
        },
      },
      RecognizerMissRow: {
        type: 'object',
        required: ['id', 'pattern', 'sample_hash', 'severity', 'created_at'],
        properties: {
          id: { type: 'string' },
          pattern: { type: 'string' },
          sample_hash: { type: 'string', description: 'SHA-256 truncated to 16 hex chars' },
          severity: { type: 'string', enum: ['block', 'warn', 'allow'] },
          created_at: { type: 'string', format: 'date-time' },
        },
      },
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
    '/metrics': {
      get: {
        security: [],
        summary: 'Prometheus exposition (Phase 19)',
        responses: {
          '200': {
            description: 'Prometheus text format',
            content: { 'text/plain': { schema: { type: 'string' } } },
          },
        },
      },
    },
    '/v1/messages': {
      post: {
        summary: 'Anthropic Messages API proxy',
        description:
          'Redacts PII via the engine, calls Anthropic, re-identifies the response per the active policy. ' +
          'Streaming via stream:true returns text/event-stream. ' +
          'Response carries vs-session-id header so the client can reuse the session on subsequent calls.',
        requestBody: {
          required: true,
          content: { 'application/json': { schema: { $ref: '#/components/schemas/MessagesRequest' } } },
        },
        responses: {
          '200': {
            description: 'Anthropic response (re-identified per policy)',
            headers: {
              'vs-session-id': { schema: { type: 'string', format: 'uuid' } },
            },
            content: { 'application/json': { schema: { $ref: '#/components/schemas/Message' } } },
          },
          '400': { description: 'Invalid request', content: { 'application/json': { schema: { $ref: '#/components/schemas/AnthropicError' } } } },
          '401': { description: 'Auth failed' },
          '403': { description: 'Policy / spend cap denied' },
          '429': { description: 'Rate limited' },
          '503': { description: 'Engine or upstream unavailable' },
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
          '201': {
            description: 'Created',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/Session' } } },
          },
          '401': { description: 'Authentication required' },
        },
      },
    },
    '/v1/sessions/{id}': {
      get: {
        summary: 'Fetch a session by id',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
        responses: {
          '200': { description: 'OK', content: { 'application/json': { schema: { $ref: '#/components/schemas/Session' } } } },
          '404': { description: 'Not found (cross-tenant lookups also return 404, never 403)' },
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
    '/v1/sessions/{id}/materialize': {
      post: {
        summary: 'Materialize tokens to cleartext (Converter only — addendum 16.5)',
        description:
          'Resolves every <ENTITY_N> token in the request payload to cleartext via the session vault. ' +
          'Refuses unless the active policy is cpa-converter-output. Output SHA-256 is recorded in vs_audit ' +
          'as a materialize event before the response is returned.',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['payload'],
                properties: {
                  payload: { description: 'Arbitrary JSON; tokens within strings are resolved.' },
                  output_filename: { type: 'string', maxLength: 255 },
                },
              },
            },
          },
        },
        responses: {
          '200': {
            description: 'Materialized',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['materialized', 'output_sha256', 'tokens_resolved'],
                  properties: {
                    materialized: { description: 'Same shape as payload, with tokens replaced.' },
                    output_sha256: { type: 'string', pattern: '^[0-9a-f]{64}$' },
                    tokens_resolved: { type: 'integer' },
                  },
                },
              },
            },
          },
          '403': { description: 'Active policy is not cpa-converter-output' },
          '404': { description: 'Session not found (or owned by another tenant)' },
        },
      },
    },

    // v1.1.3 §review (C5-C10): document the /v1/admin/* surface added
    // in §3.3. Auth is X-Admin-Key (separate from tenant Bearer keys);
    // admin is the appliance operator with full read access.
    '/v1/admin/api-keys': {
      get: {
        summary: 'List all issued tenant API keys',
        security: [{ adminKey: [] }],
        responses: {
          '200': {
            description: 'OK',
            content: {
              'application/json': {
                schema: {
                  type: 'array',
                  items: { $ref: '#/components/schemas/ApiKeyRow' },
                },
              },
            },
          },
          '401': { description: 'X-Admin-Key missing or invalid' },
        },
      },
      post: {
        summary: 'Issue a new tenant API key. Cleartext returned ONCE, never re-fetchable.',
        security: [{ adminKey: [] }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['tenantId', 'label'],
                properties: {
                  tenantId: { type: 'string' },
                  appId: { type: 'string', default: 'default' },
                  label: { type: 'string' },
                },
              },
            },
          },
        },
        responses: {
          '201': {
            description: 'Created',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['id', 'key'],
                  properties: {
                    id: { type: 'string', description: 'Hex-encoded key hash' },
                    key: { type: 'string', description: 'Cleartext API key (shown once)' },
                  },
                },
              },
            },
          },
          '400': { description: 'Invalid body' },
          '401': { description: 'X-Admin-Key missing or invalid' },
        },
      },
    },
    '/v1/admin/api-keys/{id}': {
      delete: {
        summary: 'Revoke an API key by its hex hash. Idempotent.',
        security: [{ adminKey: [] }],
        parameters: [
          { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
        ],
        responses: {
          '204': { description: 'Revoked' },
          '401': { description: 'X-Admin-Key missing or invalid' },
          '404': { description: 'No matching key' },
        },
      },
    },
    '/v1/admin/audit': {
      get: {
        summary: 'List recent audit events. Returns hex payload hashes only; cleartext never persisted.',
        security: [{ adminKey: [] }],
        parameters: [
          { name: 'tenant_id', in: 'query', schema: { type: 'string' } },
          { name: 'limit', in: 'query', schema: { type: 'integer', maximum: 500, default: 100 } },
        ],
        responses: {
          '200': {
            description: 'OK',
            content: {
              'application/json': {
                schema: {
                  type: 'array',
                  items: { $ref: '#/components/schemas/AuditRow' },
                },
              },
            },
          },
          '401': { description: 'X-Admin-Key missing or invalid' },
        },
      },
    },
    '/v1/admin/recognizer-misses': {
      get: {
        summary: 'List recent backstop catches that Presidio missed. Sample hashes only.',
        security: [{ adminKey: [] }],
        parameters: [
          { name: 'limit', in: 'query', schema: { type: 'integer', maximum: 500, default: 100 } },
        ],
        responses: {
          '200': {
            description: 'OK',
            content: {
              'application/json': {
                schema: {
                  type: 'array',
                  items: { $ref: '#/components/schemas/RecognizerMissRow' },
                },
              },
            },
          },
          '401': { description: 'X-Admin-Key missing or invalid' },
        },
      },
    },
    '/v1/admin/anthropic/probe': {
      post: {
        summary: 'Re-run the Anthropic commercial-key probe. Use after key rotation.',
        security: [{ adminKey: [] }],
        responses: {
          '200': {
            description: 'OK',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['ok'],
                  properties: {
                    ok: { type: 'boolean' },
                    reason: { type: 'string', description: 'consumer_key | unreachable | unknown — only when ok=false' },
                  },
                },
              },
            },
          },
          '401': { description: 'X-Admin-Key missing or invalid' },
        },
      },
    },
    '/v1/admin/policies': {
      get: {
        summary: 'Read-only list of redaction / re-id policies. JSON editor deferred to v1.2.',
        security: [{ adminKey: [] }],
        responses: {
          '200': {
            description: 'OK',
            content: {
              'application/json': {
                schema: {
                  type: 'array',
                  items: {
                    type: 'object',
                    required: ['id', 'name', 'version', 'zdr_required'],
                    properties: {
                      id: { type: 'string' },
                      name: { type: 'string' },
                      version: { type: 'integer' },
                      zdr_required: { type: 'boolean' },
                    },
                  },
                },
              },
            },
          },
          '401': { description: 'X-Admin-Key missing or invalid' },
        },
      },
    },
  },
};

const specSchema = z
  .object({ openapi: z.string(), info: z.object({ title: z.string() }) })
  .passthrough();
specSchema.parse(spec);

export function openapiRouter(): Router {
  const router: Router = Router();
  router.get('/openapi.json', (_req, res) => {
    res.json(spec);
  });
  return router;
}
