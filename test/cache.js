import { request } from 'http';
import url from 'url';
import test from 'ava';
import getStream from 'get-stream';
import createTestServer from 'create-test-server';
import delay from 'delay';
import cacheableRequest from '../';

let s;

// Simple wrapper that returns a promise, reads stream and sets up some options
const cacheableRequestHelper = (path, o) => new Promise(resolve => {
	const opts = Object.assign({}, url.parse(s.url + path), o);
	cacheableRequest(request, opts, response => {
		getStream(response).then(body => {
			response.body = body;
			resolve(response);
		});
	}).on('request', req => req.end());
});

test.before('setup', async () => {
	s = await createTestServer();

	let noStoreIndex = 0;
	s.get('/no-store', (req, res) => {
		noStoreIndex++;
		res.setHeader('Cache-Control', 'public, no-cache, no-store');
		res.end(noStoreIndex.toString());
	});

	let cacheIndex = 0;
	s.get('/cache', (req, res) => {
		cacheIndex++;
		res.setHeader('Cache-Control', 'public, max-age=60');
		res.end(cacheIndex.toString());
	});

	s.get('/last-modified', (req, res) => {
		res.setHeader('Cache-Control', 'public, max-age=0');
		res.setHeader('Last-Modified', 'Wed, 21 Oct 2015 07:28:00 GMT');
		let responseBody = 'last-modified';

		if (req.headers['if-modified-since'] === 'Wed, 21 Oct 2015 07:28:00 GMT') {
			res.statusCode = 304;
			responseBody = null;
		}

		res.end(responseBody);
	});

	s.get('/etag', (req, res) => {
		res.setHeader('Cache-Control', 'public, max-age=0');
		res.setHeader('ETag', '33a64df551425fcc55e4d42a148795d9f25f89d4');
		let responseBody = 'etag';

		if (req.headers['if-none-match'] === '33a64df551425fcc55e4d42a148795d9f25f89d4') {
			res.statusCode = 304;
			responseBody = null;
		}

		res.end(responseBody);
	});

	s.get('/revalidate-modified', (req, res) => {
		res.setHeader('Cache-Control', 'public, max-age=0');
		res.setHeader('ETag', '33a64df551425fcc55e4d42a148795d9f25f89d4');
		let responseBody = 'revalidate-modified';

		if (req.headers['if-none-match'] === '33a64df551425fcc55e4d42a148795d9f25f89d4') {
			res.setHeader('ETag', '0000000000000000000000000000000000');
			responseBody = 'new-body';
		}

		res.end(responseBody);
	});

	s.get('/etag-cache-1s', (req, res) => {
		res.setHeader('Cache-Control', 'public, max-age=1');
		res.setHeader('ETag', '33a64df551425fcc55e4d42a148795d9f25f89d4');
		let responseBody = 'etag-cache-1s';

		if (req.headers['if-none-match'] === '33a64df551425fcc55e4d42a148795d9f25f89d4') {
			res.statusCode = 304;
			responseBody = null;
		}

		res.end(responseBody);
	});

	let cacheThenNoStoreIndex = 0;
	s.get('/cache-then-no-store-on-revalidate', (req, res) => {
		const cc = cacheThenNoStoreIndex === 0 ? 'public, max-age=0' : 'public, no-cache, no-store';
		cacheThenNoStoreIndex++;
		res.setHeader('Cache-Control', cc);
		res.end('cache-then-no-store-on-revalidate');
	});

	await s.listen(s.port);
});

test('Non cacheable responses are not cached', async t => {
	const endpoint = '/no-store';
	const cache = new Map();

	const firstResponseInt = Number((await cacheableRequestHelper(endpoint, { cache })).body);
	const secondResponseInt = Number((await cacheableRequestHelper(endpoint, { cache })).body);

	t.is(cache.size, 0);
	t.true(firstResponseInt < secondResponseInt);
});

test('Cacheable responses are cached', async t => {
	const endpoint = '/cache';
	const cache = new Map();

	const firstResponse = await cacheableRequestHelper(endpoint, { cache });
	const secondResponse = await cacheableRequestHelper(endpoint, { cache });

	t.is(cache.size, 1);
	t.is(firstResponse.body, secondResponse.body);
});

