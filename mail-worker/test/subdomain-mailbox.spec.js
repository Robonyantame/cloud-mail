import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbInit } from '../src/init/init';
import { migrateSubdomain } from '../src/init/subdomain-schema';
import service from '../src/service/subdomain-mailbox-service';
import policy from '../src/service/subdomain-policy';
import settingService from '../src/service/setting-service';
import accountService from '../src/service/account-service';
import userService from '../src/service/user-service';
import emailService from '../src/service/email-service';
import { email as inbound } from '../src/email/email';
import worker from '../src';
import KvConst from '../src/const/kv-const';
import { subdomainName, subdomainConfig } from '../src/utils/subdomain-utils';

let c;
const domain = 'shop.example.com';
const request = (extra = {}) => ({ requestId: crypto.randomUUID(), domain, count: 1, ...extra });
const custom = prefixes => ({ requestId: crypto.randomUUID(), domain, prefixes });
async function run(sql, ...values) { return c.env.db.prepare(sql).bind(...values).run(); }
async function first(sql, ...values) { return c.env.db.prepare(sql).bind(...values).first(); }
async function settings(patch) {
	const setting = await c.env.kv.get(KvConst.SETTING, { type: 'json' });
	await c.env.kv.put(KvConst.SETTING, JSON.stringify({ ...setting, ...patch }));
}
async function deliver(to, subject = 'verification') {
	const reject = vi.fn();
	const raw = `From: Website <website@external.com>\r\nTo: Someone <header@external.com>\r\nSubject: ${subject}\r\nContent-Type: text/plain\r\n\r\nYour code is 123456`;
	await inbound({ to, from: 'website@external.com', raw: new Blob([raw]).stream(), setReject: reject }, c.env, {});
	return reject;
}
async function api(path, body, token = 'test-token', method = body ? 'POST' : 'GET') {
	const headers = { 'Content-Type': 'application/json' };
	if (token !== null) headers.Authorization = token;
	return worker.fetch(new Request(`https://mail.example.com/api/public/subdomainMailbox/${path}`, {
		method, headers, ...(body ? { body: JSON.stringify(body) } : {}),
	}), c.env, {});
}

beforeEach(async () => {
	c = { env: { ...env, admin: 'admin@example.com', domain: ['example.com'],
		subdomain_domains: ['shop'], jwt_secret: 'local-test-only', orm_log: false },
		req: { param: () => 'local-test-only' }, set() {}, text: value => value };
	await dbInit.init(c);
	await run("INSERT INTO user(user_id,email,password,salt,type) VALUES (1,'admin@example.com','','',1),(2,'member@example.com','','',1)");
	await run("UPDATE role SET account_count = 3, avail_domain = ? WHERE role_id = 1", domain);
	await run("INSERT INTO account(email,name,user_id) VALUES ('admin@example.com','admin',1),('member@example.com','member',2)");
	await settings({ aiCode: 1, minEmailPrefix: 1, noRecipient: 0, send: 0 });
	await c.env.kv.put(KvConst.PUBLIC_KEY, 'test-token');
});

