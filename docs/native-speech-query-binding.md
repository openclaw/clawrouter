# Qualified native speech query binding

The first binding is only `elevenlabs.speech` on the existing declared
`POST /v1/text-to-speech/${voice_id}` route with `audio.binary` output.
It does not enable a provider declaration or implement a response wrapper.

`worker/native-query.ts` exports `NativeQueryBinding`:

```ts
Readonly<{
  protocol: "elevenlabs.speech";
  outputFormat: "mp3_44100_128";
  optimizeStreamingLatency?: "0" | "1" | "2" | "3" | "4";
}>
```

The shared controller parses native URL query or manifest envelope query into
`ProxySelection.nativeQuery` before wrapper preparation. `output_format` may be
omitted and becomes explicit `mp3_44100_128`. Optional
`optimize_streaming_latency` accepts only the five exact string values. Repeated,
unknown, array, numeric, null, conflicting-carrier and unqualified format inputs
are rejected. Native query length is bounded to 256 characters and two fields.
The binding is frozen. It contains no credential or caller-supplied destination.

The source-owned `prepareNativeElevenLabsSpeech(selection): NativeResponse | undefined`
may consume this binding, validate its own body/voice/output contract, and return
`query: selection.nativeQuery` alongside its qualified origin and voice path.
The wrapper must reject missing or mismatched binding; unrelated formats return
undefined. No common-file casts or query passthrough are needed.

`nativeDispatchQuery` requalifies the original query before credential selection,
requires agreement between the selection and response wrapper, and emits only
the canonical qualified query. `assertNativeResponseDestination` then compares
the exact final origin, path and canonical query. Configured or grant-added query
parameters cannot slip through that check. `upstreamPath` still cannot contain a
query and is forbidden on this first protocol binding. Query-less native wrappers
retain their existing rejection; unrelated generic proxy queries are unchanged.

An endpoint declaration without the actual response wrapper remains denied.
This foundation proves the shared query and original-credential factory boundary,
not completed speech delivery. The proposed two-file wrapper ownership still
requires both owners' acceptance and the coordinator's explicit record.

The first wrapper contract is complete HTTP 200 MP3 bytes with `audio/mpeg`,
16 MiB maximum output and the existing 32 MiB capacity lease. WAV/PCM/Opus and
streaming are not enabled by this binding. Native `model_id` remains provider
input; this change creates neither model eligibility nor a character tariff.
Unknown hard-dollar costs remain denied, and explicit policy-fixed accounting is
separate. No original credential, policy, reservation, deadline, redirect,
cancellation or conservative settlement control is transferred to the wrapper.
