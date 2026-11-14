import { open } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { runExactVote } from './fusion-exact-vote.mjs';

const responseLimit = 128 * 1024;
const failures = new Set(['vote_http_error', 'vote_response_limit', 'vote_invalid_response', 'vote_incomplete_response']);

async function readResponse(response) {
  if (!response.body) throw new Error('vote_invalid_response');
  const reader = response.body.getReader(), chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > responseLimit) {
        void reader.cancel().catch(() => {});
        throw new Error('vote_response_limit');
      }
      chunks.push(Buffer.from(value));
    }
  } finally { reader.releaseLock(); }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new Error('vote_invalid_response'); }
}

/** Invoke a frozen finite-choice panel through an existing compatible gateway. */
export async function runFusionVote(input, { endpoint, apiKey, signal, fetcher = fetch,
  deadlineMs = 120000, requestTimeoutMs = 30000 } = {}) {
  const url = new URL(endpoint);
  if (url.username || url.password || url.search || url.hash
    || !(url.protocol === 'https:' || url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) {
    throw new Error('invalid_vote_endpoint');
  }
  if (typeof apiKey !== 'string' || !apiKey.length || apiKey.length > 8192 || /[\s\x00-\x1f\x7f]/.test(apiKey)
    || typeof fetcher !== 'function' || signal !== undefined && !(signal instanceof AbortSignal)
    || !Number.isSafeInteger(deadlineMs) || deadlineMs < 1 || deadlineMs > 300000
    || !Number.isSafeInteger(requestTimeoutMs) || requestTimeoutMs < 1 || requestTimeoutMs > deadlineMs
    || typeof input?.prompt !== 'string' || !input.prompt.trim() || Buffer.byteLength(input.prompt) > 32768
    || !Array.isArray(input.workers)) throw new Error('invalid_vote_request');
  const prompt = input.prompt;
  const panel = { version: input.version, choices: Array.isArray(input.choices) ? [...input.choices] : input.choices,
    workers: input.workers.map(worker => ({ id: worker?.id, weight: worker?.weight, priority: worker?.priority })) };
  const models = new Map(input.workers.map(worker => [worker?.id, worker?.model]));
  if ([...models.values()].some(model => typeof model !== 'string' || !model.length || model.length > 256 || /\s|[\x00-\x1f\x7f]/.test(model))) {
    throw new Error('invalid_vote_model');
  }
  // Validate the complete panel before dispatching any billable request.
  await runExactVote(panel, async () => null);
  const deadline = AbortSignal.any([AbortSignal.timeout(deadlineMs), ...(signal ? [signal] : [])]);
  const calls = [];
  try {
    const result = await runExactVote(panel, async id => {
      deadline.throwIfAborted();
      const call = { worker: id, model: models.get(id), status: 'pending', usage: null };
      calls.push(call);
      const requestSignal = AbortSignal.any([deadline, AbortSignal.timeout(requestTimeoutMs)]);
      try {
        const response = await fetcher(url.href, { method: 'POST', redirect: 'error', signal: requestSignal,
          headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
          body: JSON.stringify({ model: call.model, stream: false, temperature: 0, max_tokens: 256,
            messages: [{ role: 'system', content: 'Choose one allowed answer label, or null to abstain. Return only the requested JSON object.' }, { role: 'user', content: prompt }],
            response_format: { type: 'json_schema', json_schema: { name: 'fusion_choice', strict: true,
              schema: { type: 'object', properties: { answer: { type: ['string', 'null'], enum: [...panel.choices, null] } },
                required: ['answer'], additionalProperties: false } } } }) });
        if (!response.ok) {
          void response.body?.cancel().catch(() => {});
          throw new Error('vote_http_error');
        }
        const body = await readResponse(response);
        if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('vote_invalid_response');
        if (Number.isSafeInteger(body.usage?.prompt_tokens) && body.usage.prompt_tokens >= 0
          && Number.isSafeInteger(body.usage?.completion_tokens) && body.usage.completion_tokens >= 0) {
          call.usage = { promptTokens: body.usage.prompt_tokens, completionTokens: body.usage.completion_tokens };
        }
        const choice = body.choices?.[0];
        if (!choice || choice.finish_reason !== 'stop' || choice.message?.refusal != null && choice.message.refusal !== ''
          || choice.message?.tool_calls != null && (!Array.isArray(choice.message.tool_calls) || choice.message.tool_calls.length)
          || choice.message?.function_call != null || typeof choice.message?.content !== 'string') {
          throw new Error('vote_incomplete_response');
        }
        let answer;
        try { answer = JSON.parse(choice.message.content); }
        catch { throw new Error('vote_invalid_response'); }
        if (!answer || typeof answer !== 'object' || Array.isArray(answer) || Object.keys(answer).length !== 1
          || !Object.hasOwn(answer, 'answer') || answer.answer !== null && !panel.choices.includes(answer.answer)) {
          throw new Error('vote_invalid_response');
        }
        call.status = 'complete';
        call.answer = answer.answer;
        return answer.answer;
      } catch (error) {
        call.status = 'failed';
        call.error = requestSignal.aborted ? 'vote_deadline' : failures.has(error?.message) ? error.message : 'vote_transport_failed';
        throw new Error(call.error);
      }
    });
    return { status: 'ok', ...result, calls, usageComplete: calls.every(call => call.usage !== null) };
  } catch (error) {
    return { status: 'failed', error: deadline.aborted ? 'vote_deadline' : failures.has(error?.message)
      || error?.message === 'vote_deadline' ? error.message : 'vote_transport_failed', calls };
  }
}

async function main() {
  if (process.argv.length !== 4) throw new Error('invalid_arguments');
  const file = await open(process.argv[3], 'r');
  let input;
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > 128 * 1024) throw new Error('invalid_vote_file');
    const bytes = Buffer.alloc(128 * 1024 + 1);
    let length = 0;
    while (length < bytes.length) {
      const { bytesRead } = await file.read(bytes, length, bytes.length - length, null);
      if (!bytesRead) break;
      length += bytesRead;
    }
    if (length === bytes.length) throw new Error('invalid_vote_file');
    input = JSON.parse(bytes.subarray(0, length).toString('utf8'));
  } finally { await file.close(); }
  const result = await runFusionVote(input, { endpoint: process.argv[2], apiKey: process.env.CLAWROUTER_API_KEY });
  console.log(JSON.stringify(result));
  if (result.status !== 'ok') process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(() => { console.error('fusion_vote_failed'); process.exitCode = 1; });
}
