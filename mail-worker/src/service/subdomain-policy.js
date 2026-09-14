import { subdomainConfig } from '../utils/subdomain-utils';
import roleService from './role-service';
import orm from '../entity/orm';
import account from '../entity/account';
import { sql } from 'drizzle-orm';
import BizError from '../error/biz-error';

const policy = {
	async rememberDomains(c) {
		const { domains } = subdomainConfig(c.env);
		if (domains.length) await c.env.db.batch(domains.map(domain =>
			c.env.db.prepare('INSERT OR IGNORE INTO managed_subdomain(domain) VALUES (?)').bind(domain)));
		return domains;
	},
	async isManaged(c, address) {
		const domain = address.slice(address.lastIndexOf('@') + 1).toLowerCase();
		if (subdomainConfig(c.env).domains.includes(domain)) {
			await this.rememberDomains(c);
			return true;
		}
		return !!await c.env.db.prepare('SELECT 1 FROM managed_subdomain WHERE domain = ?').bind(domain).first();
	},
	async assertOrdinary(c, address) {
		if (await this.isManaged(c, address)) throw new BizError('SUBDOMAIN_API_REQUIRED', 403);
	},
	async assertSender(c, address) {
		if (await this.isManaged(c, address)) throw new BizError('SUBDOMAIN_RECEIVE_ONLY', 403);
	},
	async user(c, userId, domain) {
		const row = await c.env.db.prepare(`SELECT u.user_id, u.email, u.status, u.is_del,
			r.role_id, r.avail_domain, r.account_count, r.ban_email FROM user u
			LEFT JOIN role r ON r.role_id = u.type WHERE u.user_id = ?`).bind(userId).first();
		if (!row || row.is_del !== 0 || row.status !== 0) throw new BizError('INVALID_USER', 400);
		const admin = row.email.toLowerCase() === c.env.admin.toLowerCase();
		if (!admin && (!row.role_id || !roleService.hasAvailDomainPerm(row.avail_domain, `probe@${domain}`))) {
			throw new BizError('DOMAIN_PERMISSION_DENIED', 403);
		}
		return { ...row, admin };
	},
	// null means an ordinary domain; managed domains must never use legacy fallbacks.
	async recipient(c, address, sender) {
		if (!await this.isManaged(c, address)) return null;
		const normalized = address.toLowerCase();
		const domain = normalized.slice(normalized.lastIndexOf('@') + 1);
		if (!subdomainConfig(c.env).domains.includes(domain)) return { error: 'DOMAIN_UNAVAILABLE' };
		const row = await orm(c).select().from(account).where(sql`${account.email} = ${normalized} COLLATE NOCASE`).get();
		if (!row || row.mailboxKind !== 1 || row.isDel !== 0 || row.status !== 0) return { error: 'RECIPIENT_UNAVAILABLE' };
		try {
			const user = await this.user(c, row.userId, domain);
			if (!user.admin && roleService.isBanEmail(user.ban_email, sender)) return { error: 'SENDER_BLOCKED' };
		} catch (error) {
			if (error.name !== 'BizError') throw error;
			return { error: error.message };
		}
		return { account: row };
	},
};
export default policy;
