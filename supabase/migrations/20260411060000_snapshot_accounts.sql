CREATE TABLE snapshot_accounts (
  user_id    uuid    NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  date       date    NOT NULL,
  account_id uuid    NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  balance    numeric NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, date, account_id)
);

-- Index for per-account time-series queries (e.g. "IBKR balance over 12 months")
CREATE INDEX snapshot_accounts_account_date_idx
  ON snapshot_accounts (account_id, date);

ALTER TABLE snapshot_accounts ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can manage their own snapshot_accounts"
  ON snapshot_accounts FOR ALL
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);
