# 13. Limitations and roadmap

> Part of the [Invoice Exception Assistant specification](./README.md). Applies to version **1.0.0**.

An honest account of what the application does **not** do, the rough edges in the current implementation, and
suggestions for what to build next. Nothing in the roadmap is committed; it is a list of sensible next steps
derived from the gaps below.

## 13.1 Scope limitations (by design)

| Area | Limitation | Why it matters |
| --- | --- | --- |
| **Tenancy** | One finance team per deployment; every active user sees all invoices, documents and exports; no per-supplier or per-user visibility | Unsuitable where staff must be segregated by entity, region or client |
| **Currency and amounts** | USD only; amounts ≥ 0 with at most two decimals; whole-unit quantities; ≤ 100 lines; totals ≤ 100 million | No credit notes, foreign currency, fractional units or very large documents |
| **Matching model** | One PO and one goods receipt per invoice; SKU-level matching; fixed 5 % price tolerance; no quantity tolerance | Split deliveries, multi-PO invoices and negotiated tolerances need workarounds |
| **Extraction** | No OCR, no AI; all fields are typed manually | Data entry effort and typo risk remain with people |
| **Notifications and integrations** | No e-mail; no ERP, bank or payment connection; export is a CSV file | "Request correction" tells nobody; "exported" is not proof of import |
| **Reference data** | Suppliers, POs and receipts can be created, never edited or deleted; no import tool | A typo needs a replacement record and relinking of unapproved invoices |
| **Documents** | Attach only at creation (no replace/remove); PDF/PNG/JPEG ≤ 10 MiB; no viewer, no malware scan | Corrections need a new invoice; scanning is the user's responsibility |
| **Approvals** | No two-person rule, thresholds or delegation; a reviewer can approve their own invoice | May fall short of internal-control requirements |
| **Identity** | Local accounts only; no MFA, SSO, self-service reset, or e-mail verification | Higher credential risk than a managed identity provider |
| **Retention and privacy** | No deletion, archival, purge, legal-hold or erasure tooling | Regulated or personal data needs a separate process |
| **Availability** | Single host and database; no HA, failover or PITR in the supplied stack | Plan for downtime and tested restores |
| **Throughput** | All finance writes serialized by one lock ([§5.5](./05-invoice-lifecycle.md#55-concurrency-control)) | Suits a small team; not high-volume ingestion |
| **Accessibility and i18n** | No audit; English/US formats only; Chromium-only automated testing | Verify against your policy before wide rollout |
| **API** | Internal and unversioned; no OpenAPI description, webhooks or API keys | Not ready for third-party integration |

## 13.2 Known quirks and trade-offs

Real properties of the current code, none of which compromise the safety guarantees in
[§5.9](./05-invoice-lifecycle.md#59-system-invariants), listed so nobody has to discover them by surprise.

**Matching and workflow**

1. **Overlapping evidence.** One underlying gap can raise several exceptions (an empty invoice number raises
   `required-number` *and* `missing-Invoice number`; an unknown SKU can raise three). See
   [§4.8](./04-matching-and-exceptions.md#48-overlaps-and-quirks).
2. **Evidence and line IDs change on every save**, because line items are regenerated. Evidence IDs are stable
   only within one version, and old history snapshots show the old line IDs.
3. **Only the first duplicate is cited**, even when several exist.
4. **The status label can lag reality.** It is recomputed only when *that invoice* is saved; the dashboard
   counts use the label while the review page and queue show live evidence. Approval and export always re-check.
5. **Reopening always sets `needs_review`**, even if the invoice is clean; it can be approved again directly.
6. **A voided invoice is permanent**; there is no un-void. An exported invoice cannot be corrected, reopened or
   re-exported.
7. **An approved invoice's linked PO/receipt cannot be repointed** without an administrator reopening it first.
8. **Receipt quantities count against the PO** whether or not any invoice uses them, and there is no way to
   reverse a receipt.

**API and data**

9. **`GET /<reference>/:id` returns `422 INVALID_REFERENCE`** for an unknown ID, not `404` (the lookup helper is
   shared with validation of invoice references).
10. **Scripts must send an `Origin` header** on every unsafe request, because the check treats a missing header as
    a mismatch ([§7.2](./07-api-reference.md#72-calling-the-api-from-a-script)).
11. **Reads are not snapshot-consistent.** A response assembled from several queries can reflect a write that
    landed in between. Writes are unaffected.
12. **CSV details:** rows follow invoice-ID order, the `Status` column is always `Ready to export`, there is no
    trailing newline, and the stored text has no BOM (the download adds it).
13. **The `UNRESOLVED_EXCEPTIONS` error carries the full evidence list in `details`**, but the web UI ignores it
    (the page already shows live evidence).
14. **Seed data differs from real data.** Only the sample dataset has `demo_extraction` provenance and
    confidence values; manual entry never produces confidence.

**Accounts and security**

15. **Targeted sign-in throttling:** ten bad attempts against an e-mail address block *new* sign-ins for that
    user for up to 15 minutes ([§8.13](./08-security.md#813-known-gaps-and-residual-risks)).
16. **Login does not revoke earlier sessions**; only password changes and administrator actions do.
17. **The "last administrator" guard (`LAST_ADMIN`) cannot normally trigger**, because the acting administrator
    is always an active administrator who is excluded from the change. It is defense in depth.
18. **Password changes hold the global write lock while hashing**, briefly delaying other writes.

**Operations**

19. **Lock contention surfaces as `500`.** A write that cannot obtain the global lock within 15 s fails with a
    generic `INTERNAL_ERROR` (verified); it is safe to retry.
20. **Migrations are all-or-nothing in one transaction**, ignore badly named files, and an older application
    image against a newer schema is **not** detected ([§6.7](./06-data-and-persistence.md#67-migrations)).
21. **Docker logs are not rotated**, and `unhealthy` containers are not restarted automatically.
22. **Repository leftovers:** `images/` shows the retired 0.1.0 demo UI and `pgm.py` is an unrelated stub
    ([§1.8](./01-product-overview.md#18-product-history)); the local workspace is not a Git repository.

## 13.3 Roadmap suggestions

Unordered within each theme; **not commitments**.

### Security and identity

| Suggestion | Rationale |
| --- | --- |
| MFA and/or OIDC single sign-on | Removes the largest credential risk; centralizes joiner/leaver control |
| Breached-password screening; session list and revoke; per-user session cap; sign-out-everywhere | Closes §8.13 items 2 and 4 |
| Tamper-evident audit (hash chain, or write-once export to external storage) | Moves from tamper-*resistant* to tamper-*evident* |
| Malware scanning / quarantine for uploads | Needed before accepting documents from untrusted senders |
| Image scanning, signing and digest pinning; TLS to the database by default | Supply-chain and transport hardening |
| `SECURITY.md` with a disclosure process; periodic penetration testing | Governance |

### Workflow and controls

| Suggestion | Rationale |
| --- | --- |
| Two-person approval and amount thresholds by role | Segregation of duties |
| Configurable rules: tolerance per supplier/category, quantity tolerance, optional-warning severities | Real-world suppliers rarely fit one 5 % rule |
| Credit notes, multiple currencies, fractional quantities | Broader invoice coverage |
| Multiple POs/receipts per invoice; partial-delivery handling | Matches real receiving practice |
| Reference-data **supersession** (versioned corrections) and CSV import | Fixes typos without breaking evidence; speeds setup |
| Document replacement with version history; in-app viewer | Fewer re-entries; faster review |
| Comments, assignment and escalation targets; bulk actions | Collaboration at volume |

### Integrations

| Suggestion | Rationale |
| --- | --- |
| Extraction provider boundary (re-introduce the interface removed in 1.0.0) with confidence shown and reviewed | Reduces typing; the confidence rule already exists |
| ERP/accounting connectors, SFTP or webhook export, and an "imported/acknowledged" state | Closes the loop after "exported" |
| E-mail or chat notifications for corrections and escalations | Makes those statuses actionable |
| Versioned, documented API (OpenAPI) with API keys or OAuth client credentials | Enables safe third-party use |

### Platform and operations

| Suggestion | Rationale |
| --- | --- |
| Metrics and tracing (OpenTelemetry/Prometheus), IP-aware access logs, log shipping | Real observability |
| Automated backups with PITR, tested restores, HA PostgreSQL | Meets stricter recovery objectives |
| Documents in object storage; keyset pagination; trigram/full-text search | Scale with volume |
| Retention, archival and erasure tooling | Privacy and records-management compliance |
| Release process: `CHANGELOG`, tagged versions, published images, migration dry-run | Predictable upgrades |
| Load and soak testing; reduced lock scope if throughput demands it | Replace assumptions with measurements |

### Experience and quality

| Suggestion | Rationale |
| --- | --- |
| Accessibility audit (WCAG 2.2 AA) and automated a11y checks | Verified, not assumed |
| Localization (locale-aware dates, numbers, currency) | International teams |
| Cross-browser and visual-regression tests; mutation testing; fuzzing of parsers/validators | Broader safety net |
| Refresh the documentation screenshots (current `images/` show the retired demo) | Accurate documentation |

## 13.4 Decisions to take before go-live

Questions the organization, not the software, must answer:

1. Is a **single shared team** with full visibility acceptable? Is **no two-person approval** acceptable?
2. Are **local passwords without MFA** acceptable for the data and users involved?
3. Is the fixed **5 % price tolerance** and "no quantity tolerance" right for your suppliers?
4. How long must documents, history and exports be **retained**, and can they ever be erased?
5. Where do **backups** live, who may read them, and what recovery time and data-loss window are acceptable?
6. Who is the **operator**, and who watches the readiness endpoint, logs, certificates and disk?
7. How will CSV exports be **reconciled** with the downstream system, given that "exported" does not prove import?
8. Are uploaded documents from **trusted sources** only, or is malware scanning required first?
