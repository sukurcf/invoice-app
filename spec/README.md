# Invoice Exception Assistant — Specification

> Applies to application version **1.0.0** · last reviewed **2026-10-02**

This folder explains **everything about the Invoice Exception Assistant**: what it is for, how it behaves, how it
is built, how it is secured, tested and operated, and where its limits are. It is written to be read by product
owners, developers, operators and auditors.

The application is a self-hosted accounts-payable workspace. Reviewers enter supplier invoices, the server
compares each one with its purchase order and goods receipt (a *three-way match*), every mismatch becomes an
**exception**, only exception-free invoices can be **approved**, and approved invoices are released in immutable
**CSV export batches** — with a complete, tamper-resistant audit trail kept in PostgreSQL.

## Quick facts

| | |
| --- | --- |
| **Name / version** | `invoice-exception-assistant` 1.0.0 |
| **Stack** | TypeScript · React 18 + Vite · Express 5 · PostgreSQL 18 · Docker Compose + Caddy (automatic HTTPS) |
| **Model** | One finance team per deployment; administrator and reviewer roles; admin-created accounts only |
| **Develop** | `npm run dev` → UI on `http://localhost:5173`, API on `127.0.0.1:3000` |
| **Deploy** | `docker compose --env-file .env.production up -d --build`, then create the first administrator with the CLI |
| **Verify** | `npm run check` (lint, build, coverage-gated unit/UI and API tests) and `npm run test:e2e` |
| **Tests** | 147 in total: 90 unit/UI · 53 API integration on **real PostgreSQL** · 4 browser tests |
| **Not connected** | OCR, AI, e-mail, ERP, bank/payment systems — a CSV file is the only output |

## Document map

| # | Document | Answers | Read it if you are… |
| --- | --- | --- | --- |
| 1 | [Product overview](./01-product-overview.md) | What is it, for whom, why; roles; features; journeys; what it deliberately does not do; history | everyone |
| 2 | [Architecture](./02-architecture.md) | Components, tech stack, repository layout, code boundaries, build, runtime, request lifecycle, design decisions, npm scripts and every config file | a developer or architect |
| 3 | [Domain model](./03-domain-model.md) | Entities, every field limit, statuses, money, dates, normalization, immutability, sample data | a developer, tester or analyst |
| 4 | [Matching and exceptions](./04-matching-and-exceptions.md) | Every rule, exact definitions, worked examples, status derivation, quirks, how to change rules | an analyst, tester or developer |
| 5 | [Invoice lifecycle](./05-invoice-lifecycle.md) | State machine, transitions, versioning, idempotency, locking, exports, accounts, history, **system invariants** | a developer, auditor or tester |
| 6 | [Data and persistence](./06-data-and-persistence.md) | Tables and constraints, JSONB shapes, indexes, triggers, migrations, database roles | a developer, DBA or operator |
| 7 | [API reference](./07-api-reference.md) | Every endpoint, limits, error codes, calling it from a script | a developer or integrator |
| 8 | [Security](./08-security.md) | Threat model, authentication, sessions, CSRF, headers, uploads, hardening, **known gaps** | a security reviewer or operator |
| 9 | [Frontend](./09-frontend.md) | Boot sequence, routes, state, screens, components, accessibility, responsiveness | a front-end developer or designer |
| 10 | [Configuration and deployment](./10-configuration-and-deployment.md) | Environment variables, environments, production topology, CLI, CI | an operator or developer |
| 11 | [Testing and quality](./11-testing-and-quality.md) | Strategy, inventory of all tests, infrastructure, gates, what is *not* tested | a developer or QA engineer |
| 12 | [Operations](./12-operations.md) | Health, logs, alerting, backup/restore, capacity, incident playbooks | an operator |
| 13 | [Limitations and roadmap](./13-limitations-and-roadmap.md) | Scope limits, known quirks, suggestions, decisions to take before go-live | a product owner or decision-maker |
| – | [Glossary](./glossary.md) | Definitions of the terms used throughout | everyone |

## Suggested reading paths

