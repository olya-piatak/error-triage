# error-triage

A small TypeScript pipeline that pulls the last day of production errors from PostHog, Sentry or a JSON export, groups them into distinct issues, asks an LLM to prioritise and explain each one, and posts a single report to Slack. Grouping is deterministic and happens before the model sees anything, so the model call stays small and the cost stays flat no matter how noisy the day was.

## Why

Reading raw error logs every morning does not scale: the same crash shows up hundreds of times with different ids, and the one new problem hides between them. Error dashboards help, but they still need someone to open them, filter, and decide what matters. This tool turns that routine into one prioritised Slack message a day, written for the person on call.

## Architecture

```
                 +-----------+     +-----------+     +-----------+
  PostHog  ----> |           |     |           |     |           |
  Sentry   ----> |  sources  | --> | normalize | --> |   group   |
  JSON     ----> |           |     |           |     |           |
                 +-----------+     +-----------+     +-----------+
                  RawError[]        fingerprint       ErrorGroup[]
                                                          |
                                                          v
                 +-----------+     +-----------+     +-----------+
  Slack    <---- |   slack   | <-- |  report   | <-- |    llm    | <--> OpenAI-compatible
  report.md <--- |           |     |           |     |           |      endpoint or StubLLM
                 +-----------+     +-----------+     +-----------+
                                    Markdown +        strict JSON
                                    Block Kit         (zod-validated)
                                        ^
                                        |
                                 .triage-state.json  (fingerprints from the
                                                      previous run -> NEW marker)
```

Every box is one file under `src/`. Sources produce `RawError[]`; nothing downstream knows which source it came from. The LLM client speaks the OpenAI chat-completions protocol (`POST <base>/chat/completions` with a Bearer token), so it works with OpenAI, Groq, Together, Ollama or LM Studio by changing one URL. Endpoints with a different URL scheme or auth header, such as Azure OpenAI, need a proxy in front.

## Quick start

```bash
git clone <this repo> && cd error-triage
npm install
npm run demo
```

`npm run demo` builds the project and runs it on `fixtures/errors.sample.json` with a built-in stub model. It prints a full Markdown report to stdout, needs no credentials, and makes no network calls. The stub answers with fixed rules instead of an LLM, so the wording is generic; the grouping, counts and layout are the real thing.

To run against real data:

```bash
cp .env.example .env      # fill in SOURCE, its credentials, LLM_API_KEY, SLACK_WEBHOOK_URL
npm run build
node dist/index.js run --since 24h --dry-run   # print report + Slack payload, post nothing
node dist/index.js run --since 24h             # post to Slack and save fingerprints
```

Add `--out report.md` to either command to also write the Markdown to a file.

## Configuration

All configuration comes from environment variables (a `.env` file in the working directory is loaded automatically). Values are validated with zod at start-up; a missing or malformed setting fails the run with the variable named.

| Variable             | Default                       | Description                                                                      |
| -------------------- | ----------------------------- | -------------------------------------------------------------------------------- |
| `SOURCE`             | `json`                        | `posthog`, `sentry` or `json`                                                    |
| `JSON_PATH`          | `fixtures/errors.sample.json` | File to read when `SOURCE=json`                                                  |
| `POSTHOG_HOST`       | `https://us.posthog.com`      | PostHog instance                                                                 |
| `POSTHOG_PROJECT_ID` |                               | Required for `posthog`                                                           |
| `POSTHOG_API_KEY`    |                               | Personal API key with `query:read`; required for `posthog`                       |
| `SENTRY_BASE_URL`    | `https://sentry.io`           | Sentry instance                                                                  |
| `SENTRY_ORG`         |                               | Required for `sentry`                                                            |
| `SENTRY_PROJECT`     |                               | Required for `sentry`                                                            |
| `SENTRY_AUTH_TOKEN`  |                               | Token with `project:read` and `event:read`; required for `sentry`                |
| `LLM_PROVIDER`       | `openai`                      | `openai` for any OpenAI-compatible endpoint, `stub` for the built-in model       |
| `LLM_BASE_URL`       | `https://api.openai.com/v1`   | Base URL; `/chat/completions` is appended                                        |
| `LLM_API_KEY`        |                               | Bearer token. Leave empty for local endpoints that do not check one              |
| `LLM_MODEL`          | `gpt-4o-mini`                 | Model name passed through unchanged                                              |
| `SLACK_WEBHOOK_URL`  |                               | Incoming webhook. Required unless `--dry-run`                                    |
| `REPORT_TIMEZONE`    | `UTC`                         | IANA zone used for every timestamp in the report                                 |
| `MAX_GROUPS`         | `15`                          | Most frequent groups to keep (1 to 50). Also bounds prompt size and Slack blocks |
| `STATE_PATH`         | `.triage-state.json`          | Where the previous run's fingerprints are stored                                 |

## Sources