describe('batch creation and durable retries', () => {
	it('creates 100 unique addresses under one domain and rejects 101 atomically', async () => {
		const result = await service.batchCreate(c, request({ count: 100 }));
		expect(result.created).toBe(100);
		expect(new Set(result.items.map(i => i.email)).size).toBe(100);
		expect(result.items.every(i => /^[a-z0-9]{12}@shop\.example\.com$/.test(i.email))).toBe(true);
		expect(await first('SELECT count(*) n FROM user')).toEqual({ n: 2 });
		await expect(service.batchCreate(c, request({ count: 101 }))).rejects.toThrow('INVALID_COUNT');
		expect(await first('SELECT count(*) n FROM mailbox_reservation')).toEqual({ n: 100 });
	});
	it('preserves custom names, item order, invalid items and case-insensitive duplicates', async () => {
		const input = custom(['GitHub', 'github', 'bad space', 'a_b', 'a%b', 'alice+tag', null]);
		const result = await service.batchCreate(c, input);
		expect(result.items.map(i => i.status)).toEqual(['created', 'failed', 'failed', 'created', 'created', 'created', 'failed']);
		expect(result.items[0].email).toBe(`github@${domain}`);
		expect(result.items[1].error).toBe('ADDRESS_UNAVAILABLE');
		expect(await service.batchCreate(c, input)).toEqual(result);
		await expect(service.batchCreate(c, { ...input, prefixes: ['different'] })).rejects.toThrow('REQUEST_CONFLICT');
	});
	it('enforces the target role, global switches, prefix filters and random minimum length', async () => {
		await expect(service.batchCreate(c, request({ userId: 999 }))).rejects.toThrow('INVALID_USER');
		await run("UPDATE role SET avail_domain = 'example.com' WHERE role_id = 1");
		await expect(service.batchCreate(c, request({ userId: 2 }))).rejects.toThrow('DOMAIN_PERMISSION_DENIED');
		await run('UPDATE user SET status = 1 WHERE user_id = 2');
		await expect(service.batchCreate(c, request({ userId: 2 }))).rejects.toThrow('INVALID_USER');
		await settings({ addEmail: 1 });
		await expect(service.batchCreate(c, request())).rejects.toThrow('ADD_EMAIL_DISABLED');
		await settings({ addEmail: 0, manyEmail: 1 });
		await expect(service.batchCreate(c, request())).rejects.toThrow('ADD_EMAIL_DISABLED');
		await settings({ manyEmail: 0, minEmailPrefix: 18, emailPrefixFilter: 'BAD' });
		const random = await service.batchCreate(c, request());
		expect(random.items[0].email.split('@')[0]).toHaveLength(18);
		const invalid = await service.batchCreate(c, custom(['short', 'badxxxxxxxxxxxxxxxxxx']));
		expect(invalid.items.map(i => i.error)).toEqual(['INVALID_PREFIX', 'PREFIX_BLOCKED']);
		await settings({ minEmailPrefix: 1, emailPrefixFilter: 'abcdefghijklmnopqrstuvwxyz0123456789'.split('').join(',') });
		expect((await service.batchCreate(c, request())).items[0].error).toBe('GENERATION_FAILED');
	});
	it('serializes concurrent batches against the last quota slot, including disabled accounts', async () => {
		await run('UPDATE role SET account_count = 2 WHERE role_id = 1');
		const results = await Promise.all(Array.from({ length: 6 }, () => service.batchCreate(c, request({ userId: 2, count: 3 }))));
		expect(results.reduce((sum, r) => sum + r.created, 0)).toBe(1);
		const item = results.flatMap(r => r.items).find(i => i.status === 'created');
		await service.setStatus(c, item, false);
		expect((await service.batchCreate(c, request({ userId: 2 }))).items[0].error).toBe('QUOTA_EXCEEDED');
	});
	it('handles concurrent same-request calls and returns the committed original results after token rotation', async () => {
		const input = request({ count: 10 });
		const results = await Promise.all([service.batchCreate(c, input), service.batchCreate(c, input)]);
		expect(results.every(r => r.status === 'processing' || r.created === 10)).toBe(true);
		expect(await first('SELECT count(*) n FROM mailbox_reservation')).toEqual({ n: 10 });
		await c.env.kv.put(KvConst.PUBLIC_KEY, 'rotated');
		const replay = await (await api('batchCreate', input, 'rotated')).json();
		expect(replay.data).toEqual(await service.batchCreate(c, input));
	});
	it('prevents the ordinary creation endpoint from using a stale quota count', async () => {
		await run("UPDATE role SET account_count = 2, avail_domain = '' WHERE role_id = 1");
		let release;
		let reached;
		const blocked = new Promise(resolve => { release = resolve; });
		const counted = new Promise(resolve => { reached = resolve; });
		const original = accountService.countUserAccount.bind(accountService);
		const spy = vi.spyOn(accountService, 'countUserAccount').mockImplementation(async (...args) => {
			const count = await original(...args);
			reached();
			await blocked;
			return count;
		});
		const pending = accountService.add(c, { email: 'ordinary@example.com' }, 2).then(() => 'created', () => 'failed');
		await counted;
		expect((await service.batchCreate(c, request({ userId: 2 }))).created).toBe(1);
		release();
		expect(await pending).toBe('failed');
		spy.mockRestore();
		expect(await first('SELECT count(*) n FROM account WHERE user_id = 2')).toEqual({ n: 2 });
	});
	it('fences a late worker after another worker takes over its expired lease', async () => {
		const input = request({ count: 3 });
		let release;
		let reached;
		const blocked = new Promise(resolve => { release = resolve; });
		const planned = new Promise(resolve => { reached = resolve; });
		const db = c.env.db;
		const delayed = { ...c, env: { ...c.env, db: {
			prepare: sql => db.prepare(sql),
			batch: async statements => {
				if (statements.length > 1) { reached(); await blocked; }
				return db.batch(statements);
			},
		} } };
		const pending = service.batchCreate(delayed, input);
		await planned;
		await run('UPDATE mailbox_request SET lease_until = 0');
		const recovered = await service.batchCreate(c, input);
		release();
		expect(await pending).toEqual(recovered);
		expect(await first('SELECT count(*) n FROM mailbox_reservation')).toEqual({ n: 3 });
	});
	it('replays failed items even if quota changes and survives loss of a committed response', async () => {
		const input = request({ userId: 2, count: 4 });
		const db = c.env.db;
		const responseLost = { ...c, env: { ...c.env, db: {
			prepare: sql => db.prepare(sql),
			batch: async statements => {
				const result = await db.batch(statements);
				if (statements.length > 1) throw new Error('response lost after commit');
				return result;
			},
		} } };
		await expect(service.batchCreate(responseLost, input)).rejects.toThrow('response lost');
		await run('UPDATE role SET account_count = 100 WHERE role_id = 1');
		const replay = await service.batchCreate(c, input);
		expect(replay.created).toBe(2);
		expect(replay.failed).toBe(2);
		expect(await first('SELECT count(*) n FROM mailbox_reservation')).toEqual({ n: 2 });
	});
	it('recovers a pre-commit interruption and never repeats a committed batch after response loss', async () => {
		const input = request({ count: 4 });
		const db = c.env.db;
		const broken = { ...c, env: { ...c.env, db: {
			prepare: sql => db.prepare(sql),
			batch: statements => {
				if (statements.length > 1) throw new Error('simulated interruption');
				return db.batch(statements);
			},
		} } };
		await expect(service.batchCreate(broken, input)).rejects.toThrow('simulated interruption');
		expect(await first('SELECT count(*) n FROM mailbox_reservation')).toEqual({ n: 0 });
		expect((await service.batchCreate(c, input)).status).toBe('processing');
		await run('UPDATE mailbox_request SET lease_until = 0');
		const recovered = await service.batchCreate(c, input);
		expect(recovered.created).toBe(4);
		expect(await service.batchCreate(c, input)).toEqual(recovered);
		expect(await first('SELECT count(*) n FROM mailbox_reservation')).toEqual({ n: 4 });
	});
	it('rolls back unexpected SQL failure together with its item records', async () => {
		await run("CREATE TRIGGER test_failure BEFORE INSERT ON account WHEN NEW.name = 'second' BEGIN SELECT RAISE(ABORT, 'injected'); END");
		const input = custom(['first', 'second']);
		await expect(service.batchCreate(c, input)).rejects.toThrow('injected');
		expect(await first('SELECT count(*) n FROM mailbox_reservation')).toEqual({ n: 0 });
		expect(await first('SELECT count(*) n FROM mailbox_request_item')).toEqual({ n: 0 });
		await run('DROP TRIGGER test_failure');
		await run('UPDATE mailbox_request SET lease_until = 0');
		expect((await service.batchCreate(c, input)).created).toBe(2);
	});
	it('allows a fresh request after 24 hours and cleans only request records', async () => {
		const input = request();
		const original = await service.batchCreate(c, input);
		await run('UPDATE mailbox_request SET created_at = unixepoch() - 86401, lease_until = 0');
		const next = await service.batchCreate(c, input);
		expect(next.items[0].accountId).not.toBe(original.items[0].accountId);
		await run('UPDATE mailbox_request SET created_at = unixepoch() - 86401, lease_until = 0');
		await service.cleanRequests(c);
		expect(await first('SELECT count(*) n FROM mailbox_request_item')).toEqual({ n: 0 });
		expect(await first('SELECT count(*) n FROM mailbox_reservation')).toEqual({ n: 2 });
	});
});

