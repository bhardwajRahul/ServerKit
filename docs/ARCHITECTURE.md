# ServerKit Architecture

> Deep dive into how ServerKit connects domains, apps, containers, databases, and extensions.

> **Diagrams.** Each section leads with an image and keeps an ASCII fallback in a
> collapsible fold underneath. Images live in [`docs/images/architecture/`](images/architecture/);
> if you change one, update the ASCII block so the doc still reads in plain text.

---

## Table of Contents

- [System Overview](#system-overview)
- [Request Flow](#request-flow)
- [Backend Layers](#backend-layers)
- [Extension Platform](#extension-platform)
- [Template System](#template-system)
- [Port Allocation](#port-allocation)
- [Service Linking & Env Injection](#service-linking--env-injection)
- [Jobs & Scheduling](#jobs--scheduling)
- [Notifications Bus](#notifications-bus)
- [Agent Fleet](#agent-fleet)
- [Environment Pipeline](#environment-pipeline)
- [File Paths](#file-paths)

---

## System Overview

![ServerKit architecture: clients and public visitors reach an nginx edge layer that
splits panel traffic to the Flask API and public traffic to app containers; the
ServerKit panel holds the React SPA, REST API, Socket.IO agent gateway, services,
models, jobs, notifications and the extension runtime; a runtime layer on the same
server holds Docker app containers, databases and panel state; a remote agent fleet
of Go agents connects back over the /agent namespace.](images/architecture/system-overview.png)

<details>
<summary>ASCII diagram</summary>

```
                                    ┌─────────────────────────────────────────────────────────────┐
                                    │                        INTERNET                             │
                                    └─────────────────────────────────────────────────────────────┘
                                                              │
                                                              ▼
┌─────────────────────────────────────────────────────────────────────────────────────────────────────┐
│                                         YOUR SERVER                                                  │
│  ┌───────────────────────────────────────────────────────────────────────────────────────────────┐  │
│  │                                    NGINX (Reverse Proxy)                                      │  │
│  │                                      Port 80 / 443                                            │  │
│  │                                                                                               │  │
│  │   ┌──────────────┐    ┌──────────────┐    ┌──────────────┐    ┌──────────────┐              │  │
│  │   │ app1.com     │    │ app2.com     │    │ api.app3.com │    │ Panel API    │              │  │
│  │   │    :443      │    │    :443      │    │    :443      │    │  /api/v1/    │              │  │
│  │   └──────┬───────┘    └──────┬───────┘    └──────┬───────┘    └──────┬───────┘              │  │
│  └──────────┼───────────────────┼───────────────────┼───────────────────┼────────────────────────┘  │
│             │                   │                   │                   │                           │
│             │ proxy_pass        │ proxy_pass        │ proxy_pass        │ proxy_pass                │
│             ▼                   ▼                   ▼                   ▼                           │
│  ┌────────────────────────────────────────────────────────────┐  ┌─────────────────────────────┐   │
│  │                    DOCKER CONTAINERS                       │  │      SERVERKIT PANEL        │   │
│  │                                                            │  │   Flask + Gunicorn (-w 1)   │   │
│  │   ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐  │  │                             │   │
│  │   │WordPress │  │  Flask   │  │ Node.js  │  │  Custom  │  │  │  api/  services/  models/   │   │
│  │   │  :8001   │  │  :8002   │  │  :8003   │  │  :8004   │  │  │  jobs/ notifications/       │   │
│  │   │          │  │          │  │          │  │          │  │  │  plugins/  agent_gateway    │   │
│  │   │ Apache   │  │ Gunicorn │  │   PM2    │  │  Your    │  │  │                             │   │
│  │   │ PHP-FPM  │  │ Python   │  │ Express  │  │  App     │  │  │  Socket.IO (threading)      │   │
│  │   └────┬─────┘  └──────────┘  └──────────┘  └──────────┘  │  └──────────────┬──────────────┘   │
│  └────────┼───────────────────────────────────────────────────┘                 │                  │
│           │                                                                     │                  │
│           ▼                                                                     ▼                  │
│  ┌────────────────────────────────────────────────┐   ┌──────────────────────────────────────┐   │
│  │                  DATABASES                     │   │          PANEL STATE                 │   │
│  │  ┌────────┐ ┌──────────┐ ┌───────┐ ┌────────┐ │   │  SQLite (default) or PostgreSQL      │   │
│  │  │ MySQL  │ │Postgres  │ │ Redis │ │Mongo   │ │   │  Alembic migrations                  │   │
│  │  │ :3306  │ │  :5432   │ │ :6379 │ │ :27017 │ │   └──────────────────────────────────────┘   │
│  │  └────────┘ └──────────┘ └───────┘ └────────┘ │                                               │
│  └────────────────────────────────────────────────┘                                               │
│                                                                                                    │
└────────────────────────────────────────────────────────────────────────────────────────────────────┘
                                          │
                                          │ Socket.IO /agent namespace (HMAC) + HTTP long-poll
                                          ▼
                       ┌──────────────────────────────────────────────┐
                       │   REMOTE SERVERS (managed fleet)             │
                       │   serverkit-agent (Go) — separate repo       │
                       └──────────────────────────────────────────────┘
```

</details>

The numbered zones in the diagram map to the rest of this document:

| # | Zone | Deep dive |
|---|---|---|
| 1 | **Clients** — admin users on the panel, public visitors on hosted sites | [Request Flow](#request-flow) |
| 2 | **Edge layer** — nginx terminating TLS, splitting panel traffic from public traffic | [Request Flow](#request-flow) |
| 3 | **ServerKit panel** — the Flask app and everything inside it | [Backend Layers](#backend-layers), [Extension Platform](#extension-platform), [Jobs](#jobs--scheduling), [Notifications](#notifications-bus) |
| 4 | **Runtime layer** — app containers, databases, panel state, on-disk paths | [Port Allocation](#port-allocation), [File Paths](#file-paths) |
| 5 | **Remote agent fleet** — Go agents on other servers | [Agent Fleet](#agent-fleet) |

Read as tiers rather than zones, that is:

1. **Frontend** — React 18 SPA (Vite + SCSS), built into Flask's static folder in production.
2. **Backend** — Flask REST API + Socket.IO managing Docker, nginx, databases, and system services.
3. **Agent** — a Go binary running on *remote* managed servers. Its source lives in the
   separate [`serverkit-agent`](https://github.com/jhd3197/serverkit-agent) repo, **not**
   in this one, so panel↔agent protocol changes are not atomic in a single commit.

Two flows cross the diagram in opposite directions: **control and management**
(panel → edge → containers, and panel → agents as outgoing commands) and
**public traffic / telemetry** (visitors → edge → containers, and agents →
panel as incoming heartbeat and metrics).

---

## Request Flow

![Public request flow in four steps: (1) the browser makes a request and DNS resolves
app1.com to your server IP; (2) the request hits nginx on port 80/443, which checks
server_name directives and matches app1.com to proxy_pass http://127.0.0.1:8001;
(3) nginx forwards to the Docker container, which receives the request on its internal
port, processes it and returns a response; (4) the response flows back through nginx,
which handles SSL termination, and the user sees the page.](images/architecture/request-flow.png)

<details>
<summary>ASCII diagram</summary>

```
User Request                    What Happens
─────────────────────────────────────────────────────────────────────────────────

  Browser                 1. DNS resolves app1.com to your server IP
     │
     ▼
┌─────────┐              2. Request hits Nginx on port 80/443
│  Nginx  │                 Nginx checks server_name directives
│ :80/443 │                 Matches "app1.com" → proxy_pass http://127.0.0.1:8001
└────┬────┘
     │
     ▼
┌─────────┐              3. Nginx forwards request to Docker container
│ Docker  │                 Container receives request on internal port
│ :8001   │                 App processes and returns response
└────┬────┘
     │
     ▼
┌─────────┐              4. Response flows back through Nginx
│ Response│                 SSL termination handled by Nginx
│  200 OK │                 User sees the page
└─────────┘
```

</details>

Panel requests take the same path but terminate at Flask. Everything under
`/api/v1/` is JSON and JWT-protected; the Flask 404 handler serves `index.html`
so client-side SPA routing works on deep links, while API routes still return
JSON errors.

**Client IP.** Behind the bundled nginx, set `TRUST_PROXY_HEADERS=true` and
`TRUSTED_PROXY_HOPS=1` so Werkzeug's `ProxyFix` derives the real client IP;
leave it off for a directly-exposed dev server. All IP reads go through a single
`get_client_ip()` helper. See [SECURITY.md](../SECURITY.md).

---

## Backend Layers

The Flask app factory is `create_app()` in `backend/app/__init__.py`. Three layers:

| Layer | Path | Role |
|---|---|---|
| **API** | `app/api/` | Flask Blueprints, one file per feature. All routes under `/api/v1/`, `@jwt_required()`. |
| **Services** | `app/services/` | Business logic. Stateless modules; all shell-outs, Docker API calls, and file writes live here. |
| **Models** | `app/models/` | SQLAlchemy ORM. Schema managed by Alembic migrations. |

Cross-cutting subsystems that sit beside those three:

- `app/jobs/` — background work and scheduling (see [Jobs & Scheduling](#jobs--scheduling))
- `app/notifications/` — the notification bus (see [Notifications Bus](#notifications-bus))
- `app/plugins/` + `app/plugins_sdk/` — the extension runtime and its SDK
- `app/sockets.py` — Socket.IO handlers for live metrics, logs, and terminal
- `app/agent_gateway.py` — the `/agent` Socket.IO namespace for the remote fleet
- `app/middleware/security.py` — security headers
- `app/paths.py` — the single source of truth for on-disk locations

---

## Extension Platform

Most non-core functionality ships as an **extension**. The panel stays lean and
operators install only what they need.

![Extension delivery pipeline: a curated index.json in the serverkit-extensions repo
is fetched hourly via SERVERKIT_REGISTRY_URL, falling back to a last-good cache then
the bundled app/data/registry_index.json; the Marketplace previews the extension,
shows its permissions and sha256, and takes operator consent before installing; the
zip is downloaded and its sha256 verified before extraction; installs then split into
(a) copy-installed, where backend and frontend trees are copied into the live plugin
paths, and (b) flagship/in-place, loaded from builtin-extensions via an importlib spec
with no file copy and re-seeded every boot; both converge on runtime registration,
which imports app.plugins.<slug>, registers the blueprint plus models, jobs and
sockets, and attaches a before_request 503 guard so disabling takes effect
immediately.](images/architecture/extension-platform.png)

<details>
<summary>ASCII diagram</summary>

```
┌───────────────────────────────────────────────────────────────────────────────┐
│                       REGISTRY (serverkit-extensions repo)                    │
│                       curated index.json — schema v2                          │
│   SERVERKIT_REGISTRY_URL (unset → GitHub raw; set-but-empty → disabled)        │
└───────────────────────────────┬───────────────────────────────────────────────┘
                                │ fetch (TTL 1h)
                                │ fallback: last-good cache → app/data/registry_index.json
                                ▼
┌───────────────────────────────────────────────────────────────────────────────┐
│                          MARKETPLACE (panel UI)                               │
│   preview → show permissions + sha256 → operator consents → install           │
└───────────────────────────────┬───────────────────────────────────────────────┘
                                │ download zip, verify sha256 BEFORE extract
                                ▼
        ┌───────────────────────┴───────────────────────┐
        │                                               │
        ▼  (a) COPY-INSTALLED                           ▼  (b) FLAGSHIP / IN-PLACE
┌────────────────────────────────┐          ┌────────────────────────────────────┐
│ backend/**  → app/plugins/<s>/ │          │ builtin-extensions/<slug>/         │
│ frontend/** → src/plugins/<s>/ │          │   loaded via importlib spec,       │
│                                │          │   NO file copy; seeded every boot  │
└───────────────┬────────────────┘          └───────────────┬────────────────────┘
                │                                           │
                └─────────────────┬─────────────────────────┘
                                  ▼
                    ┌──────────────────────────────┐
                    │  import app.plugins.<slug>   │
                    │  register blueprint          │
                    │  + models / jobs / sockets   │
                    │  + before_request 503 guard  │  ← makes disable take effect
                    └──────────────────────────────┘
```

</details>

### Manifest

Every extension ships a `plugin.json`. Required: `name` (slug), `display_name`,
`version`. Notable optional keys:

- `entry_point` — `"module:blueprint_attr"`, mounted at `url_prefix`
  (default `/api/v1/<slug>`)
- `models`, `lifecycle` (`install`/`upgrade`/`uninstall` hooks)
- `jobs[]` and `schedules[]` — declaratively wired into the job system
- `permissions[]`, `config_schema`, `templates[]`
- `contributions{ nav, routes, tabs, command_palette, widgets, layouts, ai }`

The canonical spec is served live at `GET /api/v1/plugins/manifest-spec`.

### Two install classes

**(a) Flagship / in-place** — source stays in `builtin-extensions/<slug>/` and is
imported directly via an `importlib` spec injected as `app.plugins.<slug>`. No
copy. Re-seeded on every boot; "uninstall" writes a marker so the seeder skips it.

**(b) Copy-installed** — the zip is extracted into `backend/app/plugins/<slug>/`
and `frontend/src/plugins/<slug>/`. This covers registry installs *and*
non-flagship bundled extensions.

> **Working on a copy-installed builtin?** Edit **both** the source in
> `builtin-extensions/<slug>/` and the live copy under `app/plugins/<slug>/`, or
> the next reinstall reverts you. Sync frontends with `sync-builtin-frontends.mjs`.

### In-repo extensions

Source lives in this repo under `builtin-extensions/`:

| Slug | Class | Notes |
|---|---|---|
| `serverkit-wordpress` | Flagship, in-place | Seeded only if the setup wizard selects it |
| `serverkit-cloudflare-ops` | Flagship, in-place | Route-only, no sidebar entry |
| `serverkit-ftp` | Copy-installed builtin | Auto-installs on upgrade |
| `serverkit-cloud-provision` | Copy-installed builtin | Auto-installs on upgrade |
| `serverkit-remote-access` | Copy-installed builtin | Auto-installs on upgrade |
| `serverkit-status` | Copy-installed builtin | Auto-installs on upgrade |
| `serverkit-email` | Copy-installed builtin | Gated — auto-installs only if mail rows exist |
| `serverkit-git` | Marketplace one-click | Frontend-only, no backend |
| `serverkit-localkit` | Marketplace one-click | Backend-only, no frontend |

### Standalone extension repos

These have their own repos and install from the registry as versioned,
sha256-pinned zips (`bundled: false`):

| Extension | Repo |
|---|---|
| Analytics | [jhd3197/serverkit-analytics](https://github.com/jhd3197/serverkit-analytics) |
| Automations (tramo) | [jhd3197/serverkit-tramo](https://github.com/jhd3197/serverkit-tramo) |
| CrowdSec | [jhd3197/serverkit-crowdsec](https://github.com/jhd3197/serverkit-crowdsec) |
| DNS Server | [jhd3197/serverkit-dns-server](https://github.com/jhd3197/serverkit-dns-server) |
| Faro | [jhd3197/serverkit-faro](https://github.com/jhd3197/serverkit-faro) |
| GPU Monitor | [jhd3197/serverkit-gpu](https://github.com/jhd3197/serverkit-gpu) |
| Agent GUI (beta) | [jhd3197/serverkit-gui](https://github.com/jhd3197/serverkit-gui) |
| Kubernetes | [jhd3197/serverkit-k8s](https://github.com/jhd3197/serverkit-k8s) |
| Mail Server | [jhd3197/serverkit-mail](https://github.com/jhd3197/serverkit-mail) |

Supporting repos:

| Repo | Role |
|---|---|
| [jhd3197/serverkit-extensions](https://github.com/jhd3197/serverkit-extensions) | The curated registry `index.json` |
| [jhd3197/serverkit-agent](https://github.com/jhd3197/serverkit-agent) | The Go fleet agent |
| [jhd3197/Tramo](https://github.com/jhd3197/Tramo) | The automation engine the Automations extension embeds |

> **Retired.** The old drag-and-drop **Workflow Builder** (`serverkit-workflows`)
> no longer exists. It was replaced by the **Automations** extension, which runs
> workflows in a managed tramo container rather than parsing a graph in-panel;
> the panel proxies runs, approvals, and inbound webhooks. `/workflow` redirects
> to `/automations`, and the retired slug is swept on upgrade.

### Permissions

Declared in `plugin.json`, enforced by `plugins_sdk.permissions.require(slug, cap)`.
Known capabilities: `docker`, `filesystem`, `shell`, `network`, `db`, plus
namespaced `agent.command:<action>`. Unknown strings are surfaced in the consent UI.

**This is a consent gate, not a sandbox.** An extension that imports a host
module directly bypasses it. The security posture is: curated registry +
sha256 pinning + install-time consent + auditable source — *not* isolation.

### SDK

Backend (`app.plugins_sdk`): `db`, JWT helpers, `current_user()`, `logger`,
`audit`, `config(slug)`, plus `ai`, `permissions`, `sockets`, `queue`, `notify`,
and `jobs` façades.

Frontend (`frontend/src/plugins/sdk`): versioned (`SDK_VERSION`), pinned by each
extension's `sdk_version`. Exports `api`, design-system primitives (`KpiBand`,
`MetricCard`, `DataTable`, `ResourceList`, `Drawer`, `PageTopbar`, …), hooks
(`useToast`, `useAuth`, `useTheme`, `useServerkitAI`), and router helpers.

> **AI is core, not an extension.** The assistant lives in `app/services/ai_service.py`
> + `app/api/ai.py` + `contexts/AIContext.jsx`. Extensions *extend* it by
> registering tools and context through `plugins_sdk.ai` and the manifest's
> `contributions.ai`.

---

## Template System

![Template system: two source directories — the shipped catalog of 100+ YAML files in
backend/templates/ and the installer-populated, operator-writable
/etc/serverkit/templates/ — are merged by TemplateService, which resolves each
template as either kind:compose (a docker-compose stack) or kind:repo (build from
git); both converge on the same deployment sequence — allocate a port, render the
compose file, create the app and its nginx vhost, and optionally issue
SSL.](images/architecture/template-lifecycle.png)

<details>
<summary>ASCII diagram</summary>

```
┌──────────────────────────────┐        ┌──────────────────────────────┐
│  SHIPPED CATALOG (in repo)   │        │  OPERATOR TEMPLATES          │
│  backend/templates/*.yaml    │        │  /etc/serverkit/templates/   │
│  100+ templates              │        │  installer-populated + local │
└──────────────┬───────────────┘        └──────────────┬───────────────┘
               │                                       │
               └──────────────────┬────────────────────┘
                                  ▼
                     ┌────────────────────────┐
                     │    TemplateService     │
                     │  merges both dirs      │
                     └───────────┬────────────┘
                                 │
                 ┌───────────────┴───────────────┐
                 ▼                               ▼
        ┌─────────────────┐            ┌──────────────────┐
        │  kind: compose  │            │   kind: repo     │
        │  docker-compose │            │  build from git  │
        └────────┬────────┘            └────────┬─────────┘
                 └──────────────┬───────────────┘
                                ▼
                   ┌─────────────────────────┐
                   │  allocate port          │
                   │  render compose         │
                   │  create app + nginx     │
                   │  vhost + optional SSL   │
                   └─────────────────────────┘
```

</details>

`TemplateService` reads from **two** directories and merges them: the shipped
catalog in `backend/templates/` (the source of truth, 100+ YAML files) and the
operator-writable `/etc/serverkit/templates/` that the installer populates.

Two template kinds: `kind: compose` (the vast majority — a rendered
docker-compose stack) and `kind: repo` (build from a git repository). Schema
reference: [TEMPLATE_CATALOG_SCHEMA.md](TEMPLATE_CATALOG_SCHEMA.md).

---

## Port Allocation

`TemplateService._find_available_port()` resolves the starting port in priority order:

1. The global `managed_app_base_port` setting, when set to a non-zero value
2. The template's own `default` port
3. `8000` as the fallback

From there it scans upward, skipping any port that is already assigned in the
panel database, already published by a Docker container, or fails a live
`bind()` test on `127.0.0.1`. Ports below 1024 are always skipped. If no port is
found within the attempt budget, it falls back to a random high port.

---

## Service Linking & Env Injection

There is **no** fixed set of injected variable names. Database env var names are
chosen by the template or manifest author, because they have to match what the
image actually expects — `wordpress.yaml` emits `WORDPRESS_DB_HOST` /
`WORDPRESS_DB_USER`, a Postgres stack emits `POSTGRES_*`, and so on.

What ServerKit provides is **reference resolution at injection time**
(`env_reference_service.py`). A manifest declares a reference and ServerKit
resolves it when the container starts:

- `fromSecret` — pull the value out of a vault entry
- `fromService` — pull a field off a linked service: `connectionString`, `host`,
  `port`, `database`, `username`, `password`

```yaml
environment:
  MY_APP_DB_URL:
    fromService: { name: app-postgres, field: connectionString }
  MY_APP_API_KEY:
    fromSecret: { vault: prod, key: stripe_api_key }
```

So the *value* is managed by ServerKit; the *name* is yours. See
[SERVERKIT_YAML.md](SERVERKIT_YAML.md).

---

## Jobs & Scheduling

![Jobs and scheduling: a producer calls JobService.enqueue(kind, payload), which
persists a Job row through its pending, running, succeeded and failed states and
publishes a thin {job_id} message onto the serverkit-system/jobs queue bus; the Job
row mirrors the final outcome back. The queue bus provides retry, backoff and
dead-lettering, and hands messages to a JobConsumer daemon thread that dispatches by
kind through a handler registry mapping kind to fn(job). A separate JobScheduler
daemon thread ticks every 15 seconds, reading ScheduledJob rows on cron or interval
cadence and enqueueing due work, so cadence lives in the database rather than in
code.](images/architecture/jobs-pipeline.png)

<details>
<summary>ASCII diagram</summary>

```
  producer                                                     handler registry
     │                                                         ┌───────────────┐
     │ JobService.enqueue(kind, payload)                       │ kind → fn(job)│
     ▼                                                         └───────┬───────┘
┌──────────┐   persist    ┌──────────────┐   publish {job_id}          │
│ Job row  │◀────────────▶│  QUEUE BUS   │────────────────────┐        │
│ pending  │   mirror     │ serverkit-   │                    │        │
│ running  │   outcome    │ system/jobs  │  retry / backoff   │        │
│ succeeded│              └──────────────┘  dead-letter       ▼        ▼
│ failed   │                                          ┌──────────────────────┐
└──────────┘                                          │    JobConsumer       │
                                                      │  (daemon thread)     │
     ▲                                                └──────────────────────┘
     │ enqueue due work
┌──────────────────┐
│  JobScheduler    │  15s tick — reads ScheduledJob rows (cron / interval)
│  (daemon thread) │  cadence lives in the DB, not in code
└──────────────────┘
```

</details>

All background work funnels through one abstraction. A producer calls
`JobService.enqueue(kind, payload)`, which persists a `Job` row
(`pending → running → succeeded | failed | cancelled`, with `attempts`,
`priority`, `owner_type`/`owner_id`, `correlation_id`) and publishes a thin
`{'job_id': ...}` message onto the Queue Bus. Retry, backoff, and dead-lettering
are inherited from the bus; the Job row mirrors the outcome so there is a single
place to observe every background operation.

A single `JobConsumer` daemon thread polls and dispatches by `kind` through an
in-process handler registry. A single `JobScheduler` (15s tick) replaced the old
per-domain `while True: sleep` threads — it enqueues a Job for every due
`ScheduledJob` row, so adding or pausing periodic work is a database change, not
a code change.

Extensions plug in via `jobs.register(kind, handler)` / `jobs.enqueue()` /
`jobs.schedule()`, or declaratively through the manifest's `jobs[]` and
`schedules[]` blocks — which are paused and resumed alongside the extension
itself. The whole system is a no-op under the testing config so the suite can
drive handlers directly.

> Don't force real-time streams (live metrics, log tailing, terminal) into jobs —
> those belong on Socket.IO.

---

## Notifications Bus

![Notifications bus: a non-blocking notify.send(event, to, data) call writes a durable
Notification plus one NotificationDelivery per recipient-times-channel, then publishes
onto the serverkit-system/notifications queue bus, which supplies retry, backoff and
dead-lettering. A NotificationConsumer daemon thread renders each delivery — looking up
presentation defaults in the catalog, which maps an event_key to title, template,
severity and preference category — and dispatches through an adapter registry of core
channels: inapp, email, discord, slack, telegram and webhook, with extensions able to
register SMS or web-push. Digestable and quiet-hours deliveries branch off instead to
status queued_digest and are never enqueued; an hourly ScheduledJob groups them into
one branded email, on an off, daily or weekly
cadence.](images/architecture/notifications-bus.png)

<details>
<summary>ASCII diagram</summary>

```
  notify.send('backup.completed', to='admins', data={...})   ← non-blocking
     │
     ▼
┌──────────────────────────────────────────┐
│  Notification  +  NotificationDelivery   │   one delivery per (recipient × channel)
└──────────────────┬───────────────────────┘
                   │ publish
                   ▼
        ┌──────────────────────────┐
        │        QUEUE BUS         │  serverkit-system/notifications
        │  retry / backoff / DLQ   │
        └────────────┬─────────────┘
                     ▼
        ┌──────────────────────────┐        ┌────────────────────────┐
        │  NotificationConsumer    │───────▶│   CATALOG              │
        │  (daemon thread)         │        │ event_key → title,     │
        │  render → dispatch       │        │ template, severity,    │
        └────────────┬─────────────┘        │ preference category    │
                     │                      └────────────────────────┘
     ┌───────────────┼───────────────┬───────────────┬──────────────┐
     ▼               ▼               ▼               ▼              ▼
 ┌────────┐    ┌──────────┐   ┌──────────┐   ┌──────────┐   ┌──────────┐
 │ inapp  │    │  email   │   │ discord  │   │ telegram │   │ webhook  │  + slack
 └────────┘    └──────────┘   └──────────┘   └──────────┘   └──────────┘

  digestable / quiet-hours deliveries ──▶ status: queued_digest (never enqueued)
                                              │
                                              ▼  hourly ScheduledJob
                                    one grouped, branded email → sent
```

</details>

`notify.send(event, to, data)` is non-blocking: it writes a durable
`Notification` plus one `NotificationDelivery` per (recipient × channel),
enqueues them, and returns. A background consumer renders each delivery and
hands it to the matching channel adapter.

Channels are a pluggable key→adapter registry (`inapp`, `email`, `discord`,
`slack`, `telegram`, `webhook`); `register_adapter()` lets an extension add SMS
or web-push and have it delivered exactly like a core channel. The **catalog**
maps each `event_key` to its presentation defaults — title, template, severity,
and preference category (`system` | `security` | `backups` | `apps`) — and
`catalog.register()` lets a plugin event render through the identical pipeline.

**Digests** are the per-user cadence layer. Digestable deliveries and
quiet-hours catch-ups are parked at `queued_digest` and never enqueued; an
hourly scheduled job groups a user's held rows into one branded email. Cadence
is `off` | `daily` | `weekly` per user. Contract:
[NOTIFICATIONS_CONTRACT.md](NOTIFICATIONS_CONTRACT.md).

---

## Agent Fleet

![Agent fleet: inside the ServerKit panel, two endpoints accept agent connections —
app/agent_gateway.py serving the Socket.IO /agent namespace, and app/api/agent_poll.py
providing an HTTP long-poll fallback. Both feed a single in-memory agent_registry
holding live agents, the socket-to-server index, session tokens and in-flight command
queues, marked SINGLE PROCESS. The panel talks to remote managed servers — each running
a Go agent — over HMAC auth, heartbeat plus metrics, and command routing. The agent
binary is maintained in the separate serverkit-agent repo, so panel-to-agent protocol
changes are not atomic in one commit.](images/architecture/agent-fleet.png)

<details>
<summary>ASCII diagram</summary>

```
┌──────────────────────────────────────────────────────────────────┐
│                        SERVERKIT PANEL                           │
│                                                                  │
│   app/agent_gateway.py                app/api/agent_poll.py      │
│   Socket.IO /agent namespace          HTTP long-poll fallback    │
│              │                                  │                │
│              └──────────────┬───────────────────┘                │
│                             ▼                                    │
│              ┌──────────────────────────────┐                    │
│              │   agent_registry (in-memory) │  ⚠ SINGLE PROCESS  │
│              │   live agents, socket↔server │                    │
│              │   index, session tokens,     │                    │
│              │   in-flight command queues   │                    │
│              └──────────────────────────────┘                    │
└─────────────────────────────┬────────────────────────────────────┘
                              │ HMAC auth, heartbeat + metrics, command routing
          ┌───────────────────┼───────────────────┐
          ▼                   ▼                   ▼
   ┌────────────┐      ┌────────────┐      ┌────────────┐
   │  server A  │      │  server B  │      │  server C  │
   │ Go agent   │      │ Go agent   │      │ Go agent   │
   └────────────┘      └────────────┘      └────────────┘
```

</details>

The panel manages remote servers through a fleet of Go agents. The agent binary
is maintained in the separate
[`serverkit-agent`](https://github.com/jhd3197/serverkit-agent) repo — agent-side
capability changes ship there, so panel↔agent protocol changes are **not** atomic
in one commit. Coordinate with [FLEET_CONTRACT.md](FLEET_CONTRACT.md).

Agents connect over the Socket.IO `/agent` namespace (HMAC-authenticated,
heartbeat + metrics + command routing), with an HTTP long-poll fallback for
networks where WebSocket is blocked.

> ### ⚠️ Deployment constraint — single WebSocket worker
>
> The agent gateway keeps **all** connected-agent state — the live-agent
> registry, the socket↔server index, session tokens, and in-flight command
> queues — **in memory in one process**.
>
> Run the panel with a **single** gunicorn worker using a plain threaded worker:
> `-w 1 --threads N`. WebSocket is served by simple-websocket to match
> `async_mode='threading'`; the **gevent-websocket worker class double-answers
> the WS handshake and breaks WebSocket**.
>
> Scaling to multiple workers without a shared backplane (e.g. a Redis message
> queue) will silently misroute or drop commands for agents connected to a
> different worker. See [HORIZONTAL_SCALING_SPEC.md](HORIZONTAL_SCALING_SPEC.md)
> and [SECURITY.md](../SECURITY.md).

---

## Environment Pipeline

Dev/staging/production workflows for managed WordPress sites.

![Environment pipeline: three environments — dev, staging and production, each holding
its own WordPress install, database and files/media, on its own hostname. Promotion
pushes upward from a lower environment to a higher one via promote_code,
promote_database and promote_full. Sync pulls in the opposite direction:
sync_from_production brings the latest production database and media down to staging or
dev for testing, with sensitive user data stripped automatically during the sync. The
engine is environment_pipeline_service.py in core, driven by a job handler, with the
HTTP routes living in the serverkit-wordpress
extension.](images/architecture/environment-pipeline.png)

<details>
<summary>ASCII diagram</summary>

```
┌──────────────┐ promotion  ┌──────────────┐ promotion  ┌──────────────┐
│     DEV      │───────────▶│   STAGING    │───────────▶│  PRODUCTION  │
│ (Standalone) │            │ (Standalone) │            │ (Production) │
└──────┬───────┘            └──────┬───────┘            └──────┬───────┘
       │                           │                           │
       └─────────── sync ──────────┴─────────── sync ──────────┘
```

</details>

- **Promotion** — push code (git) and/or database from a lower environment to a
  higher one: `promote_code`, `promote_database`, `promote_full`.
- **Syncing** — `sync_from_production` pulls the latest production database and
  media down to dev/staging for testing.
- **Sanitization** — sensitive user data is stripped automatically during sync.

The engine is `environment_pipeline_service.py` in core, driven by a job handler;
the HTTP routes live in the **serverkit-wordpress** extension. Details:
[MULTI_ENVIRONMENT.md](MULTI_ENVIRONMENT.md).

---

## File Paths

Every path below is defined in `backend/app/paths.py` and each is overridable by
the matching environment variable — the values shown are the production defaults.

```
/var/serverkit/                     # SERVERKIT_DIR — data root
├── apps/                           # deployed applications
└── deployments/                    # deployment working dirs

/etc/serverkit/                     # SERVERKIT_CONFIG_DIR
├── templates/                      # operator template library (YAML)
├── email/                          # mail server config
├── install-state.json              # written by the installer
└── ssl-mode                        # nginx SSL mode flag

/var/backups/serverkit/             # SERVERKIT_BACKUP_DIR
├── databases/
├── wordpress/
└── snapshots/

/var/log/serverkit/                 # SERVERKIT_LOG_DIR
└── builds/                         # build logs

/var/cache/serverkit/               # SERVERKIT_CACHE_DIR
├── builds/
└── wp-plugins/

/var/quarantine/                    # SERVERKIT_QUARANTINE_DIR
/var/vmail/                         # VMAIL_DIR — mail storage

<install-dir>/nginx/ssl/            # nginx TLS material
```

Notes:

- **The panel has no `config.yaml`.** Panel configuration is `backend/config.py`
  plus environment variables / `.env`. The only `config.yaml` in the ecosystem
  belongs to the *agent*, at `/etc/serverkit-agent/config.yaml`.
- Backups live under `/var/backups/serverkit`, **not** under `/var/serverkit/`.
- Always import from `app.paths` rather than hardcoding — the env overrides are
  what let the test suite and local dev run off-root.

---

## Troubleshooting

See the [Deployment Guide](DEPLOYMENT.md) for 502 errors, container failures, and
networking issues.

---

## See Also

- [Installation Guide](INSTALLATION.md)
- [Local Development](LOCAL_DEVELOPMENT.md)
- [API Reference](API.md)
- [Deployment Guide](DEPLOYMENT.md)
- [Extensions](EXTENSIONS.md) · [Registry](EXTENSIONS_REGISTRY.md)
- [Fleet Contract](FLEET_CONTRACT.md)
- [serverkit.yaml Reference](SERVERKIT_YAML.md)
