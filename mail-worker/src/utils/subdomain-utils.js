const labelPattern = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

export function randomLabel(length = 10) {
	const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789';
	let value = '';
	while (value.length < length) {
		for (const byte of crypto.getRandomValues(new Uint8Array(length))) {
			if (byte < 252 && value.length < length) value += alphabet[byte % 36];
		}
	}
	return value;
}

export function validBaseDomain(value) {
	return typeof value === 'string' && value.length <= 253 && value.split('.').length >= 2
		&& value.split('.').every(label => labelPattern.test(label)) && /\.[a-z]{2,}$/.test(value);
}

export function subdomainName(base, label = randomLabel()) {
	if (!validBaseDomain(base) || !labelPattern.test(label) || `${label}.${base}`.length > 253) {
		throw new Error('INVALID_SUBDOMAIN_CONFIG');
	}
	return `${label}.${base}`;
}

export function subdomainConfig(env) {
	let labels = env.subdomain_domains ?? [];
	let bases = env.domain ?? [];
	try {
		if (typeof labels === 'string') labels = JSON.parse(labels);
		if (!Array.isArray(labels) || labels.some(label => typeof label !== 'string' || !labelPattern.test(label))) {
			throw new Error();
		}
		// Disabled feature must not impose extra validation on legacy domain settings.
		if (!labels.length) return { domains: [] };
		if (typeof bases === 'string') bases = JSON.parse(bases);
		if (!Array.isArray(bases) || !bases.length || bases.some(base => !validBaseDomain(base))) throw new Error();
	} catch {
		throw new Error('INVALID_SUBDOMAIN_CONFIG');
	}
	// Each configured label applies to every existing mailbox base domain.
	const domains = [...new Set(bases)].flatMap(base => [...new Set(labels)].map(label => subdomainName(base, label)));
	return { domains };
}
