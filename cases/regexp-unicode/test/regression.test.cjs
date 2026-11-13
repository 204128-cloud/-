'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const escapeStringRegexp = require('../src/index.js');

test('hyphens remain literal inside a non-Unicode character class', () => {
	const pattern = new RegExp(`^[${escapeStringRegexp('a-z')}]$`);
	for (const input of ['a', '-', 'z']) assert.equal(pattern.test(input), true);
	assert.equal(pattern.test('m'), false);
});

test('regular expression metacharacters retain literal meaning', () => {
	for (const input of '|\\{}()[\]^$+*?.') {
		const pattern = new RegExp(`^(?:${escapeStringRegexp(input)})$`, 'u');
		assert.equal(pattern.test(input), true);
		assert.equal(pattern.test('x'), false);
	}
});

test('ordinary text is unchanged', () => {
	assert.equal(escapeStringRegexp('hello 123_世界'), 'hello 123_世界');
});

test('empty input is unchanged', () => {
	assert.equal(escapeStringRegexp(''), '');
});

test('non-string inputs retain TypeError validation', () => {
	for (const input of [undefined, null, 42, true, {}, []]) {
		assert.throws(() => escapeStringRegexp(input), { name: 'TypeError', message: 'Expected a string' });
	}
});

test('repeated calls escape every occurrence without retained state', () => {
	const input = 'a.b+c?';
	const expected = 'a\\.b\\+c\\?';
	assert.equal(escapeStringRegexp(input), expected);
	assert.equal(escapeStringRegexp(input), expected);
});
