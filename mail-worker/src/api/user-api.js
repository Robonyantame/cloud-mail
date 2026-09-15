import app from '../hono/hono';
import userService from '../service/user-service';
import result from '../model/result';
import userContext from '../security/user-context';
import accountService from '../service/account-service';
import subdomainMailboxService from '../service/subdomain-mailbox-service';
import { subdomainConfig } from '../utils/subdomain-utils';
import BizError from '../error/biz-error';
import { bodyLimit } from 'hono/body-limit';

// Browser access uses the signed-in administrator, never a public token embedded in UI.
app.use('/user/subdomainMailbox/*', async (c, next) => {
	if (userContext.getUserId(c) !== await subdomainMailboxService.admin(c)) {
		throw new BizError('ADMIN_REQUIRED', 403);
	}
	return next();
});
app.use('/user/subdomainMailbox/*', bodyLimit({ maxSize: 65536,
	onError: c => c.json(result.fail('REQUEST_TOO_LARGE', 413)) }));
app.get('/user/subdomainMailbox/domains', c => c.json(result.ok(subdomainConfig(c.env).domains)));
app.post('/user/subdomainMailbox/batchCreate', async c => {
	const data = await subdomainMailboxService.batchCreate(c, await c.req.json());
	// Keep the browser's existing response envelope; processing is explicit in data.
	if (data.status === 'processing') c.header('Retry-After', String(data.retryAfter));
	return c.json(result.ok(data));
});

app.delete('/user/delete', async (c) => {
	await userService.physicsDelete(c, c.req.query());
	return c.json(result.ok());
});

app.put('/user/setPwd', async (c) => {
	await userService.setPwd(c, await c.req.json());
	return c.json(result.ok());
});

app.put('/user/setStatus', async (c) => {
	await userService.setStatus(c, await c.req.json());
	return c.json(result.ok());
});

app.put('/user/setType', async (c) => {
	await userService.setType(c, await c.req.json());
	return c.json(result.ok());
});

app.get('/user/list', async (c) => {
	const data = await userService.list(c, c.req.query(), userContext.getUserId(c));
	return c.json(result.ok(data));
});

app.post('/user/add', async (c) => {
	await userService.add(c, await c.req.json());
	return c.json(result.ok());
});

app.put('/user/resetSendCount', async (c) => {
	await userService.resetSendCount(c, await c.req.json());
	return c.json(result.ok());
});

app.put('/user/restore', async (c) => {
	await userService.restore(c, await c.req.json());
	return c.json(result.ok());
});

app.get('/user/allAccount', async (c) => {
	const data = await accountService.allAccount(c, c.req.query());
	return c.json(result.ok(data));
});

app.delete('/user/deleteAccount', async (c) => {
	await accountService.physicsDelete(c, c.req.query());
	return c.json(result.ok());
});