test('Cacheable responses have unique cache key', async t => {
	const endpoint = '/cache';
	const cache = new Map();

	const firstResponse = await cacheableRequestHelper(endpoint + '?foo', { cache });
	const secondResponse = await cacheableRequestHelper(endpoint + '?bar', { cache });

	t.is(cache.size, 2);
	t.not(firstResponse.body, secondResponse.body);
});

test('TTL is passed to cache', async t => {
	const endpoint = '/cache';
	const store = new Map();
	const cache = {
		get: store.get.bind(store),
		set: (key, val, ttl) => {
			t.true(typeof ttl === 'number');
			t.true(ttl > 0);
			return store.set(key, val, ttl);
		},
		delete: store.delete.bind(store)
	};

	t.plan(2);

	await cacheableRequestHelper(endpoint, { cache, strictTtl: true });
});

test('Stale cache entries with Last-Modified headers are revalidated', async t => {
	const endpoint = '/last-modified';
	const cache = new Map();

	const firstResponse = await cacheableRequestHelper(endpoint, { cache });
	const secondResponse = await cacheableRequestHelper(endpoint, { cache });

	t.is(cache.size, 1);
	t.is(firstResponse.statusCode, 200);
	t.is(secondResponse.statusCode, 304);
	t.is(firstResponse.body, 'last-modified');
	t.is(firstResponse.body, secondResponse.body);
});

test('Stale cache entries with ETag headers are revalidated', async t => {
	const endpoint = '/etag';
	const cache = new Map();

	const firstResponse = await cacheableRequestHelper(endpoint, { cache });
	const secondResponse = await cacheableRequestHelper(endpoint, { cache });

	t.is(cache.size, 1);
	t.is(firstResponse.statusCode, 200);
	t.is(secondResponse.statusCode, 304);
	t.is(firstResponse.body, 'etag');
	t.is(firstResponse.body, secondResponse.body);
});

test('Stale cache entries that can\'t be revalidate are deleted from cache', async t => {
	const endpoint = '/cache-then-no-store-on-revalidate';
	const cache = new Map();

	const firstResponse = await cacheableRequestHelper(endpoint, { cache });
	t.is(cache.size, 1);
	const secondResponse = await cacheableRequestHelper(endpoint, { cache });

	t.is(cache.size, 0);
	t.is(firstResponse.statusCode, 200);
	t.is(secondResponse.statusCode, 200);
	t.is(firstResponse.body, 'cache-then-no-store-on-revalidate');
	t.is(firstResponse.body, secondResponse.body);
});

test('Response objects have fromCache property set correctly', async t => {
	const endpoint = '/cache';
	const cache = new Map();

	const response = await cacheableRequestHelper(endpoint, { cache });
	const cachedResponse = await cacheableRequestHelper(endpoint, { cache });

	t.false(response.fromCache);
	t.true(cachedResponse.fromCache);
});

test('Revalidated responses that are re-cached return 304 but 200 on subsequent cache responses', async t => {
	const endpoint = '/etag-cache-1s';
	const cache = new Map();

	const firstResponse = await cacheableRequestHelper(endpoint, { cache });
	await delay(1100);
	const secondResponse = await cacheableRequestHelper(endpoint, { cache });
	const thirdResponse = await cacheableRequestHelper(endpoint, { cache });

	t.is(firstResponse.statusCode, 200);
	t.false(firstResponse.fromCache);
	t.is(secondResponse.statusCode, 304);
	t.true(secondResponse.fromCache);
	t.is(thirdResponse.statusCode, 200);
	t.true(thirdResponse.fromCache);
});

test('Revalidated responses that are modified are passed through', async t => {
	const endpoint = '/revalidate-modified';
	const cache = new Map();

	const firstResponse = await cacheableRequestHelper(endpoint, { cache });
	const secondResponse = await cacheableRequestHelper(endpoint, { cache });

	t.is(firstResponse.statusCode, 200);
	t.is(secondResponse.statusCode, 200);
	t.is(firstResponse.body, 'revalidate-modified');
	t.is(secondResponse.body, 'new-body');
});

test.cb('Undefined callback parameter inside cache logic is handled', t => {
	const endpoint = '/cache';
	const cache = new Map();
	const opts = Object.assign({}, url.parse(s.url + endpoint), { cache });

	cacheableRequestHelper(endpoint, { cache }).then(() => {
		cacheableRequest(request, opts);
		setTimeout(() => {
			t.end();
		}, 500);
	});
});

test.after('cleanup', async () => {
	await s.close();
});
