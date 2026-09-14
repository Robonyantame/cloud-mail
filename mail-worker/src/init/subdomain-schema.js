// Kept separate from address/account lifetimes: never cascade-delete these records.
export const subdomainSchema = [
	`CREATE TABLE IF NOT EXISTS managed_subdomain (domain TEXT PRIMARY KEY COLLATE NOCASE)`,
	`CREATE TABLE IF NOT EXISTS mailbox_reservation (
		email TEXT PRIMARY KEY COLLATE NOCASE, account_id INTEGER NOT NULL UNIQUE,
		user_id INTEGER NOT NULL, domain TEXT NOT NULL, created_at INTEGER NOT NULL DEFAULT (unixepoch()))`,
	`CREATE TABLE IF NOT EXISTS mailbox_request (
		id INTEGER PRIMARY KEY AUTOINCREMENT, admin_id INTEGER NOT NULL, request_id TEXT NOT NULL,
		params TEXT NOT NULL, user_id INTEGER NOT NULL, created_at INTEGER NOT NULL,
		owner TEXT NOT NULL, lease_until INTEGER NOT NULL, done INTEGER NOT NULL DEFAULT 0,
		UNIQUE(admin_id, request_id))`,
	`CREATE TABLE IF NOT EXISTS mailbox_request_item (
		request_id INTEGER NOT NULL REFERENCES mailbox_request(id) ON DELETE CASCADE,
		item_index INTEGER NOT NULL, email TEXT, error TEXT, account_id INTEGER,
		candidates TEXT NOT NULL DEFAULT '[]', collision_error TEXT NOT NULL DEFAULT 'ADDRESS_UNAVAILABLE',
		PRIMARY KEY(request_id, item_index))`,
	`CREATE INDEX IF NOT EXISTS idx_mailbox_reservation_user ON mailbox_reservation(user_id, account_id)`,
	`CREATE INDEX IF NOT EXISTS idx_mailbox_request_expiry ON mailbox_request(created_at)`,
	`CREATE TRIGGER IF NOT EXISTS mailbox_address_guard BEFORE INSERT ON account BEGIN
		SELECT RAISE(ABORT, 'ADDRESS_UNAVAILABLE') WHERE EXISTS
			(SELECT 1 FROM mailbox_reservation WHERE email = NEW.email COLLATE NOCASE);
		SELECT RAISE(ABORT, 'SUBDOMAIN_API_REQUIRED') WHERE NEW.mailbox_kind = 0 AND EXISTS
			(SELECT 1 FROM managed_subdomain WHERE domain = substr(NEW.email, instr(NEW.email, '@') + 1) COLLATE NOCASE);
	END`,
	`CREATE TRIGGER IF NOT EXISTS mailbox_reserve AFTER INSERT ON account WHEN NEW.mailbox_kind = 1 BEGIN
		INSERT INTO mailbox_reservation(email, account_id, user_id, domain)
		VALUES(lower(NEW.email), NEW.account_id, NEW.user_id, lower(substr(NEW.email, instr(NEW.email, '@') + 1)));
		INSERT OR IGNORE INTO managed_subdomain(domain) VALUES(lower(substr(NEW.email, instr(NEW.email, '@') + 1)));
	END`,
	`CREATE TRIGGER IF NOT EXISTS mailbox_ownership_guard BEFORE UPDATE ON account
		WHEN OLD.mailbox_kind = 1 AND (NEW.email != OLD.email OR NEW.user_id != OLD.user_id OR NEW.mailbox_kind != 1)
		BEGIN SELECT RAISE(ABORT, 'MAILBOX_OWNERSHIP_IMMUTABLE'); END`,
	// Each ordered plan row resolves against the state left by the previous row.
	// Triggered work keeps a 100-address request within a constant number of D1 calls.
	`CREATE TRIGGER IF NOT EXISTS mailbox_create_item AFTER INSERT ON mailbox_request_item BEGIN
		UPDATE mailbox_request_item SET email = COALESCE(
			(SELECT value FROM json_each(NEW.candidates) candidate WHERE NOT EXISTS
				(SELECT 1 FROM account WHERE email = candidate.value COLLATE NOCASE)
				AND NOT EXISTS (SELECT 1 FROM mailbox_reservation WHERE email = candidate.value COLLATE NOCASE)
				ORDER BY key LIMIT 1), json_extract(NEW.candidates, '$[0]')),
			error = (SELECT CASE WHEN NEW.error IS NOT NULL THEN NEW.error
			WHEN NOT EXISTS (SELECT 1 FROM user WHERE user_id = request.user_id AND status = 0 AND is_del = 0) THEN 'INVALID_USER'
			WHEN NOT EXISTS (SELECT 1 FROM user u LEFT JOIN role r ON r.role_id = u.type WHERE u.user_id = request.user_id
				AND (u.user_id = request.admin_id OR (r.role_id IS NOT NULL AND (r.avail_domain = '' OR
				instr(',' || lower(r.avail_domain) || ',', ',' || json_extract(request.params, '$.domain') || ',') > 0))))
				THEN 'DOMAIN_PERMISSION_DENIED'
			WHEN EXISTS (SELECT 1 FROM user u JOIN role r ON r.role_id = u.type
				WHERE u.user_id = request.user_id AND u.user_id != request.admin_id AND r.account_count > 0
				AND (SELECT count(*) FROM account WHERE user_id = u.user_id AND is_del = 0) >= r.account_count) THEN 'QUOTA_EXCEEDED'
			WHEN NOT EXISTS (SELECT 1 FROM json_each(NEW.candidates) candidate WHERE NOT EXISTS
				(SELECT 1 FROM account WHERE email = candidate.value COLLATE NOCASE)
				AND NOT EXISTS (SELECT 1 FROM mailbox_reservation WHERE email = candidate.value COLLATE NOCASE)) THEN NEW.collision_error
			ELSE NULL END FROM mailbox_request request WHERE request.id = NEW.request_id)
		WHERE request_id = NEW.request_id AND item_index = NEW.item_index;
		INSERT INTO account(email, name, user_id, mailbox_kind)
			SELECT item.email, substr(item.email, 1, instr(item.email, '@') - 1), request.user_id, 1
			FROM mailbox_request_item item JOIN mailbox_request request ON request.id = item.request_id
			WHERE item.request_id = NEW.request_id AND item.item_index = NEW.item_index AND item.error IS NULL;
		UPDATE mailbox_request_item SET account_id =
			(SELECT account_id FROM mailbox_reservation WHERE email = mailbox_request_item.email COLLATE NOCASE)
			WHERE request_id = NEW.request_id AND item_index = NEW.item_index AND error IS NULL;
	END`,
];

export async function migrateSubdomain(db) {
	const column = await db.prepare("SELECT name FROM pragma_table_info('account') WHERE name = 'mailbox_kind'").first();
	if (!column) await db.prepare('ALTER TABLE account ADD COLUMN mailbox_kind INTEGER NOT NULL DEFAULT 0').run();
	await db.batch(subdomainSchema.map(sql => db.prepare(sql)));
}
