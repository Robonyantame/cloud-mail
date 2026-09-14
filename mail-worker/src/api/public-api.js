import app from '../hono/hono';
import result from '../model/result';
import publicService from '../service/public-service';
import subdomainMailboxService from '../service/subdomain-mailbox-service';
import { bodyLimit } from 'hono/body-limit';

app.use('/public/subdomainMailbox/*', bodyLimit({ maxSize: 65536,
	onError: c => c.json(result.fail('REQUEST_TOO_LARGE', 413), 413) }));
app.post('/public/subdomainMailbox/batchCreate', async c => {
	const data = await subdomainMailboxService.batchCreate(c, await c.req.json());
	if (data.status === 'processing') {
		c.header('Retry-After', String(data.retryAfter));
		return c.json({ code: 202, message: 'processing', data }, 202);
	}
	return c.json(result.ok(data));
});
app.get('/public/subdomainMailbox/list', async c => c.json(result.ok(await subdomainMailboxService.list(c, c.req.query()))));
app.get('/public/subdomainMailbox/emails', async c => c.json(result.ok(await subdomainMailboxService.emails(c, c.req.query()))));
app.post('/public/subdomainMailbox/disable', async c => c.json(result.ok(await subdomainMailboxService.setStatus(c, await c.req.json(), false))));
app.post('/public/subdomainMailbox/enable', async c => c.json(result.ok(await subdomainMailboxService.setStatus(c, await c.req.json(), true))));

app.post('/public/genToken', async (c) => {
	const data = await publicService.genToken(c, await c.req.json());
	return c.json(result.ok(data));
});

app.post('/public/emailList', async (c) => {
	const list = await publicService.emailList(c, await c.req.json());
	return c.json(result.ok(list));
});

app.post('/public/addUser', async (c) => {
	await publicService.addUser(c, await c.req.json());
	return c.json(result.ok());
});
