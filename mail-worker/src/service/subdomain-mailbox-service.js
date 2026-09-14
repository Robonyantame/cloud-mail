import BizError from '../error/biz-error';
import settingService from './setting-service';
import policy from './subdomain-policy';
import verifyUtils from '../utils/verify-utils';
import { randomLabel } from '../utils/subdomain-utils';
import orm from '../entity/orm';
import email from '../entity/email';
import { and, asc, eq, gt } from 'drizzle-orm';

const WINDOW = 24 * 60 * 60;
const LEASE = 60;
const fail = (message, code = 400) => { throw new BizError(message, code); };
const positiveId = value => {
	const id = typeof value === 'number' || typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : NaN;
	if (!Number.isSafeInteger(id) || id <= 0) fail('INVALID_ID');
	return id;
};
function page(params, max) {
	const size = params.size === undefined ? 20 : positiveId(params.size);
	if (size > max) fail('INVALID_SIZE');
	return { size, cursor: params.cursor === undefined ? 0 : positiveId(params.cursor) };
}
function normalize(params, adminId) {
	if (!params || typeof params !== 'object' || Array.isArray(params)) fail('INVALID_REQUEST');
	if (typeof params.requestId !== 'string' || !params.requestId.trim() || params.requestId.length > 128) fail('INVALID_REQUEST_ID');
	if (typeof params.domain !== 'string') fail('DOMAIN_UNAVAILABLE');
	const hasCount = Object.hasOwn(params, 'count');
	const hasPrefixes = Object.hasOwn(params, 'prefixes');
	if (hasCount === hasPrefixes) fail('INVALID_MODE');
	if (hasCount && (!Number.isInteger(params.count) || params.count < 1 || params.count > 100)) fail('INVALID_COUNT');
	if (hasPrefixes && (!Array.isArray(params.prefixes) || !params.prefixes.length || params.prefixes.length > 100)) fail('INVALID_COUNT');
	return {
		userId: params.userId === undefined ? adminId : positiveId(params.userId),
		domain: params.domain.trim().toLowerCase(),
		...(hasCount ? { count: params.count } : { prefixes: params.prefixes.map(p => typeof p === 'string' ? p.toLowerCase() : p) }),
	};
}
function prefixError(prefix, domain, setting) {
	if (typeof prefix !== 'string' || !prefix || prefix.includes('@') || !verifyUtils.isEmail(`${prefix}@${domain}`)
		|| prefix.length < setting.minEmailPrefix) return 'INVALID_PREFIX';
	if (setting.emailPrefixFilter.some(word => prefix.includes(word.toLowerCase()))) return 'PREFIX_BLOCKED';
	return null;
}

