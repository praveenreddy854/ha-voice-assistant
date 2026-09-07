# Apple Shortcut setup

The `Ask Assistant` personal Shortcut lets an Apple device submit finalized
speech to the same assistant capabilities used by the browser: general chat,
Home Assistant commands and state questions, ScheduledTasks, TV control, live
web search, and persistent memory. It uses a separate server-owned Text
Assistant session, so the browser does not need to be open.

## Safety boundary

This integration is intentionally unauthenticated and intended only for a
trusted home network. Anyone who can reach the endpoint can invoke every
assistant capability, including device actions. Configure the Shortcut with a
local hostname or LAN IP, restrict the service with the host/router firewall,
do not port-forward it, and do not publish the endpoint.

The service does not inspect or enforce source CIDRs. Plain HTTP is supported
for now, so commands and answers are visible to systems capable of observing
traffic on the network.

## Configure, package, and install

Set the local service URL in `service/.env`:

```dotenv
APPLE_SHORTCUT_BASE_URL=http://ha-service.home.arpa:3005
```

Ensure the home router or local DNS server resolves `ha-service.home.arpa` to
the machine running the service for every Apple device that will use the
Shortcut. Setting the environment variable does not create that DNS record.

On a Mac signed into iCloud, run from `service/`:

```bash
npm run shortcut:package
```

This injects the local URL into a temporary workflow and signs it with Apple's
`people-who-know-me` mode. The installable file is written to:

```text
service/dist/shortcuts/Ask Assistant.shortcut
```

Open that file on the Mac or transfer it to the intended Apple device, then add
it in Shortcuts. The checked-in
`service/shortcuts/Ask Assistant.shortcut.json` retains only the local-URL
placeholder.

## Use it with Siri

Say:

> Hey Siri, Ask Assistant

Siri runs the Shortcut and asks, “What should I do?” Speak the command, for
example “turn on the bathroom light.” While work is running, the Shortcut polls
the service every two seconds. If the assistant needs clarification or an
action confirmation, Siri asks the returned question and submits the answer to
the same Text Assistant session. The full voice turn has a two-minute limit.

The initial phrase is intentionally two-stage in version 1. A future native App
Intent can support a single phrase such as “Hey Siri, ask Assistant to turn on
the bathroom light.”

## Session behavior

All Apple Shortcut calls share one short conversational-history scope: at most
10 user/assistant items or about five minutes, whichever is smaller. This
history is separate from browser Realtime history. Persistent agent memory
remains shared.

Sessions are process-local and are not recovered after a service restart.
Duplicate delivery can execute a command more than once in version 1.

## HTTP API

The routes do not require authentication and return `Cache-Control: no-store`.

| Method | Route | Purpose |
|---|---|---|
| `POST` | `/api/integrations/apple-shortcuts/sessions` | Start a voice turn with `{ "command": "..." }` |
| `GET` | `/api/integrations/apple-shortcuts/sessions/:conversationId` | Poll session state |
| `POST` | `/api/integrations/apple-shortcuts/sessions/:conversationId/input` | Submit `{ "answer": "..." }` to the pending question |
| `DELETE` | `/api/integrations/apple-shortcuts/sessions/:conversationId` | Cancel the voice turn |

Statuses are `running`, `input_required`, `completed`, `failed`, `cancelled`,
or `expired`. Requests are rate-limited by caller IP.

## Troubleshooting

- Connection failure: confirm the Apple device is on the home network and can
  reach the configured local hostname or IP and service port.
- Packaging failure: run on macOS, sign into iCloud, and confirm
  `APPLE_SHORTCUT_BASE_URL` is present in `service/.env`.
- Timeout: the session exceeded two minutes; invoke `Ask Assistant` again.