Each source implements one interface: `fetch({ since }) => Promise<RawError[]>`.

- **json** reads a JSON array of `RawError` objects and filters by timestamp. Use it for demos, tests, or any tool that can export JSON.
- **posthog** runs a HogQL query for `$exception` events through the query API (`POST /api/projects/:id/query`). It reads both the older `$exception_message` / `$exception_stack_trace_raw` properties and the newer `$exception_list` structure, rebuilding a stack from frames when needed.
- **sentry** lists unresolved issues for a project (`GET /api/0/projects/:org/:project/issues/`) ordered by frequency. Sentry has already grouped events, so each issue becomes one record with its `count`; the local grouping then merges issues whose messages differ only by ids. One page of 100 issues is fetched.

Both API clients were written against the public API documentation and unit-tested with hand-written payloads that follow the documented shapes, not against a live account. If a field moves, the mapping functions (`mapPostHogRow`, `mapSentryIssue`) are the only place to change.

## Report example

Output of `npm run demo` (the date in the heading is the run time):

```markdown
# Error triage, 2026-09-11 14:19 UTC (last 24h)

Source: json · 25 occurrences in 9 groups
Severity: P1 4 · P2 2 · P3 3

> 9 distinct issues from 25 occurrences: 4 P1, 2 P2, 3 P3. Generated by the stub model; connect an LLM for real analysis.

## P1: Request failed with status code 502 (GET /api/orders/88402)

- **Count:** 5 (4 users) · **First seen:** 2026-09-10 07:15 · **Last seen:** 2026-09-11 04:58
- **Owner:** backend
- **Likely cause:** Heuristic match on "status code 502" (stub model, no LLM call).
- **Next step:** Check API logs around the last occurrence and trace the failing request.
- **Example:** `Request failed with status code 502 (GET /api/orders/88402) at https://shop.example.com/orders/88402`

## P1: Timed out fetching a new connection from the connection pool. (More info:...

- **Count:** 3 · **First seen:** 2026-09-10 07:15 · **Last seen:** 2026-09-10 12:02
- **Owner:** backend
- **Likely cause:** Heuristic match on "prisma" (stub model, no LLM call).
- **Next step:** Check API logs around the last occurrence and trace the failing request.
- **Example:** `Timed out fetching a new connection from the connection pool. (More info: http://pris.ly/d/connection-pool (Current connection pool size: 10, connection limit: ... at /api/orders/88304`

## P1: connect ECONNREFUSED 10.0.3.17:6379

- **Count:** 2 · **First seen:** 2026-09-10 09:20 · **Last seen:** 2026-09-10 09:20
- **Owner:** infra
- **Likely cause:** Heuristic match on "ECONNREFUSED" (stub model, no LLM call).
- **Next step:** Verify the upstream service is reachable and review connection limits.
- **Example:** `connect ECONNREFUSED 10.0.3.17:6379 at /api/checkout/session`

## P1: No such payment_intent: 'pi_3Nx8Kq2eZvKYlo2C1abcdefg'

- **Count:** 1 (1 user) · **First seen:** 2026-09-10 18:49 · **Last seen:** 2026-09-10 18:49
- **Owner:** backend
- **Likely cause:** Heuristic match on "payment" (stub model, no LLM call).
- **Next step:** Check API logs around the last occurrence and trace the failing request.
- **Example:** `No such payment_intent: 'pi_3Nx8Kq2eZvKYlo2C1abcdefg' at /api/checkout/confirm`

## P2: Cannot read properties of undefined (reading 'items')

- **Count:** 6 (4 users) · **First seen:** 2026-09-10 07:12 · **Last seen:** 2026-09-11 06:21
- **Owner:** frontend
- **Likely cause:** Heuristic match on "Cannot read propert" (stub model, no LLM call).
- **Next step:** Reproduce in the browser at the sample URL and add a guard or error boundary.
- **Example:** `Cannot read properties of undefined (reading 'items') at https://shop.example.com/cart`

## P2: Loading chunk 1190 failed.

- **Count:** 4 (3 users) · **First seen:** 2026-09-10 08:41 · **Last seen:** 2026-09-11 01:14
- **Owner:** frontend
- **Likely cause:** Heuristic match on "chunk" (stub model, no LLM call).
- **Next step:** Reproduce in the browser at the sample URL and add a guard or error boundary.
- **Example:** `Loading chunk 1190 failed. at https://shop.example.com/products/trail-jacket-07`

## P3: jwt expired

- **Count:** 2 (2 users) · **First seen:** 2026-09-10 10:44 · **Last seen:** 2026-09-10 21:37
- **Owner:** backend
- **Likely cause:** Heuristic match on "jwt" (stub model, no LLM call).
- **Next step:** Check API logs around the last occurrence and trace the failing request.
- **Example:** `jwt expired at /api/account/orders`

## P3: Invalid time value

