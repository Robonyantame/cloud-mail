import { subdomainName } from '../src/utils/subdomain-utils.js';

const [base, label, ...rest] = process.argv.slice(2);
try {
	if (rest.length) throw new Error('Too many arguments');
	console.log(subdomainName(base, label));
} catch (error) {
	console.error('Usage: npm run subdomain:name -- example.com [custom-label]');
	console.error(error.message);
	process.exitCode = 1;
}