describe('strict delivery, lifecycle and existing UI', () => {
	it('uses the envelope address, rejects unknown and implicit +tag, accepts explicit +tag and case variants', async () => {
		await service.batchCreate(c, custom(['alice', 'alice+explicit']));
		expect(await deliver(`ALICE@${domain.toUpperCase()}`)).not.toHaveBeenCalled();
		expect(await deliver(`bob@${domain}`)).toHaveBeenCalled();
		expect(await deliver(`alice+tag@${domain}`)).toHaveBeenCalled();
		expect(await deliver(`alice+explicit@${domain}`)).not.toHaveBeenCalled();
		expect(await first('SELECT count(*) n FROM email')).toEqual({ n: 2 });
	});
	it('disables and restores without losing ownership, quota or historical mail', async () => {
		const { items: [item] } = await service.batchCreate(c, custom(['alice']));
		await deliver(item.email);
		await service.setStatus(c, item, false);
		await service.setStatus(c, item, false);
		expect(await deliver(item.email)).toHaveBeenCalled();
		expect((await service.emails(c, item)).items).toHaveLength(1);
		const visible = await emailService.list(c, { accountId: item.accountId, size: 20, allReceive: 0 }, 1);
		expect(visible.list).toHaveLength(1);
		await service.setStatus(c, { ...item, userId: 2 }, true);
		expect(await deliver(item.email)).not.toHaveBeenCalled();
		expect((await first('SELECT user_id FROM account WHERE account_id = ?', item.accountId)).user_id).toBe(1);
	});
	it('shares strict checks with on-site delivery, including receive switch and filters', async () => {
		const { items: [item] } = await service.batchCreate(c, custom(['alice']));
		await run("INSERT INTO email(account_id,user_id,type,send_email,subject) VALUES (1,1,1,'admin@example.com','test')");
		const sent = { emailId: 1, accountId: 1, userId: 1, sendEmail: 'admin@example.com', subject: 'test', recipient: '[]' };
		await emailService.HandleOnSiteEmail(c, [item.email.toUpperCase()], sent, []);
		expect((await service.emails(c, item)).items).toHaveLength(1);
		await service.setStatus(c, item, false);
		await emailService.HandleOnSiteEmail(c, [item.email, `unknown@${domain}`, `alice+tag@${domain}`], sent, []);
		expect((await service.emails(c, item)).items).toHaveLength(1);
		expect((await first('SELECT status FROM email WHERE email_id = 1')).status).toBe(3);
		await service.setStatus(c, item, true);
		await settings({ receive: 1 });
		await emailService.HandleOnSiteEmail(c, [item.email], sent, []);
		expect(await deliver(item.email)).toHaveBeenCalled();
		await settings({ receive: 0, blackSubject: 'test' });
		await emailService.HandleOnSiteEmail(c, [item.email], sent, []);
		expect(await deliver(item.email, 'test')).toHaveBeenCalled();
		expect((await service.emails(c, item)).items).toHaveLength(1);
	});
	it('rejects invalid owners, missing domain permission and blocked senders', async () => {
		const { items: [item] } = await service.batchCreate(c, { ...custom(['alice']), userId: 2 });
		await run('UPDATE user SET status = 1 WHERE user_id = 2');
		expect(await deliver(item.email)).toHaveBeenCalled();
		await expect(service.setStatus(c, item, true)).rejects.toThrow('INVALID_USER');
		await run('UPDATE user SET status = 0 WHERE user_id = 2');
		await run("UPDATE role SET avail_domain = 'example.com' WHERE role_id = 1");
		expect(await deliver(item.email)).toHaveBeenCalled();
		await run("UPDATE role SET avail_domain = ?, ban_email = 'external.com' WHERE role_id = 1", domain);
		expect(await deliver(item.email)).toHaveBeenCalled();
		await run('DELETE FROM user WHERE user_id = 2');
		expect(await deliver(item.email)).toHaveBeenCalled();
	});
	it('keeps the whole removed domain strict and hides it from public domain choices', async () => {
		const { items: [item] } = await service.batchCreate(c, custom(['alice']));
		c.env.domain.push(domain);
		expect((await settingService.query(c)).domainList).toEqual(['@example.com']);
		c.env.subdomain_domains = [];
		expect(await deliver(item.email)).toHaveBeenCalledWith('DOMAIN_UNAVAILABLE');
		expect(await deliver(`unknown@${domain}`)).toHaveBeenCalledWith('DOMAIN_UNAVAILABLE');
		await expect(service.batchCreate(c, request())).rejects.toThrow('DOMAIN_UNAVAILABLE');
		await expect(service.setStatus(c, item, true)).rejects.toThrow('DOMAIN_UNAVAILABLE');
		await expect(policy.assertOrdinary(c, `new@${domain}`)).rejects.toThrow('SUBDOMAIN_API_REQUIRED');
	});
	it('reserves addresses across physical mailbox and user deletion and prevents ownership changes', async () => {
		const { items: [item] } = await service.batchCreate(c, custom(['retired']));
		await expect(run('UPDATE account SET user_id = 2 WHERE account_id = ?', item.accountId)).rejects.toThrow('MAILBOX_OWNERSHIP_IMMUTABLE');
		await accountService.physicsDelete(c, item);
		expect((await service.batchCreate(c, custom(['RETIRED']))).items[0].error).toBe('ADDRESS_UNAVAILABLE');
		const { items: [owned] } = await service.batchCreate(c, { ...custom(['user-retired']), userId: 2 });
		await userService.physicsDelete(c, { userIds: '2' });
		expect((await service.batchCreate(c, custom(['user-retired']))).items[0].error).toBe('ADDRESS_UNAVAILABLE');
		expect(await deliver(owned.email)).toHaveBeenCalled();
	});
	it('queries by exact account ID and uses stable cursors for lists and email history', async () => {
		const { items } = await service.batchCreate(c, custom(['a_b', 'axb', 'a%b']));
		for (const item of items) await deliver(item.email);
		const history = await service.emails(c, items[0]);
		expect(history.items).toHaveLength(1);
		expect(history.items[0].accountId).toBe(items[0].accountId);
		const firstPage = await service.list(c, { size: 2 });
		expect(firstPage.items).toHaveLength(2);
		expect((await service.list(c, { size: 2, cursor: firstPage.nextCursor })).items.map(i => i.accountId)).toEqual([items[2].accountId]);
		await deliver(items[0].email);
		const emails = await service.emails(c, { ...items[0], size: 1 });
		expect((await service.emails(c, { ...items[0], size: 1, cursor: emails.nextCursor })).items[0].emailId).toBeGreaterThan(emails.items[0].emailId);
		await expect(service.emails(c, { accountId: 1 })).rejects.toThrow('MAILBOX_NOT_FOUND');
	});
	it('leaves ordinary +tag/unowned behavior intact and blocks subdomain senders', async () => {
		expect(await deliver('admin+tag@example.com')).not.toHaveBeenCalled();
		expect(await deliver('unowned@example.com')).not.toHaveBeenCalled();
		const { items: [item] } = await service.batchCreate(c, request());
		await expect(emailService.send(c, { accountId: item.accountId, receiveEmail: ['admin@example.com'], content: '', attachments: [] }, 1))
			.rejects.toThrow('SUBDOMAIN_RECEIVE_ONLY');
		await expect(policy.assertSender(c, 'admin@example.com')).resolves.toBeUndefined();
		await expect(accountService.add(c, { email: 'new-ordinary@example.com' }, 1)).resolves.toMatchObject({ email: 'new-ordinary@example.com' });
		const ordinarySent = await emailService.send(c, { accountId: 1, receiveEmail: [item.email], content: '', subject: 'ordinary sender', attachments: [] }, 1);
		expect(ordinarySent).toHaveLength(1);
		expect((await service.emails(c, item)).items).toHaveLength(1);
	});
	it('keeps addresses while auto-cleaning mail, with main-user exclusions', async () => {
		const { items: [item] } = await service.batchCreate(c, request());
		await deliver(item.email);
		await run("UPDATE email SET create_time = '2000-01-01 00:00:00'");
		await emailService.autoClean(c);
		expect((await service.emails(c, item)).items).toHaveLength(1);
		await settings({ autoCleanDays: 1, autoCleanExclude: 'admin@example.com' });
		await emailService.autoClean(c);
		expect((await service.emails(c, item)).items).toHaveLength(1);
		await settings({ autoCleanExclude: '' });
		await emailService.autoClean(c);
		expect((await service.emails(c, item)).items).toHaveLength(0);
		expect((await service.list(c, {})).items).toHaveLength(1);
	});
});

