# @kisaesdevlab/vibe-shield-client

Drop-in replacement for `@anthropic-ai/sdk` that routes every Messages API call through the Vibe Shield gateway. Vibe apps swap one import line and gain compliant PII redaction.

## Migration in 3 steps

```diff
- import Anthropic from "@anthropic-ai/sdk";
+ import VibeShield from "@kisaesdevlab/vibe-shield-client";

- const anthropic = new Anthropic({
-   apiKey: process.env.ANTHROPIC_API_KEY,
- });
+ const vs = new VibeShield({
+   baseURL: process.env.VIBE_SHIELD_URL,        // http://vibe-shield-gateway:8080
+   apiKey: process.env.VIBE_SHIELD_KEY,         // vs_live_...
+ });

- const reply = await anthropic.messages.create({
+ const reply = await vs.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 1024,
    messages: [{ role: "user", content: "..." }],
  });
```

The request shape and response shape are identical — your existing categorization, prompt-building, and response-parsing code keeps working.

## What the gateway does on your behalf

For every `messages.create` call:

1. Validates your `vs_live_…` API key, resolves your tenant.
2. Sends every cleartext field (user/assistant content, system prompt, `tool_use.input`, `tool_result.content`) through the redaction engine and replaces PII with `<ENTITY_N>` tokens.
3. Persists those tokens in the per-session vault (encrypted at rest under your tenant's DEK).
4. Calls Anthropic with the redacted payload.
5. Re-identifies tokens in the response per your tenant's policy.
6. Audits the call (hashes of payloads only — never cleartext).
7. Records the spend.

Hard rule #2: **direct `@anthropic-ai/sdk` imports are forbidden in every Vibe app except the gateway itself**. CI enforces.

## Streaming

```ts
const stream = vs.messages.create({
  model: "claude-sonnet-4-6",
  max_tokens: 1024,
  messages: [...],
  stream: true,
});
for await (const event of stream) {
  if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
    process.stdout.write(event.delta.text);
  }
}
```

The gateway buffers across SSE chunks so a redaction token straddling two `text_delta` events is re-identified atomically — never emitted half-resolved.

## Telemetry

Pass `onTelemetry` to receive per-call diagnostics (no PII):

```ts
const vs = new VibeShield({
  baseURL: ...,
  apiKey: ...,
  onTelemetry: (event) => {
    console.log(event.sessionId, event.status, event.latencyMs);
  },
});
```

## Errors

- `VibeShieldError` — gateway returned a non-2xx with a parsed error envelope. Has `status` and `type` (Anthropic-shaped: `invalid_request_error`, `authentication_error`, `permission_error`, `rate_limit_error`, `api_error`, etc.).
- `VibeShieldUnavailableError` — couldn't reach the gateway. The Vibe app should treat this as "AI temporarily unavailable" rather than fall back to a direct Anthropic call (hard rule #4).
