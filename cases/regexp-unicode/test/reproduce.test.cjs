'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const escapeStringRegexp = require('../src/index.js');

test('escaped hyphens compile and match literally in Unicode mode', () => {
	for (const input of ['-', 'a-b', '--', 'foo - bar']) {
		let pattern;
		assert.doesNotThrow(() => {
			pattern = new RegExp(`^(?:${escapeStringRegexp(input)})$`, 'u');
		});
		assert.equal(pattern.test(input), true);
		assert.equal(pattern.test(`${input}x`), false);
		assert.equal(pattern.test(''), false);
	}
});
