# Contributing

## Development

```sh
bun install
npm run build      # web (Vite) + CLI (esbuild) + bundle content check
bun test test/     # unit and integration tests with fake agent CLIs
node e2e/run.mjs   # packs, installs, and drives the UI in headless Chrome (CHROME_PATH)
```

See `THIRD_PARTY_NOTICES.md` for licenses of adapted material.

## Publishing to npm

The [publish workflow](.github/workflows/publish.yml) runs when a `v*` tag is pushed.
It checks that the tag matches `package.json`, installs from the Bun lockfile, runs
the typecheck and tests, builds the web app and CLI, and tests the installed package
in Chrome before publishing with provenance. Stable versions use `latest`;
prerelease versions such as `0.2.0-beta.1` use `next`.
Running the workflow manually verifies the build and package without publishing.
The test steps have separate time limits so a stuck test fails promptly.

For the first release, create an [npm granular access token](https://docs.npmjs.com/creating-and-viewing-access-tokens/)
with package permission **Read and write (publish and stage)**, **All Packages**
selected for this first unscoped package, and **Bypass 2FA** enabled.
Save it as `NPM_TOKEN` in the repository's
[Actions secrets](https://github.com/victor-teles/grillado/settings/secrets/actions).
The package is public and users need only Node.js to run it; Bun is used to build and test it.

Commit the workflow and build fixes, then publish the current version:

```sh
git tag v0.1.0
git push origin main v0.1.0
```

For subsequent releases, start with a clean, up-to-date `main` branch:

```sh
npm version patch
git push origin main --follow-tags
```

After the first release, configure [npm trusted publishing](https://docs.npmjs.com/trusted-publishers/)
in the package settings. Choose GitHub Actions, owner `victor-teles`, repository
`grillado`, and workflow filename `publish.yml`, with no environment name. Allow
direct `npm publish`. Then remove `NPM_TOKEN` from GitHub and revoke the bootstrap
token. The workflow has `id-token: write` permission, so future releases can use
OIDC without a stored npm token.

Check the Actions run and the [npm package](https://www.npmjs.com/package/grillado)
after each release. Once published, users can run `npx grillado` or install it with
`npm install --global grillado`.