- **Count:** 1 (1 user) · **First seen:** 2026-09-10 16:12 · **Last seen:** 2026-09-10 16:12
- **Owner:** unknown
- **Likely cause:** Heuristic match on "no known pattern" (stub model, no LLM call).
- **Next step:** Open the top example, identify the owning module and assign it.
- **Example:** `Invalid time value at https://shop.example.com/account/orders`

## P3: Hydration failed because the initial UI does not match what was rendered on...

- **Count:** 1 (1 user) · **First seen:** 2026-09-10 13:17 · **Last seen:** 2026-09-10 13:17
- **Owner:** frontend
- **Likely cause:** Heuristic match on "Hydration" (stub model, no LLM call).
- **Next step:** Reproduce in the browser at the sample URL and add a guard or error boundary.
- **Example:** `Hydration failed because the initial UI does not match what was rendered on the server. at https://shop.example.com/products/hiking-boots-42`
```

The 25 fixture records collapse into 9 groups because ids, order numbers, chunk hashes and bundle hashes are stripped before grouping. With a real model the title, likely cause and next step are written for each group; with a state file present, groups not seen in the previous run carry a **NEW** marker and the header shows how many there are. The Slack message carries the same content as Block Kit sections.

## How prioritisation works

1. **Normalise.** Each message is rewritten with volatile parts replaced by placeholders: numbers, UUIDs, hex hashes, IPv4 addresses, ISO timestamps, long alphanumeric ids, and URL query strings. The top three stack frames are kept with line and column numbers removed. Message plus frames form the fingerprint.
2. **Group.** Errors with the same fingerprint are merged into one group with count, distinct users, first and last seen, and up to three examples. Groups are sorted by count and cut at `MAX_GROUPS`.
3. **Ask the model once.** The groups are sent in a single chat-completion request as compact JSON. The model must reply with strict JSON (`fingerprint`, `title`, `severity` P1 to P3, `likelyCause`, `suggestedOwner`, `nextStep`, plus a `summary`). The reply is parsed with zod; Markdown fences and surrounding prose are tolerated, anything else is rejected with the raw text kept for debugging.
4. **Render.** Model output is joined back to the deterministic stats. A group the model skipped still appears, marked as not assessed, so a flaky reply never hides an error.

The model only decides wording and priority. It never sees raw events, so the prompt size depends on the number of distinct issues, not on traffic. Ten thousand copies of one crash cost the same as one.

## Running on a schedule

`.github/workflows/triage.yml` runs at 07:00 UTC daily and on manual dispatch (with `since` and `dry_run` inputs). It restores `.triage-state.json` from the Actions cache, runs `node dist/index.js run --since 24h`, posts to Slack, saves the new state, and uploads the Markdown report as a build artifact.

Set non-secret options as repository **variables** (`SOURCE`, `LLM_MODEL`, `REPORT_TIMEZONE`, ...) and credentials as repository **secrets** (`POSTHOG_API_KEY` or `SENTRY_AUTH_TOKEN`, `LLM_API_KEY`, `SLACK_WEBHOOK_URL`). Set `SOURCE` explicitly: without it the job falls back to `json` and posts the bundled sample data to your channel every morning. Nothing sensitive is stored in the repository; `.env` and the state file are ignored by git.

`.github/workflows/ci.yml` runs lint, tests, build and the demo on Node 20 and 22 for every pull request.

## Testing

```bash
npm run lint    # eslint (typescript-eslint recommended) + prettier --check
npm test        # vitest
```

Tests never touch the network: HTTP clients take an injectable `fetch`, and the end-to-end test replaces the global `fetch` with a function that throws. Coverage by area:

- `normalize`: placeholder rules, frame trimming, fingerprint stability across ids and bundle hashes.
- `group`: counts, distinct users, time range, sorting, cap, examples, order independence.
- `llm/prompt`: prompt payload shape; parsing of bare JSON, fenced JSON, JSON with prose, invalid JSON, schema violations.
- `llm/client`: request shape, retry on 429 and 5xx with backoff, no retry on 4xx, network failure retry, empty completions; stub determinism and heuristics.
- `sources`: JSON reading and validation, PostHog HogQL and row mapping for both property styles, Sentry issue mapping and `statsPeriod` conversion, error responses.
- `config`, `state`, `report`: defaults, per-source required variables, empty-string handling, state round-trip and corrupt files, Markdown and Block Kit rendering, NEW markers, Slack text limits.
- End to end: the full pipeline on the fixture, the `demo` command, `run --dry-run` with a state file, and CLI error paths.

## Roadmap

- Sentry pagination and PostHog cursor support for projects with more than one page of issues per day.
- Optional per-owner routing so `frontend`, `backend` and `infra` items go to separate Slack channels.
- A `compare` command that diffs two state files and reports which groups disappeared, to close the loop on fixes.

## License

MIT, see [LICENSE](LICENSE).
