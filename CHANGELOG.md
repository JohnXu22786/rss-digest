# Changelog

All notable changes to this project are documented in this file. The format is
based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this
project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.0] - 2026-08-20

Initial release as a dsh (DeepSeek Harness) bundle.

### Added

- Feed subscription management (RSS 2.0, Atom, RSS 1.0/RDF) with versioned
  local persistence, atomic writes, and corruption quarantine.
- Scheduled fetching with configurable interval, timeout, size cap, retries,
  and item retention caps.
- Exact-hash and token-Jaccard (CJK-aware) near-duplicate detection.
- LLM-powered summaries (Chinese or English) with deterministic extractive
  fallback when the model is unavailable.
- Daily Markdown digests delivered to live conversations and/or files, with an
  optional IANA timezone.
- Dual entry points: dsh tools plus a standalone CLI (`dsh-rss-digest`).
