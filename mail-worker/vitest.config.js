import { defineWorkersConfig } from '@cloudflare/vitest-pool-workers/config';

export default defineWorkersConfig({
	test: {
		fileParallelism: false,
		poolOptions: {
			workers: {
				// Deliberately independent of deploy configs, production IDs and build hooks.
				miniflare: {
					compatibilityDate: '2025-06-04',
					compatibilityFlags: ['nodejs_compat'],
					d1Databases: ['db'],
					kvNamespaces: ['kv'],
				},
			},
		},
	},
});
