# Memory-guided Home Assistant commands

Household identities, aliases, preferences, action sequences, and known settling
times belong in scoped Persistent agent memory. `service/src/ha.ts` retrieves
relevant memories for each request and supplies their formatted context to the
translator separately from the current user command. The shared prompt describes
generic Home Assistant operations; it contains no installed household entities
or per-device rules. The executor never scans memory text for device keywords or
adds actions after translation.

Use the existing `save_memory` tool for new guidance and `update_memory` to
correct an existing item. These tools are available through the assistant's
normal voice/text channels. Prefer updating an existing applicable rule over
creating competing copies. Deployment does not seed, rewrite, or infer memories
from telemetry automatically.

## What to remember

- Use `preference` for desired behavior, such as capturing a reference position
  after selecting a position.
- Use `guidance` for a reusable operating sequence, including a known settling
  time and the controls involved.
- Scope device guidance with `deviceEntityIds` or `deviceNames`; add room/domain
  scopes where useful. Avoid global rules for behavior specific to one device.
- Store durable instructions, not current device state, credentials, raw traces,
  or an unverified claim that an action completed.

For example, this is an illustrative memory-tool input for a test actuator,
with a device-specific delay supplied as data:

```json
{
  "text": "After selecting a position on the test actuator, wait 2400ms for motion to settle, press button.test_capture_reference, then enable switch.test_auto_return. Follow the current request if it excludes any of these actions.",
  "memoryType": "guidance",
  "scopes": {
    "deviceNames": ["test actuator"],
    "deviceEntityIds": [
      "select.test_position",
      "button.test_capture_reference",
      "switch.test_auto_return"
    ]
  }
}
```

The living room camera's existing preset/guard preferences remain relevant
memory. To preserve the former executor behavior, update the applicable guidance
to specify the known 15-second settling allowance before saving the guard
position. Selecting a preset, saving the guard position, and enabling automatic
guard return must be described as distinct actions. The former delay was an
execution allowance, not measured proof of camera motion completion. The guard
return switch must still be included in `HOME_ASSISTANT_DEVICES`.

## Planning and execution

Current explicit user instructions override memory. Memory can describe an
alias or a preferred sequence, but cannot expand the configured device list,
invent select options, or turn a read-only state question into device control.
The translator receives fresh configured entity state/options on each request.

The generated plan may contain service calls, state lookups, and local
`internal/wait` steps. A wait uses `entity_id: "__internal_wait__"` and a positive
integer `service_data.duration_ms`. Each wait and the total wait time per plan
are limited to 30,000ms; longer delays require scheduled tasks. The executor
does not insert a default device delay or silently clamp an invalid duration.

Before any service write, the complete plan is validated for JSON shape, wait
limits, configured entity membership, matching state-query targets, and current
select options. Service data cannot add target selectors (`entity_id`, `area_id`,
`device_id`, `floor_id`, `label_id`, or a nested `target` object). Failures stop
remaining steps and retain earlier completed-step data, including when a later
HTTP request rejects or times out. Cancellation still propagates to the run
lifecycle; waits retain cancellation and pause handling. Successful HTTP
responses and elapsed waits do not establish physical completion.

Memory guides the model's plan; validation and execution are deterministic.
Mocked tests check memory injection and execution boundaries without making
claims about live model adherence or household effects.

## Telemetry

Home Assistant execution retains the retrieved memory IDs in `ha.memory.ids`
and `ha.translation.resolved.data.memoryIds`. These IDs identify supplied
context, not proof that the model applied every memory. Generated and normalized
plans remain visible for inspection. Device-specific guard-augmentation flags
are no longer emitted; older traces may still contain them.

| Event or result | Meaning |
| --- | --- |
| `ha.translation.configuration` | Translation model and shared prompt-template version |
| `ha.translation.resolved` | Generated plan, normalized plan, and retrieved memory IDs; includes `no_match` when no complete plan was resolved |
| `ha.translation.failed` | Stage `model_request`, `response_parse`, or `plan_validation`, plus sanitized provider/validation diagnostics |
| `home_assistant_request` tool result | A service/state request result; transport acceptance is not physical completion |
| `wait` tool result | A local bounded wait; no Home Assistant HTTP request is made |

Browser telemetry, source labels, audio paths, and client privacy rules are
unchanged. Backend command evidence remains in the existing OTEL/JSONL pipeline.
