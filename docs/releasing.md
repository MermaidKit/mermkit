# Releasing

## Sync versions

Update all packages and bindings to the same version:

```
npm run version:sync -- --version 0.1.0
```

Or prepare a release (sync + changelog entry):

```
npm run release:prepare -- --version 0.1.0 --notes "Short summary"
```

This updates:
- root `package.json`
- `packages/*/package.json` (and internal `@mermkit/*` dependencies)
- `bindings/python/pyproject.toml`
- `bindings/rust/Cargo.toml`

## Publish

### Trusted Publishing (recommended)

Use GitHub Actions OIDC for npm + PyPI to avoid long‑lived tokens.

- npm: configure a Trusted Publisher in npm for `MermaidKit/mermkit`, then tag a release (`vX.Y.Z`). The workflow runs `npm publish --provenance`.
- PyPI: add a Trusted Publisher in PyPI for `MermaidKit/mermkit`, then tag a release. The workflow uses `pypa/gh-action-pypi-publish`.
- crates.io: still requires `CARGO_REGISTRY_TOKEN` in GitHub Secrets.

### npm

```
npm run publish:npm
```

### PyPI

```
python -m pip install build twine
npm run publish:pypi
```

### crates.io

```
cargo login <token>
npm run publish:crates
```

## All

```
npm run publish:all
```
