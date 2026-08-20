import assert from 'node:assert/strict'
import { test } from 'node:test'

import { findDuplicate, hashText, itemHash, normalizeText, tokenSimilarity } from '../lib/dedupe.js'

test('normalizeText folds case and punctuation for latin text', () => {
  assert.equal(normalizeText('Hello,  World!  '), 'hello world')
  assert.equal(normalizeText('Hello, World!'), normalizeText('hello world'))
})

test('normalizeText drops separators for CJK text', () => {
  assert.equal(normalizeText('你好，世界！'), normalizeText('你好 世界'))
})

test('tokenSimilarity measures overlap', () => {
  assert.equal(tokenSimilarity('hello world foo', 'hello world foo bar'), 0.75)
  assert.equal(tokenSimilarity('hello world', 'completely different things'), 0)
  assert.equal(tokenSimilarity('你好世界', '你好世界'), 1)
  assert.equal(tokenSimilarity('一网打尽', '一网打尽新技术'), 0.5)
  assert.equal(tokenSimilarity('你好世界', '好世界你好'), 0.75)
})

test('itemHash distinguishes title case but collapses near-equal titles', () => {
  assert.equal(itemHash('Breaking News!', 'body', true), itemHash('breaking news', 'body', false))
  assert.notEqual(itemHash('Breaking News', 'body', false), itemHash('Other News', 'body', false))
})

test('itemHash falls back to body when the title is empty and compareContent is on', () => {
  assert.equal(itemHash('', 'same body text', true), itemHash('', 'same body text', true))
  assert.notEqual(itemHash('', 'body A', true), itemHash('', 'body B', true))
  // Without content comparison, empty titles all collapse to the same token.
  assert.equal(itemHash('', 'body A', false), itemHash('', 'body B', false))
})

test('findDuplicate matches exactly and near-equivalently', () => {
  const known = [
    { title: 'Breaking: market opens lower', hash: hashText('t:breaking market opens lower') },
  ]
  const exact = findDuplicate(
    { title: 'Breaking: market opens lower', hash: hashText('t:breaking market opens lower') },
    known,
    { threshold: 0.9, compareContent: true },
  )
  assert.ok(exact !== undefined)
  const fuzzy = findDuplicate(
    { title: 'Breaking market opens lower', hash: hashText('t:something different') },
    known,
    { threshold: 0.8, compareContent: true },
  )
  assert.ok(fuzzy !== undefined)
  const distinct = findDuplicate(
    { title: 'Unrelated headline about coffee', hash: hashText('t:unrelated headline about coffee') },
    known,
    { threshold: 0.9, compareContent: true },
  )
  assert.equal(distinct, undefined)
})