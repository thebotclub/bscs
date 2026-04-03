/**
 * Core LLM Gateway — Portkey-inspired proxy for routing, retries, fallbacks,
 * load balancing, and cost logging across LLM providers.
 *
 * Agents hit localhost gateway instead of providers directly. The gateway:
 * 1. Resolves the target provider from config (model → provider mapping)
 * 2. Applies retry with exponential backoff on transient errors
 * 3. Falls back through the configured fallback chain on failure
 * 4. Logs every request for cost tracking
 */
import { createServer, type IncomingMessage } from 'http';
import { createLogger } from '../util/logger.js';
import { loadConfig } from './config.js';
import { recordCostEntry } from './cost.js';
import type { ProviderType } from '../util/types.js';

const logger = createLogger('gateway');

// ── Provider URL mapping ─────────────────────────────────────────────

const PROVIDER_ENDPOINTS: Record<ProviderType, string> = {
  anthropic: 'https://api.anthropic.com',
  openai: 'https://api.openai.com/v1',
  google: 'https://generativelanguage.googleapis.com/v1beta',
  ollama: 'http://localhost:11434',
  llamacpp: 'http://localhost:8080',
  litellm: 'http://localhost:4000',
};

// ── Model → Provider resolution ──────────────────────────────────────

interface ResolvedProvider {
  name: string;
  type: ProviderType;
  apiKey?: string;
  baseUrl: string;
}

const MODEL_PROVIDER_MAP: Record<string, ProviderType> = {
  'claude-': 'anthropic',
  'gpt-': 'openai',
  'o1-': 'openai',
  'o3-': 'openai',
  'gemini-': 'google',
};

function inferProviderFromModel(model: string): ProviderType | null {
  for (const [prefix, provider] of Object.entries(MODEL_PROVIDER_MAP)) {
    if (model.startsWith(prefix)) return provider;
  }
  return null; // no prefix match
}

function resolveProvider(model: string): ResolvedProvider | null {
  const config = loadConfig();
  const providers = config.models?.providers ?? {};

  // Try full model name first (handles models with internal slashes like "Qwen/Qwen2.5-72B")
  // Then try with first path component stripped (e.g. "minimax/MiniMax-M2.7" → "MiniMax-M2.7")
  const candidates = [model];
  if (model.includes('/')) {
    candidates.push(model.substring(model.indexOf('/') + 1));
  }

  for (const candidate of candidates) {
    // First: exact match against configured provider model lists
    for (const [name, provider] of Object.entries(providers)) {
      if (!provider.enabled) continue;
      const models = provider.models ?? [];
      if (models.includes(candidate)) {
        return {
          name,
          type: provider.type,
          apiKey: provider.apiKey,
          baseUrl: provider.baseUrl ?? PROVIDER_ENDPOINTS[provider.type],
        };
      }
    }

    // Fallback: prefix-based inference
    const inferredType = inferProviderFromModel(candidate);
    if (inferredType) {
      for (const [name, provider] of Object.entries(providers)) {
        if (provider.type === inferredType && provider.enabled) {
          return {
            name,
            type: provider.type,
            apiKey: provider.apiKey,
            baseUrl: provider.baseUrl ?? PROVIDER_ENDPOINTS[provider.type],
          };
        }
      }
    }
  }

  // No configured provider — use defaults (only if we can infer a type)
  const inferredType = inferProviderFromModel(model);
  if (!inferredType) return null;
  return {
    name: inferredType,
    type: inferredType,
    baseUrl: PROVIDER_ENDPOINTS[inferredType],
  };
}

// ── Model pricing (per 1M tokens) ───────────────────────────────────

