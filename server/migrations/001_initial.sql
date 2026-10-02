CREATE TABLE users (
  id text PRIMARY KEY,
  email text NOT NULL UNIQUE CHECK (email = lower(email)),
  name text NOT NULL,
  password_hash text NOT NULL,
  role text NOT NULL CHECK (role IN ('admin', 'reviewer')),
  active boolean NOT NULL DEFAULT true,
  must_change_password boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE sessions (
  token_hash text PRIMARY KEY,
  user_id text NOT NULL REFERENCES users(id),
  csrf_token text NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX sessions_user_idx ON sessions(user_id);
CREATE INDEX sessions_expiry_idx ON sessions(expires_at);

CREATE TABLE rate_limits (
  key text PRIMARY KEY,
  attempts integer NOT NULL CHECK (attempts > 0),
  reset_at timestamptz NOT NULL
);
CREATE INDEX rate_limits_expiry_idx ON rate_limits(reset_at);

CREATE TABLE suppliers (
  id text PRIMARY KEY,
  name text NOT NULL,
  code text NOT NULL,
  location text NOT NULL DEFAULT ''
);
CREATE UNIQUE INDEX suppliers_code_idx ON suppliers(lower(code));

CREATE TABLE purchase_orders (
  id text PRIMARY KEY,
  po_number text NOT NULL,
  supplier_id text NOT NULL REFERENCES suppliers(id),
  ordered_date date NOT NULL,
  line_items jsonb NOT NULL CHECK (jsonb_typeof(line_items) = 'array' AND jsonb_array_length(line_items) BETWEEN 1 AND 100)
);
CREATE UNIQUE INDEX purchase_orders_number_idx ON purchase_orders(lower(po_number));
CREATE INDEX purchase_orders_supplier_idx ON purchase_orders(supplier_id);

CREATE TABLE delivery_records (
  id text PRIMARY KEY,
  delivery_number text NOT NULL,
  purchase_order_id text NOT NULL REFERENCES purchase_orders(id),
  received_date date NOT NULL,
  line_items jsonb NOT NULL CHECK (jsonb_typeof(line_items) = 'array' AND jsonb_array_length(line_items) BETWEEN 1 AND 100)
);
CREATE UNIQUE INDEX delivery_records_number_idx ON delivery_records(lower(delivery_number));
CREATE INDEX delivery_records_order_idx ON delivery_records(purchase_order_id);

CREATE TABLE export_batches (
  id text PRIMARY KEY,
  created_by text NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  request jsonb NOT NULL,
  invoice_ids jsonb NOT NULL,
  csv text NOT NULL
);

CREATE TABLE invoices (
  id text PRIMARY KEY,
  invoice_number text NOT NULL DEFAULT '',
  invoice_key text NOT NULL,
  supplier_id text REFERENCES suppliers(id),
  issue_date date,
  due_date date,
  purchase_order_id text REFERENCES purchase_orders(id),
  delivery_record_id text REFERENCES delivery_records(id),
  currency text NOT NULL DEFAULT 'USD' CHECK (currency = 'USD'),
  line_items jsonb NOT NULL CHECK (jsonb_typeof(line_items) = 'array' AND jsonb_array_length(line_items) <= 100),
  tax_cents bigint NOT NULL CHECK (tax_cents BETWEEN 0 AND 1000000000),
  total_cents bigint NOT NULL CHECK (total_cents BETWEEN 0 AND 10000000000),
  status text NOT NULL CHECK (status IN ('needs_review', 'possible_duplicate', 'matched', 'ready_to_export', 'correction_requested', 'escalated', 'exported', 'voided')),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  extracted_fields jsonb NOT NULL DEFAULT '[]',
  source_name text,
  source_type text CHECK (source_type IN ('application/pdf', 'image/png', 'image/jpeg')),
  document bytea CHECK (octet_length(document) BETWEEN 1 AND 10485760),
  export_batch_id text REFERENCES export_batches(id),
  created_by text NOT NULL REFERENCES users(id),
  request_fingerprint text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (due_date IS NULL OR issue_date IS NULL OR due_date >= issue_date),
  CHECK ((document IS NULL AND source_name IS NULL AND source_type IS NULL) OR
         (document IS NOT NULL AND source_name IS NOT NULL AND source_type IS NOT NULL))
);
CREATE INDEX invoices_queue_idx ON invoices(status, issue_date DESC, id);
CREATE INDEX invoices_duplicate_idx ON invoices(supplier_id, invoice_key) WHERE status <> 'voided';
CREATE INDEX invoices_order_idx ON invoices(purchase_order_id);
CREATE INDEX invoices_delivery_idx ON invoices(delivery_record_id);

CREATE TABLE invoice_history (
  id text PRIMARY KEY,
  invoice_id text NOT NULL REFERENCES invoices(id),
  version integer NOT NULL,
  action text NOT NULL CHECK (action IN ('created', 'updated', 'approved', 'correction_requested', 'escalated', 'reopened', 'exported', 'voided')),
  actor_id text REFERENCES users(id),
  actor_name text NOT NULL,
  detail text NOT NULL,
  snapshot jsonb NOT NULL,
  timestamp timestamptz NOT NULL DEFAULT now(),
  UNIQUE (invoice_id, version)
);
CREATE INDEX invoice_history_recent_idx ON invoice_history(timestamp DESC, id);

CREATE TABLE audit_events (
  id text PRIMARY KEY,
  action text NOT NULL,
  entity_id text NOT NULL,
  actor_id text REFERENCES users(id),
  actor_name text NOT NULL,
  detail text NOT NULL,
  timestamp timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_events_recent_idx ON audit_events(timestamp DESC, id);

CREATE FUNCTION deny_record_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'This record is immutable; create a new version or replacement instead';
END;
$$;

CREATE TRIGGER invoice_history_immutable BEFORE UPDATE OR DELETE ON invoice_history FOR EACH ROW EXECUTE FUNCTION deny_record_mutation();
CREATE TRIGGER audit_events_immutable BEFORE UPDATE OR DELETE ON audit_events FOR EACH ROW EXECUTE FUNCTION deny_record_mutation();
CREATE TRIGGER export_batches_immutable BEFORE UPDATE OR DELETE ON export_batches FOR EACH ROW EXECUTE FUNCTION deny_record_mutation();
CREATE TRIGGER purchase_orders_immutable BEFORE UPDATE OR DELETE ON purchase_orders FOR EACH ROW EXECUTE FUNCTION deny_record_mutation();
CREATE TRIGGER delivery_records_immutable BEFORE UPDATE OR DELETE ON delivery_records FOR EACH ROW EXECUTE FUNCTION deny_record_mutation();
CREATE TRIGGER suppliers_immutable BEFORE UPDATE OR DELETE ON suppliers FOR EACH ROW EXECUTE FUNCTION deny_record_mutation();