const service = {
	async admin(c) {
		const row = await c.env.db.prepare('SELECT user_id FROM user WHERE email = ? COLLATE NOCASE AND is_del = 0 AND status = 0')
			.bind(c.env.admin).first();
		if (!row) fail('ADMIN_UNAVAILABLE', 403);
		return row.user_id;
	},
	async batchCreate(c, input) {
		const adminId = await this.admin(c);
		const params = normalize(input, adminId);
		const serialized = JSON.stringify(params);
		const now = Math.floor(Date.now() / 1000);
		const db = c.env.db;
		const previous = await db.prepare('SELECT * FROM mailbox_request WHERE admin_id = ? AND request_id = ?')
			.bind(adminId, input.requestId).first();
		if (previous && previous.created_at + WINDOW > now) {
			if (previous.params !== serialized) fail('REQUEST_CONFLICT', 409);
			if (previous.done) return this.result(c, previous.id, input.requestId);
			if (previous.lease_until > now) return this.processing(input.requestId);
		}
		const domains = await policy.rememberDomains(c);
		if (!domains.includes(params.domain)) fail('DOMAIN_UNAVAILABLE');
		await policy.user(c, params.userId, params.domain);
		const setting = await settingService.query(c);
		if (setting.addEmail !== 0 || setting.manyEmail !== 0) fail('ADD_EMAIL_DISABLED', 403);
		const owner = crypto.randomUUID();
		// Unique request key is independent of the rotating public token. A lease permits
		// recovery before any work commits; the owner token fences late/stale workers.
		const claimed = await db.prepare(`INSERT INTO mailbox_request
			(admin_id, request_id, params, user_id, created_at, owner, lease_until)
			VALUES (?, ?, ?, ?, ?, ?, ?)
			ON CONFLICT(admin_id, request_id) DO UPDATE SET
			params = excluded.params, user_id = excluded.user_id, created_at = excluded.created_at,
			owner = excluded.owner, lease_until = excluded.lease_until, done = 0
			WHERE mailbox_request.created_at + ? <= ?
			RETURNING *`).bind(adminId, input.requestId, serialized, params.userId, now, owner, now + LEASE, WINDOW, now).first();
		let request = claimed;
		if (!request) {
			request = await db.prepare('SELECT * FROM mailbox_request WHERE admin_id = ? AND request_id = ?').bind(adminId, input.requestId).first();
			if (request.params !== serialized) fail('REQUEST_CONFLICT', 409);
			if (request.done) return this.result(c, request.id, input.requestId);
			request = await db.prepare(`UPDATE mailbox_request SET owner = ?, lease_until = ?
				WHERE id = ? AND params = ? AND done = 0 AND lease_until <= ? RETURNING *`)
				.bind(owner, now + LEASE, request.id, serialized, now).first();
			if (!request) return this.processing(input.requestId);
		}
		const id = request.id;
		const guard = 'EXISTS (SELECT 1 FROM mailbox_request WHERE id = ? AND owner = ? AND done = 0)';
		const statements = [db.prepare(`DELETE FROM mailbox_request_item WHERE request_id = ? AND ${guard}`).bind(id, id, owner)];
		const count = params.count ?? params.prefixes.length;
		const plan = [];
		for (let index = 0; index < count; index++) {
			let candidates;
			let error = null;
			if (params.prefixes) {
				const prefix = params.prefixes[index];
				error = prefixError(prefix, params.domain, setting);
				candidates = typeof prefix === 'string' ? [`${prefix}@${params.domain}`] : [];
			} else {
				candidates = [];
				const length = Math.max(12, setting.minEmailPrefix || 1);
				// Bounded generation and collision attempts, even for restrictive filters.
				for (let attempt = 0; attempt < 32 && candidates.length < 8 && length <= 256; attempt++) {
					const prefix = randomLabel(length);
					if (!prefixError(prefix, params.domain, setting)) candidates.push(`${prefix}@${params.domain}`);
				}
				if (!candidates.length) error = 'GENERATION_FAILED';
			}
			plan.push({ candidates, error });
		}
		// The item trigger checks quota/availability and creates each account in input
		// order. The whole batch, including its results, commits or rolls back together.
		statements.push(db.prepare(`INSERT INTO mailbox_request_item(request_id, item_index, candidates, error, collision_error)
			SELECT ?, CAST(key AS INTEGER), json_extract(value, '$.candidates'), json_extract(value, '$.error'), ?
			FROM json_each(?) WHERE ${guard} ORDER BY CAST(key AS INTEGER)`)
			.bind(id, params.prefixes ? 'ADDRESS_UNAVAILABLE' : 'GENERATION_FAILED', JSON.stringify(plan), id, owner));
		statements.push(db.prepare('UPDATE mailbox_request SET done = 1 WHERE id = ? AND owner = ? AND done = 0').bind(id, owner));
		await db.batch(statements);
		const completed = await db.prepare('SELECT done FROM mailbox_request WHERE id = ?').bind(id).first();
		return completed?.done ? this.result(c, id, input.requestId) : this.processing(input.requestId);
	},
	processing(requestId) {
		return { requestId, status: 'processing', retryAfter: LEASE };
	},
	async result(c, id, requestId) {
		const { results } = await c.env.db.prepare('SELECT * FROM mailbox_request_item WHERE request_id = ? ORDER BY item_index').bind(id).all();
		const items = results.map(row => ({ index: row.item_index, ...(row.email ? { email: row.email } : {}),
			...(row.error ? { status: 'failed', error: row.error } : { accountId: row.account_id, status: 'created' }) }));
		const created = items.filter(item => item.status === 'created').length;
		return { requestId, created, failed: items.length - created, items };
	},
	async mailbox(c, value) {
		const id = positiveId(value);
		const row = await c.env.db.prepare(`SELECT a.account_id, a.user_id, a.email, a.status, r.domain FROM account a
			JOIN mailbox_reservation r ON r.account_id = a.account_id WHERE a.account_id = ? AND a.mailbox_kind = 1 AND a.is_del = 0`).bind(id).first();
		if (!row) fail('MAILBOX_NOT_FOUND', 404);
		return row;
	},
	async list(c, params) {
		const adminId = await this.admin(c);
		const userId = params.userId === undefined ? adminId : positiveId(params.userId);
		const { size, cursor } = page(params, 100);
		const conditions = ['a.user_id = ?', 'a.account_id > ?', 'a.is_del = 0', 'a.mailbox_kind = 1'];
		const values = [userId, cursor];
		if (params.domain !== undefined) { conditions.push('r.domain = ?'); values.push(params.domain.trim().toLowerCase()); }
		if (params.status !== undefined) {
			if (!['active', 'disabled'].includes(params.status)) fail('INVALID_STATUS');
			conditions.push('a.status = ?'); values.push(params.status === 'active' ? 0 : 1);
		}
		const { results } = await c.env.db.prepare(`SELECT a.account_id AS accountId, a.user_id AS userId, a.email,
			r.domain, CASE a.status WHEN 0 THEN 'active' ELSE 'disabled' END AS status, a.create_time AS createTime
			FROM account a JOIN mailbox_reservation r ON r.account_id = a.account_id
			WHERE ${conditions.join(' AND ')} ORDER BY a.account_id LIMIT ?`).bind(...values, size + 1).all();
		return { items: results.slice(0, size), nextCursor: results.length > size ? String(results[size - 1].accountId) : null };
	},
	async setStatus(c, params, enabled) {
		await this.admin(c);
		if (!params || typeof params !== 'object' || Array.isArray(params)) fail('INVALID_REQUEST');
		const row = await this.mailbox(c, params.accountId);
		if (enabled) {
			if (!(await policy.rememberDomains(c)).includes(row.domain)) fail('DOMAIN_UNAVAILABLE');
			await policy.user(c, row.user_id, row.domain);
		}
		await c.env.db.prepare('UPDATE account SET status = ? WHERE account_id = ?').bind(enabled ? 0 : 1, row.account_id).run();
		return { accountId: row.account_id, status: enabled ? 'active' : 'disabled' };
	},
	async emails(c, params) {
		await this.admin(c);
		const row = await this.mailbox(c, params.accountId);
		const { size, cursor } = page(params, 50);
		const items = await orm(c).select().from(email).where(and(eq(email.accountId, row.account_id),
			eq(email.userId, row.user_id), eq(email.type, 0), eq(email.isDel, 0), gt(email.emailId, cursor)))
			.orderBy(asc(email.emailId)).limit(size + 1).all();
		return { items: items.slice(0, size), nextCursor: items.length > size ? String(items[size - 1].emailId) : null };
	},
	async cleanRequests(c) {
		await c.env.db.prepare('DELETE FROM mailbox_request WHERE created_at + ? <= unixepoch() AND lease_until <= unixepoch()').bind(WINDOW).run();
	},
};
export default service;