const MODEL_PRICING: Record<string, { input: number; output: number }> = {
  'claude-opus-4': { input: 15.0, output: 75.0 },
  'claude-sonnet-4': { input: 3.0, output: 15.0 },
  'claude-sonnet-4-5': { input: 3.0, output: 15.0 },
  'claude-haiku-3.5': { input: 0.8, output: 4.0 },
  'gpt-4o': { input: 2.5, output: 10.0 },
  'gpt-4o-mini': { input: 0.15, output: 0.6 },
  'o1': { input: 15.0, output: 60.0 },
  'o3-mini': { input: 1.1, output: 4.4 },
  'gemini-2.0-flash': { input: 0.1, output: 0.4 },
  'gemini-2.5-pro': { input: 1.25, output: 10.0 },
};

function estimateCost(model: string, inputTokens: number, outputTokens: number): number {
  // Strip any provider prefix (e.g. "anthropic/claude-opus-4-6" → "claude-opus-4-6")
  const strippedModel = model.includes('/') ? model.substring(model.indexOf('/') + 1) : model;
  const pricing = MODEL_PRICING[strippedModel];
  if (!pricing) return 0;
  return (inputTokens / 1_000_000) * pricing.input + (outputTokens / 1_000_000) * pricing.output;
}

// ── Retry with exponential backoff ───────────────────────────────────

const RETRYABLE_STATUS_CODES = new Set([408, 429, 500, 502, 503, 504]);
const MAX_RETRIES = 3;
const BASE_DELAY_MS = 1000;

async function fetchWithRetry(
  url: string,
  options: RequestInit,
  retries: number = MAX_RETRIES,
): Promise<Response> {
  let lastError: Error | undefined;
  let lastResponse: Response | undefined;

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 60_000);

      const response = await fetch(url, {
        ...options,
        signal: controller.signal,
      });
      clearTimeout(timeout);

      if (response.ok || !RETRYABLE_STATUS_CODES.has(response.status)) {
        return response;
      }

      lastResponse = response;

      // Respect Retry-After header
      const retryAfter = response.headers.get('retry-after');
      if (retryAfter && attempt < retries) {
        const delayMs = /^\d+$/.test(retryAfter)
          ? parseInt(retryAfter, 10) * 1000
          : Math.max(0, new Date(retryAfter).getTime() - Date.now());
        if (delayMs > 0 && delayMs < 30_000) {
          await sleep(delayMs);
          continue;
        }
      }
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      if (lastError.name === 'AbortError') {
        lastError = new Error('Request timed out after 60s');
      }
    }

    if (attempt < retries) {
      const delay = BASE_DELAY_MS * Math.pow(2, attempt) + Math.random() * 500;
      logger.debug({ attempt, delay }, 'Retrying after delay');
      await sleep(delay);
    }
  }

  if (lastResponse) return lastResponse;
  throw lastError ?? new Error('All retry attempts failed');
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ── Fallback chain execution ─────────────────────────────────────────

function getFallbackChain(model: string): string[] {
  const config = loadConfig();
  const fallbacks = config.models?.fallbacks ?? {};

  // Check if any role's fallback starts with this model
  for (const chain of Object.values(fallbacks)) {
    if (chain[0] === model) return chain;
  }

  // Check role-based defaults
  const defaults = config.models?.defaults ?? {};
  for (const [role, defaultModel] of Object.entries(defaults)) {
    if (defaultModel === model && fallbacks[role]) {
      return fallbacks[role]!;
    }
  }

  return [model]; // No fallback, just the original model
}

// ── Build provider request ───────────────────────────────────────────

interface ProviderRequest {
  url: string;
  headers: Record<string, string>;
  body: string;
}

