CREATE TABLE bank_connections (
    id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id            uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    account_id         uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    eb_session_id      text NOT NULL,
    eb_account_uid     text NOT NULL,
    bank_name          text NOT NULL,
    consent_expires_at timestamptz,
    last_synced_at     timestamptz,
    status             text NOT NULL DEFAULT 'active',
    created_at         timestamptz NOT NULL DEFAULT now()
);

-- Row Level Security: users can only see their own rows
ALTER TABLE bank_connections ENABLE ROW LEVEL SECURITY;

CREATE POLICY bank_connections_owner ON bank_connections
USING (user_id = auth.uid());

-- Index for fast lookup by user
CREATE INDEX idx_bank_connections_user_id ON bank_connections(user_id);