describe('API and provisioning', () => {
	it('expands every label across all mailbox domains and receives at the requested full addresses', async () => {
		c.env.domain = ['mxr.cc.cd', 'roop.cc.cd', 'tame.cc.cd'];
		c.env.subdomain_domains = ['shop', 'tools'];
		const expected = ['shop.mxr.cc.cd', 'tools.mxr.cc.cd', 'shop.roop.cc.cd', 'tools.roop.cc.cd', 'shop.tame.cc.cd', 'tools.tame.cc.cd'];
		expect(subdomainConfig(c.env).domains).toEqual(expected);
		for (const fullDomain of expected) {
			const prefix = fullDomain === 'tools.tame.cc.cd' ? 'temp' : 'test';
			const response = await api('batchCreate', { ...custom([prefix]), domain: fullDomain });
			const result = await response.json();
			expect(result.data.created).toBe(1);
			const item = result.data.items[0];
			expect(item.email).toBe(`${prefix}@${fullDomain}`);
			expect(await deliver(item.email)).not.toHaveBeenCalled();
			expect((await service.emails(c, item)).items).toHaveLength(1);
		}
		expect((await settingService.query(c)).domainList).toEqual(c.env.domain.map(d => `@${d}`));
		await expect(service.batchCreate(c, request({ domain: 'shop' }))).rejects.toThrow('DOMAIN_UNAVAILABLE');
		await expect(service.batchCreate(c, request({ domain: 'other.mxr.cc.cd' }))).rejects.toThrow('DOMAIN_UNAVAILABLE');
		await run("UPDATE role SET avail_domain = 'mxr.cc.cd' WHERE role_id = 1");
		await expect(service.batchCreate(c, request({ domain: expected[0], userId: 2 }))).rejects.toThrow('DOMAIN_PERMISSION_DENIED');
	});
	it('keeps removed base/label combinations strict and preserves their owners and history', async () => {
		c.env.domain = ['mxr.cc.cd', 'tame.cc.cd'];
		c.env.subdomain_domains = ['shop', 'tools'];
		const { items: [removedBase] } = await service.batchCreate(c, { ...custom(['test']), domain: 'shop.mxr.cc.cd' });
		const { items: [removedLabel] } = await service.batchCreate(c, { ...custom(['temp']), domain: 'tools.tame.cc.cd' });
		await deliver(removedBase.email);
		await deliver(removedLabel.email);
		c.env.domain = ['tame.cc.cd'];
		c.env.subdomain_domains = ['shop'];
		for (const item of [removedBase, removedLabel]) {
			expect(await deliver(item.email)).toHaveBeenCalledWith('DOMAIN_UNAVAILABLE');
			expect((await service.emails(c, item)).items).toHaveLength(1);
			await expect(service.batchCreate(c, request({ domain: item.email.split('@')[1] }))).rejects.toThrow('DOMAIN_UNAVAILABLE');
		}
		expect(await deliver('unknown@tools.mxr.cc.cd')).toHaveBeenCalledWith('DOMAIN_UNAVAILABLE');
		expect((await service.batchCreate(c, request({ domain: 'shop.tame.cc.cd' }))).created).toBe(1);
		c.env.domain.push('mxr.cc.cd');
		c.env.subdomain_domains.push('tools');
		expect(await deliver(removedBase.email)).not.toHaveBeenCalled();
		expect((await service.batchCreate(c, { ...custom(['test']), domain: 'shop.mxr.cc.cd' })).items[0].error).toBe('ADDRESS_UNAVAILABLE');
	});
	it('accepts JSON array variables, deduplicates combinations and rejects full domains in the label list', () => {
		expect(subdomainConfig({ domain: '["mxr.cc.cd","mxr.cc.cd"]', subdomain_domains: '["shop","shop","tools"]' }).domains)
			.toEqual(['shop.mxr.cc.cd', 'tools.mxr.cc.cd']);
		expect(subdomainConfig({ domain: ['mxr.cc.cd'] }).domains).toEqual([]);
		for (const labels of [['shop.mxr.cc.cd'], ['nested.shop'], ['UPPER'], ['-bad'], [''], [null], [123], false, '{}', '{bad']) {
			expect(() => subdomainConfig({ domain: ['mxr.cc.cd'], subdomain_domains: labels })).toThrow('INVALID_SUBDOMAIN_CONFIG');
		}
		for (const bases of [[], ['invalid'], ['UPPER.com'], [null], '{bad']) {
			expect(() => subdomainConfig({ domain: bases, subdomain_domains: ['shop'] })).toThrow('INVALID_SUBDOMAIN_CONFIG');
		}
	});
	it('requires the administrator public token and rejects malformed requests without writes', async () => {
		expect((await api('batchCreate', request(), null)).status).toBe(401);
		expect((await (await api('batchCreate', request(), null)).json()).code).toBe(401);
		expect((await (await api('batchCreate', request(), 'wrong')).json()).code).toBe(401);
		for (const input of [request({ prefixes: ['a'] }), { requestId: 'x', domain }, request({ requestId: '' }), request({ domain: 'unavailable.example.com' })]) {
			expect((await (await api('batchCreate', input)).json()).code).not.toBe(200);
		}
		expect(await first('SELECT count(*) n FROM mailbox_reservation')).toEqual({ n: 0 });
		const response = await (await api('batchCreate', custom(['script']))).json();
		expect(response.code).toBe(200);
		expect((await (await api('list')).json()).data.items[0].accountId).toBe(response.data.items[0].accountId);
		const item = response.data.items[0];
		expect((await (await api('disable', item)).json()).data.status).toBe('disabled');
		expect((await (await api('list?status=disabled')).json()).data.items).toHaveLength(1);
		expect((await (await api('enable', item)).json()).data.status).toBe('active');
		expect((await (await api(`emails?accountId=${item.accountId}`)).json()).data.items).toEqual([]);
	});
	it('returns JSON/size errors and preserves parameter distinctions on retry', async () => {
		const malformed = await worker.fetch(new Request('https://mail.example.com/api/public/subdomainMailbox/batchCreate', {
			method: 'POST', headers: { Authorization: 'test-token', 'Content-Type': 'application/json' }, body: '{bad',
		}), c.env, {});
		expect(malformed.status).toBe(400);
		expect((await malformed.json()).message).toBe('INVALID_JSON');
		expect((await api('batchCreate', custom(['a'.repeat(66000)]))).status).toBe(413);
		const invalid = custom([1]);
		await service.batchCreate(c, invalid);
		await expect(service.batchCreate(c, { ...invalid, prefixes: [null] })).rejects.toThrow('REQUEST_CONFLICT');
		expect((await api('list?size=101')).status).toBe(400);
		expect((await api('disable', [], 'test-token')).status).toBe(400);
	});
	it('initializes newly configured domains persistently and protects the migration endpoint', async () => {
		c.env.subdomain_domains.push('new');
		const wrong = await worker.fetch(new Request('https://mail.example.com/api/init/wrong/subdomain'), c.env, {});
		expect(wrong.status).toBe(403);
		expect(await first("SELECT domain FROM managed_subdomain WHERE domain = 'new.example.com'")).toBeNull();
		const migrated = await worker.fetch(new Request('https://mail.example.com/api/init/local-test-only/subdomain'), c.env, {});
		expect(await migrated.text()).toBe('success');
		c.env.subdomain_domains = [];
		expect(await policy.isManaged(c, 'never-created@new.example.com')).toBe(true);
	});
	it('validates single labels and safely repeats migration', async () => {
		expect(subdomainName('example.com')).toMatch(/^[a-z0-9]{10}\.example\.com$/);
		expect(subdomainName('example.com', 'shop')).toBe(domain);
		for (const label of ['-bad', 'bad-', 'a.b', 'UPPER', 'a'.repeat(64)]) expect(() => subdomainName('example.com', label)).toThrow();
		expect(() => subdomainConfig({ domain: ['example.com'], subdomain_domains: ['nested.shop'] })).toThrow();
		await service.batchCreate(c, request());
		await migrateSubdomain(c.env.db);
		expect(await first('SELECT count(*) n FROM mailbox_reservation')).toEqual({ n: 1 });
	});
});
