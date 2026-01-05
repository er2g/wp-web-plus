# Security (Zero-Knowledge Storage)

This project implements **encryption-at-rest with a “zero-knowledge” key model**: the server stores ciphertext in SQLite, and the **encryption key is never written to disk** (not in the database, not in config files).

## Threat Model (What This Protects)

If an attacker steals `whatsapp.db` or gains read access to it, **messages/notes/contact details are cryptographically unreadable** without the user’s password.

This does **not** protect against:
- An attacker who has **live access to the running server process** while the vault is unlocked (keys are in RAM during an authenticated session).
- A compromised client/browser where the user types their password.

## Encryption at Rest

- **Algorithm:** AES-256-GCM
- **IV:** 12 bytes (random per field value)
- **Auth tag:** 16 bytes
- **Format:** `enc:v1:<base64(iv|tag|ciphertext)>`
- **AAD:** bound to `(accountId, table, column)` to prevent cross-field swapping.

### Encrypted Fields (Current)

The backend encrypts/decrypts transparently in `database.js`.

- `messages`: `body`, `quoted_body`, `from_name`, `quoted_from_name`, `from_number`, `to_number`
- `notes`: `content`
- `contacts`: `name`, `phone`
- `chats`: `name`, `last_message`
- `auto_replies`: `trigger_word`, `response`
- `message_templates`: `content`, `variables`
- `scheduled_messages`: `chat_name`, `message`
- `users`: `preferences`, `ai_api_key`

After migration, you should be able to open the SQLite file and see random-looking ciphertext in these columns.

## Key Hierarchy (True Zero-Knowledge)

This project supports an **envelope-key** model for multi-user “true zero-knowledge”:

- **KEK (Key Encryption Key):** derived from the user’s password (PBKDF2) and kept only in RAM.
- **DEK (Data Encryption Key):** random 32-byte per-account key used to encrypt all sensitive data at rest.
- **Wrapping:** The DEK is stored in SQLite **only as ciphertext**, wrapped by the user’s KEK.

If an account has no `user_keyrings` entries yet, the app runs in **legacy mode** where KEK is used directly as the data key (backwards-compatible).

### KEK Derivation (Password → KEK)

On login, the server derives a 32-byte **KEK** from the user’s raw password using PBKDF2:

- **KDF:** PBKDF2
- **Digest:** SHA-256
- **Key length:** 32 bytes
- **Iterations:** 310,000 (see `services/encryption.js`)
- **Salt:** `users.encryption_salt` (stored in SQLite; not secret)

### DEK Wrapping (KEK → wrapped DEK)

- **Algorithm:** AES-256-GCM
- **IV:** 12 bytes (random)
- **Auth tag:** 16 bytes
- **Format:** `wk:v1:<base64(iv|tag|ciphertext)>`
- **AAD:** bound to `(accountId, userId)` to prevent cross-user/account swapping
- **Storage:** `user_keyrings(wrapped_dek)`

## Session-Only Key Storage (Zero-Knowledge)

- The derived **KEK** is stored **only in RAM** in an in-process vault (`services/encryption.js`).
- The **account DEK** is held in RAM only while at least one authenticated session has unlocked the account (enables background jobs while a user is online).
- If the app restarts, the in-memory vault is cleared and **all existing sessions are treated as locked** until the user logs in again.
- The key is **never stored** in SQLite or Redis (even if Redis-backed sessions are enabled).

## Operational Notes / Limitations

- **SQL LIKE searches don’t work on ciphertext.** The API implements search by scanning/decrypting recent rows in memory for:
  - message search (`messages.body`, `messages.quoted_body`)
  - chat search (`chats.name`)
  - note search (`notes.content`)
  - media search (`chats.name`, `messages.body`)
- Background jobs and integrations are designed to **skip sensitive operations** when the vault is locked.

## Password Changes

In **legacy mode**, changing a password implies changing the data key and would require full re-encryption.

In **keyring mode (DEK/KEK)**, password changes do **not** require re-encrypting the database: the system only needs to **rewrap the same DEK** with a new KEK derived from the new password.

Note: a password-change endpoint/UI must still be implemented safely (verify old password + update hash + update `users.encryption_salt` + rewrite `user_keyrings.wrapped_dek`).

## Secure Deletion Hygiene

- SQLite is configured with `PRAGMA secure_delete = ON`.
- After message retention cleanup, the service runs `VACUUM` to reduce forensic recoverability.

Important: secure deletion is best-effort; on SSDs and virtualized storage, **true secure deletion cannot be guaranteed** due to wear-leveling/snapshots.

## Migration (Encrypt Existing Plaintext Data)

Run the migration script and provide the user password when prompted:

- `node scripts/zk-migrate.js --account default --username admin`
- Dry run: `node scripts/zk-migrate.js --account default --username admin --dry-run true`

If you point directly at a DB file, you must also provide the account id used for AAD:

- `node scripts/zk-migrate.js --db /abs/path/to/whatsapp.db --account-id default --username admin`

If you lose the password used to derive the master key, **encrypted data is unrecoverable**.

## Migration (Enable DEK/KEK Keyrings)

To initialize a per-account random DEK and migrate existing ciphertext from legacy KEK → DEK:

- `node scripts/zk-keyring-init.js --account default --username admin`
- Dry run: `node scripts/zk-keyring-init.js --account default --username admin --dry-run true`

After this, users without a `user_keyrings` entry can be provisioned automatically when they log in while the account is already unlocked by another session.
