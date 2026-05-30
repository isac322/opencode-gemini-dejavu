# Changelog

All notable changes to `opencode-gemini-dejavu` are documented here. Version numbers follow [Semantic Versioning](https://semver.org/).

## 0.2.2 - 2026-05-30

- Add MIT `LICENSE` and `license` field in `package.json`.
- Add `homepage`, `bugs`, and `author` fields so npmjs.com surfaces repo/issues/author links.
- Expand `keywords` with `thought-signature`, `vertex-ai`, and `google-gemini`.
- Add `CHANGELOG.md`.
- Add badges and an Installation section to `README.md`.
- Release workflow now generates GitHub Release notes from the commit log between the previous `v*` tag and the new one, instead of relying on `--generate-notes`.

## 0.2.1 - 2026-05-30

- Switch npm publishing to OIDC trusted publishing. The release workflow no longer needs a long-lived `NPM_TOKEN` secret, and provenance is generated automatically.
- Add `repository` field in `package.json` so trusted publishing can validate the GitHub repo.

## 0.2.0 - 2026-05-29

- Add `chat.params` hook that sets `thinkingConfig.includeThoughts: false` on outgoing Gemini requests. Mitigates the thinking-budget runaway mode where the model burns the entire `maxOutputTokens` budget on internal thinking and emits no visible output (`finishReason: STOP` with `candidatesTokenCount: 1`).
- New `disableThoughtSuppression` option to keep visible thought summaries when debugging.

## 0.1.0 - 2026-05-29

- Initial release.
- `experimental.chat.messages.transform` hook that detects repeated Gemini 3.x tool-call tails and inserts a request-local `role: "user"` boundary right before the latest assistant tool-call message.
- Prunes older repeated `thoughtSignature` values while preserving the latest current-turn signature.
- Conservative defaults: `callRepeat: 3`, `batchRepeat: 2`, `prune: "repeated"`, `dryRun: false`.
- Repo-local fixture and harness (`fixtures/minimal-loop`, `test-fixture.ts`, `test-hook.ts`). Tests are excluded from the npm tarball.
