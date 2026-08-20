import assert from 'node:assert/strict'
import { test } from 'node:test'

import { decodeEntities, FeedParseError, parseFeedDocument, stripHtml } from '../lib/parser.js'

const RSS = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>Example Feed</title>
    <item>
      <title>First story</title>
      <link>https://example.com/1</link>
      <guid>urn:uuid:111</guid>
      <pubDate>Mon, 17 Aug 2026 08:00:00 GMT</pubDate>
      <description>First description</description>
      <content:encoded><![CDATA[<p>Full body &amp; more</p>]]></content:encoded>
    </item>
    <item>
      <title>Second story</title>
      <link>https://example.com/2</link>
      <pubDate>bad date here</pubDate>
      <description>Second description</description>
    </item>
    <item>
      <title></title>
      <description></description>
      <content></content>
    </item>
  </channel>
</rss>`

test('parses RSS 2.0 with CDATA, entities, and namespaced content', () => {
  const feed = parseFeedDocument(RSS)
  assert.equal(feed.title, 'Example Feed')
  assert.equal(feed.items.length, 2)
  const first = feed.items[0]!
  assert.equal(first.title, 'First story')
  assert.equal(first.link, 'https://example.com/1')
  assert.equal(first.id, 'urn:uuid:111')
  assert.equal(first.publishedAt, '2026-08-17T08:00:00.000Z')
  assert.equal(first.content, '<p>Full body & more</p>')
  assert.equal(first.summary, 'First description')
})

test('invalid dates normalize to empty string', () => {
  const feed = parseFeedDocument(RSS)
  assert.equal(feed.items[1]!.publishedAt, '')
})

test('parses Atom feeds with rel=alternate link selection', () => {
  const atom = `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>Atom Feed</title>
  <entry>
    <title>Entry one</title>
    <id>tag:example.com,2026:1</id>
    <published>2026-08-16T10:00:00Z</published>
    <updated>2026-08-16T11:00:00Z</updated>
    <link rel="self" href="https://example.com/feed"/>
    <link rel="alternate" href="https://example.com/entry/1"/>
    <summary type="html">&lt;b&gt;Summary&lt;/b&gt;</summary>
    <content type="html">Body text</content>
  </entry>
  <entry>
    <title>Entry two</title>
    <link href="https://example.com/entry/2"/>
  </entry>
</feed>`
  const feed = parseFeedDocument(atom)
  assert.equal(feed.title, 'Atom Feed')
  assert.equal(feed.items.length, 2)
  const first = feed.items[0]!
  assert.equal(first.link, 'https://example.com/entry/1')
  assert.equal(first.id, 'tag:example.com,2026:1')
  assert.equal(first.publishedAt, '2026-08-16T10:00:00.000Z')
  assert.equal(first.summary, '<b>Summary</b>')
  assert.equal(feed.items[1]!.link, 'https://example.com/entry/2')
})

test('parses RSS 1.0 (RDF) documents', () => {
  const rdf = `<?xml version="1.0"?>
<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"
         xmlns="http://purl.org/rss/1.0/"
         xmlns:dc="http://purl.org/dc/elements/1.1/">
  <channel rdf:about="https://example.com/">
    <title>RDF Feed</title>
  </channel>
  <item rdf:about="https://example.com/story">
    <title>RDF story</title>
    <link>https://example.com/story</link>
    <description>A description</description>
    <dc:date>2026-08-15T12:00:00Z</dc:date>
  </item>
</rdf:RDF>`
  const feed = parseFeedDocument(rdf)
  assert.equal(feed.title, 'RDF Feed')
  assert.equal(feed.items.length, 1)
  assert.equal(feed.items[0]!.title, 'RDF story')
  assert.equal(feed.items[0]!.publishedAt, '2026-08-15T12:00:00.000Z')
})

test('rejects non-feed documents', () => {
  assert.throws(() => parseFeedDocument('<html><body>oops</body></html>'), FeedParseError)
  assert.throws(() => parseFeedDocument('plain text'), FeedParseError)
  assert.throws(() => parseFeedDocument(''), FeedParseError)
})

test('decodes numeric and named entities', () => {
  assert.equal(decodeEntities('a&amp;b &lt;c&gt; &#65;&#x42; &apos;q&apos; &quot;w&quot; &unknown;'), 'a&b <c> AB \'q\' "w" &unknown;')
})

test('stripHtml removes tags and collapses whitespace', () => {
  assert.equal(stripHtml('<p>Hello  <b>world</b></p> &amp; more'), 'Hello world & more')
})

test('self-closing tags and comments do not corrupt parsing', () => {
  const xml = `<rss version="2.0"><channel title="x"><!-- note --><item><title>A</title><link/></item></channel></rss>`
  const feed = parseFeedDocument(xml)
  assert.equal(feed.items.length, 1)
  assert.equal(feed.items[0]!.link, '')
})