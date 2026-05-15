/**
 * Anthropic Messages API request shape (subset used by Vibe apps).
 *
 * Source: https://docs.anthropic.com/en/api/messages
 *
 * We model what Vibe apps actually send; exotic fields the apps don't
 * use are validated with .passthrough() so we proxy them unchanged to
 * Anthropic in Phase 8. This keeps the schema's job narrow: reject
 * obviously malformed requests, leave forward-compatible fields alone.
 */

import { z } from 'zod';

export const textContentBlock = z.object({
  type: z.literal('text'),
  text: z.string(),
});

export const imageContentBlock = z.object({
  type: z.literal('image'),
  source: z.object({
    type: z.enum(['base64', 'url']),
    media_type: z.string().optional(),
    data: z.string().optional(),
    url: z.string().optional(),
  }).passthrough(),
});

export const toolUseContentBlock = z.object({
  type: z.literal('tool_use'),
  id: z.string(),
  name: z.string(),
  input: z.unknown(),
});

export const toolResultContentBlock = z.object({
  type: z.literal('tool_result'),
  tool_use_id: z.string(),
  content: z.union([z.string(), z.array(z.unknown())]).optional(),
  is_error: z.boolean().optional(),
}).passthrough();

export const contentBlock = z.union([
  textContentBlock,
  imageContentBlock,
  toolUseContentBlock,
  toolResultContentBlock,
]);

export const messageContent = z.union([z.string(), z.array(contentBlock)]);

export const message = z.object({
  role: z.enum(['user', 'assistant']),
  content: messageContent,
});

export const messagesRequest = z
  .object({
    model: z.string().min(1),
    max_tokens: z.number().int().positive(),
    messages: z.array(message).min(1),
    system: z.union([z.string(), z.array(textContentBlock)]).optional(),
    temperature: z.number().min(0).max(1).optional(),
    top_p: z.number().min(0).max(1).optional(),
    top_k: z.number().int().nonnegative().optional(),
    stop_sequences: z.array(z.string()).optional(),
    stream: z.boolean().optional(),
    metadata: z
      .object({ user_id: z.string().optional() })
      .passthrough()
      .optional(),
    tools: z.array(z.unknown()).optional(),
    tool_choice: z.unknown().optional(),
    /** Vibe-Shield extension: identifies which token-vault session this
     *  request belongs to. Optional today; Phase 8 wires it. */
    session_id: z.string().uuid().optional(),
    /** Vibe-Shield extension: requested policy name. Falls back to the
     *  app's built-in if not supplied (Phase 10). */
    policy_name: z.string().min(1).optional(),
  })
  .passthrough();

export type MessagesRequest = z.infer<typeof messagesRequest>;
