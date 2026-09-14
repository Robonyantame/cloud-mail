import app from '../hono/hono';
import { dbInit } from '../init/init';
import { migrateSubdomain } from '../init/subdomain-schema';
import subdomainPolicy from '../service/subdomain-policy';
import settingService from '../service/setting-service';

// For an existing initialized database; does not rerun older migrations.
app.get('/init/:secret/subdomain', async c => {
	if (c.req.param('secret') !== c.env.jwt_secret) return c.text('JWT secret mismatch', 403);
	await migrateSubdomain(c.env.db);
	await subdomainPolicy.rememberDomains(c);
	await settingService.refresh(c);
	return c.text('success');
});

app.get('/init/:secret', (c) => {
	return dbInit.init(c);
})
