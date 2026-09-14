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
	const base = env.subdomain_base || '';
	let domains = env.subdomain_domains || [];
	if (typeof domains === 'string') domains = JSON.parse(domains);
	if (!Array.isArray(domains) || (base && !validBaseDomain(base))) throw new Error('INVALID_SUBDOMAIN_CONFIG');
	for (const domain of domains) {
		if (typeof domain !== 'string' || !base || !domain.endsWith(`.${base}`)
			|| subdomainName(base, domain.slice(0, -(base.length + 1))) !== domain) {
			throw new Error('INVALID_SUBDOMAIN_CONFIG');
		}
	}
	return { base, domains: [...new Set(domains)] };
}