function buildAnthropicRequest(
  provider: ResolvedProvider,
  body: Record<string, unknown>,
): ProviderRequest {
  const model = body.model as string;
  const messages = body.messages as Array<{ role: string; content: string }>;
  const maxTokens = (body.max_tokens as number) ?? 4096;

  const payload: Record<string, unknown> = {
      model,
      messages,
      max_tokens: maxTokens,
    };
    if (body.temperature !== undefined) payload.temperature = body.temperature;
    if (body.stream !== undefined) payload.stream = body.stream;
    if (body.system) payload.system = body.system;

    return {
      url: `${provider.baseUrl}/v1/messages`,
      headers: {
        'content-type': 'application/json',
        'x-api-key': provider.apiKey ?? '',
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(payload),
    };
}

function buildOpenAIRequest(
  provider: ResolvedProvider,
  body: Record<string, unknown>,
): ProviderRequest {
  return {
    url: `${provider.baseUrl}/chat/completions`,
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${provider.apiKey ?? ''}`,
    },
    body: JSON.stringify(body),
  };
}

function buildProviderRequest(
  provider: ResolvedProvider,
  body: Record<string, unknown>,
): ProviderRequest {
  switch (provider.type) {
    case 'anthropic':
      return buildAnthropicRequest(provider, body);
    case 'openai':
    case 'ollama':
    case 'llamacpp':
    case 'litellm':
    default:
      return buildOpenAIRequest(provider, body);
  }
}

// ── Extract token usage from response ────────────────────────────────

interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
}

function extractUsage(responseBody: Record<string, unknown>, providerType: ProviderType): TokenUsage {
  // Anthropic format
  if (providerType === 'anthropic') {
    const usage = responseBody.usage as Record<string, number> | undefined;
    return {
      inputTokens: usage?.input_tokens ?? 0,
      outputTokens: usage?.output_tokens ?? 0,
    };
  }

  // OpenAI format
  const usage = responseBody.usage as Record<string, number> | undefined;
  return {
    inputTokens: usage?.prompt_tokens ?? 0,
    outputTokens: usage?.completion_tokens ?? 0,
  };
}

// ── Core proxy handler ───────────────────────────────────────────────

async function proxyRequest(
  body: Record<string, unknown>,
  agentName: string,
): Promise<{ status: number; headers: Record<string, string>; body: string }> {
  const model = (body.model as string) ?? 'claude-sonnet-4';
  const fallbackChain = getFallbackChain(model);

  // M-01: Log request summary
  const messages = (body.messages as Array<{ role: string; content: string }>) ?? [];
  const firstUserMsg = messages.find(m => m.role === 'user');
  const msgPreview = firstUserMsg?.content?.slice(0, 100) ?? '(none)';
  logger.info({ model, agent: agentName, messageCount: messages.length }, 'Incoming request');
  logger.debug({ agent: agentName, model, firstUserMessagePreview: msgPreview }, 'Request content');

  let lastError: string = '';
  let lastStatus = 502;

  for (const fallbackModel of fallbackChain) {
    const currentBody = { ...body, model: fallbackModel };
    const provider = resolveProvider(fallbackModel);

    if (!provider) {
      logger.warn({ model: fallbackModel }, 'Skipping unresolvable model in fallback chain');
      continue;
    }

    logger.debug({ model: fallbackModel, provider: provider.name, agent: agentName }, 'Routing request');

    const req = buildProviderRequest(provider, currentBody);

    try {
      const response = await fetchWithRetry(req.url, {
        method: 'POST',
        headers: req.headers,
        body: req.body,
      });

      const responseText = await response.text();

      // Log cost entry for any response (success or error)
      if (response.ok) {
        try {
          const responseJson = JSON.parse(responseText) as Record<string, unknown>;
          const usage = extractUsage(responseJson, provider.type);
          const cost = estimateCost(fallbackModel, usage.inputTokens, usage.outputTokens);

          recordCostEntry({
            timestamp: new Date().toISOString(),
            agent: agentName,
            model: fallbackModel,
            provider: provider.name,
            inputTokens: usage.inputTokens,
            outputTokens: usage.outputTokens,
            cost,
          });

          logger.info({
            agent: agentName,
            model: fallbackModel,
            provider: provider.name,
            inputTokens: usage.inputTokens,
            outputTokens: usage.outputTokens,
            cost: cost.toFixed(6),
            status: response.status,
          }, 'Request completed');
        } catch {
          // Non-JSON responses — still return them
        }

        // Success — return immediately
        return {
          status: response.status,
          headers: { 'content-type': response.headers.get('content-type') ?? 'application/json' },
          body: responseText,
        };
      }

      // Non-2xx response — log and try next fallback
      lastStatus = response.status;
      lastError = responseText.slice(0, 200);
      logger.warn({ model: fallbackModel, provider: provider.name, status: response.status }, 'Provider returned error, trying fallback');
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      lastStatus = 502;
      logger.warn({ model: fallbackModel, provider: provider.name, error: lastError }, 'Provider failed, trying fallback');
    }
  }

  return {
    status: lastStatus,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      error: {
        message: `All providers failed. Last error: ${lastError}`,
        type: 'gateway_error',
        code: 'all_providers_failed',
      },
    }),
  };
}

// ── HTTP body reader ─────────────────────────────────────────────────

function readRequestBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const MAX_BODY = 10 * 1024 * 1024; // 10MB limit

    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        req.destroy();
        reject(new Error('Request body too large'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString()));
    req.on('error', reject);
  });
}

// ── Gateway server ───────────────────────────────────────────────────

export interface GatewayServer {
  port: number;
  close: () => void;
}

export async function startGateway(
  port: number = 18999,
  bind: string = '127.0.0.1',
): Promise<GatewayServer> {
  const server = createServer(async (req, res) => {
    // Health check
    if (req.url === '/health' || req.url === '/healthz') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', gateway: 'bscs' }));
      return;
    }

    // OpenAI-compatible chat completions endpoint
    if (req.method === 'POST' && (req.url === '/v1/chat/completions' || req.url === '/chat/completions')) {
      try {
        const rawBody = await readRequestBody(req);
        const body = JSON.parse(rawBody) as Record<string, unknown>;

        // C-03: Validate request body
        if (!body.model || typeof body.model !== 'string' || body.model.trim() === '') {
          res.writeHead(400, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: { message: 'Missing or invalid "model" field in request body', type: 'invalid_request_error' } }));
          return;
        }
        if (!Array.isArray(body.messages) || body.messages.length === 0) {
          res.writeHead(400, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: { message: 'Missing or invalid "messages" field in request body (must be a non-empty array)', type: 'invalid_request_error' } }));
          return;
        }

        // L-01: Reject unknown models before proxying
        const precheckProvider = resolveProvider(body.model as string);
        if (!precheckProvider) {
          res.writeHead(400, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: { message: `Unknown model "${body.model}" — no provider configured and no prefix match found`, type: 'invalid_request_error' } }));
          return;
        }

        // C-01: Reject google provider (not yet implemented)
        if (precheckProvider.type === 'google') {
          res.writeHead(501, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: { message: `Google/Gemini provider is not yet supported through this gateway`, type: 'not_implemented' } }));
          return;
        }

        // Extract agent name from custom header or default
        const agentName = (req.headers['x-bscs-agent'] as string) ?? 'unknown';

        // Streaming path — uses fallback chain (C-02)
        if (body.stream === true) {
          const model = (body.model as string) ?? 'claude-sonnet-4';
          const fallbackChain = getFallbackChain(model);

          let streamSucceeded = false;

          for (const fallbackModel of fallbackChain) {
            const currentBody = { ...body, model: fallbackModel };
            const provider = resolveProvider(fallbackModel);

            if (!provider) {
              logger.warn({ model: fallbackModel }, 'Skipping unresolvable model in streaming fallback chain');
              continue;
            }
            if (provider.type === 'google') {
              logger.warn({ model: fallbackModel }, 'Skipping google provider in streaming fallback chain (not implemented)');
              continue;
            }

            const providerReq = buildProviderRequest(provider, currentBody);
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), 120_000);

            // H-01: Track client disconnection to abort upstream
            const onClientClose = () => {
              controller.abort();
              clearTimeout(timeout);
              logger.info({ agent: agentName, model: fallbackModel }, 'Client disconnected during stream');
            };
            res.on('close', onClientClose);

            try {
              const upstream = await fetch(providerReq.url, {
                method: 'POST',
                headers: providerReq.headers,
                body: providerReq.body,
                signal: controller.signal,
              });
              clearTimeout(timeout);

              if (!upstream.ok) {
                logger.warn({ model: fallbackModel, provider: provider.name, status: upstream.status }, 'Streaming provider returned error, trying fallback');
                res.removeListener('close', onClientClose);
                continue;
              }

              res.writeHead(upstream.status, {
                'content-type': upstream.headers.get('content-type') ?? 'text/event-stream',
                'cache-control': 'no-cache',
                connection: 'keep-alive',
              });

              if (upstream.body) {
                const reader = (upstream.body as ReadableStream).getReader();
                let lastUsageData: string | null = null;

                const pump = async () => {
                  while (true) {
                    // H-01: Check if client is still connected before each write
                    if (res.writableEnded || res.destroyed) {
                      logger.info({ agent: agentName, model: fallbackModel }, 'Client already disconnected, aborting stream pump');
                      reader.cancel().catch(() => {});
                      break;
                    }
                    const { done, value } = await reader.read();
                    if (done) break;

                    // Track usage data from SSE events for cost recording
                    if (value) {
                      const chunk = new TextDecoder().decode(value);
                      if (chunk.includes('"usage"')) {
                        lastUsageData = chunk;
                      }
                      res.write(value);
                    }
                  }
                  res.end();
                  res.removeListener('close', onClientClose);

                  // C-02: Record cost for streaming response
                  if (lastUsageData) {
                    try {
                      // Extract usage from the last SSE event containing usage data
                      const usageMatch = lastUsageData.match(/data:\s*(\{[\s\S]*\})/);
                      if (usageMatch?.[1]) {
                        const usageJson = JSON.parse(usageMatch[1]);
                        const usage = extractUsage(usageJson, provider.type);
                        const cost = estimateCost(fallbackModel, usage.inputTokens, usage.outputTokens);
                        recordCostEntry({
                          timestamp: new Date().toISOString(),
                          agent: agentName,
                          model: fallbackModel,
                          provider: provider.name,
                          inputTokens: usage.inputTokens,
                          outputTokens: usage.outputTokens,
                          cost,
                        });
                        logger.info({
                          agent: agentName,
                          model: fallbackModel,
                          provider: provider.name,
                          inputTokens: usage.inputTokens,
                          outputTokens: usage.outputTokens,
                          cost: cost.toFixed(6),
                          streamed: true,
                        }, 'Streaming request completed');
                      }
                    } catch {
                      // Non-parseable usage — skip cost tracking for this stream
                    }
                  }
                };
                // M-03: Log stream pump errors instead of silently swallowing
                pump().catch((err: unknown) => {
                  res.removeListener('close', onClientClose);
                  logger.warn({ err: err instanceof Error ? err.message : String(err) }, 'Stream pump error');
                  if (!res.writableEnded) res.end();
                });
              } else {
                res.end();
              }

              streamSucceeded = true;
              break;
            } catch (err) {
              clearTimeout(timeout);
              res.removeListener('close', onClientClose);
              const errMsg = err instanceof Error ? err.message : String(err);
              logger.warn({ model: fallbackModel, provider: provider.name, error: errMsg }, 'Streaming provider failed, trying fallback');

              // If headers already sent, we can't try another fallback
              if (res.headersSent) {
                if (!res.writableEnded) res.end();
                break;
              }
              continue;
            }
          }

          if (!streamSucceeded) {
            res.writeHead(502, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ error: { message: 'All streaming providers failed', type: 'gateway_error', code: 'all_providers_failed' } }));
          }
          return;
        }

        const result = await proxyRequest(body, agentName);
        res.writeHead(result.status, result.headers);
        res.end(result.body);
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Bad request';
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message, type: 'invalid_request_error' } }));
      }
      return;
    }

    // Unknown route
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'Not found. Use POST /v1/chat/completions' } }));
  });

  return new Promise((resolve) => {
    server.listen(port, bind, () => {
      logger.info({ port, bind }, 'LLM Gateway started');
      resolve({
        port,
        close: () => server.close(),
      });
    });
  });
}