- **"What does this do?"** → 1 → 4 → 5 (state machine only) → 13.
- **"I'm going to change the code."** → 2 → 3 → 4 → 5 → 7 → 11, then 6 and 9 as needed.
- **"I'm deploying and running it."** → 10 → 12 → 8 (§8.14 checklist) → 6 (§6.7–§6.8).
- **"I'm assessing risk or doing an audit."** → 8 → 5 (§5.9 invariants) → 6 (§6.5, §6.8) → 13.
- **"I'm writing integrations or tests."** → 7 → 3 → 11.

## How this specification relates to the rest of the repository

| Location | Purpose |
| --- | --- |
| [`README.md`](../README.md) | Quick start, configuration summary and launch checklist |
| [`docs/`](../docs) | Task-oriented guides: [API summary](../docs/api.md), [operations runbook](../docs/operations.md), [test guide](../docs/testing.md) |
| **`spec/` (here)** | The explanatory reference: what the system *is*, how and why it behaves as it does |
| Source code and tests | **The authoritative truth.** If this specification and the code disagree, the code wins — then please correct the document |

## Conventions

- **"must" / "never"** describe behavior enforced by code or the database; **"should"** and *guidance* describe
  recommendations; **roadmap** items are suggestions only.
- File and symbol references are relative links; line numbers are avoided because they drift.
- Diagrams are [Mermaid](https://mermaid.js.org), rendered by GitHub and most Markdown viewers.
- Spelling is American English; money is USD; times are UTC unless stated.
- Section numbers match the document number (`§5.5` is section 5.5 of document 5), and are used for cross-references.

### Facts verified by execution (2026-10-02)

Statements that are easy to get wrong from reading code alone were checked against a running system:

- the complete set of HTTP response headers and cookie attributes in development/test and production modes
  ([§8.4](./08-security.md#84-sessions-cookies-and-csrf), [§8.9](./08-security.md#89-http-security-headers-and-browser-protections));
- the rule engine's exact output for each sample invoice, price-boundary case, reservation scenario and empty draft
  ([§3.12](./03-domain-model.md#312-sample-dataset), [§4.5](./04-matching-and-exceptions.md#45-worked-examples));
- the CSV bytes, including the download-time byte-order mark ([§5.6](./05-invoice-lifecycle.md#56-export-batches));
- the behavior of a write blocked by the global lock — `500 INTERNAL_ERROR` after 15.0 s, no partial change, a
  clean retry — and how the lock appears in `pg_locks` ([§5.5](./05-invoice-lifecycle.md#55-concurrency-control),
  [§12.2](./12-operations.md#122-observability));
- the per-file test counts and coverage figures ([§11](./11-testing-and-quality.md));
- the GitHub Actions pipeline on the initial push, including the container build, stack startup, Caddyfile
  validation and in-container smoke test — all steps passed ([§10.10](./10-configuration-and-deployment.md#1010-continuous-integration)).

## Keeping the specification accurate

When you change the system, update the matching document in the same change:

| If you change… | Update |
| --- | --- |
| A matching rule or constant | [§4](./04-matching-and-exceptions.md), [§3.12](./03-domain-model.md#312-sample-dataset) if sample output changes |
| A field limit or schema | [§3](./03-domain-model.md), [§6](./06-data-and-persistence.md), [§7](./07-api-reference.md) |
| A workflow, status or transition | [§5](./05-invoice-lifecycle.md) (including the invariants), [§1](./01-product-overview.md) |
| An endpoint, header or error code | [§7](./07-api-reference.md), [`docs/api.md`](../docs/api.md) |
| Authentication, headers or hardening | [§8](./08-security.md) |
| A screen, route or component | [§9](./09-frontend.md) |
| An environment variable, Compose file or CI step | [§10](./10-configuration-and-deployment.md), the README table |
| Tests or coverage thresholds | [§11](./11-testing-and-quality.md), [`docs/testing.md`](../docs/testing.md) |
| Operational behavior | [§12](./12-operations.md), [`docs/operations.md`](../docs/operations.md) |
| A limitation or a roadmap item delivered | [§13](./13-limitations-and-roadmap.md) |
