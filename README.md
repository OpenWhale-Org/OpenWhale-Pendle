# OpenWhale Pendle

Pendle for [OpenWhale](https://github.com/OpenWhale-Org/OpenWhale), in two packages:

| Package | npm | What it is |
|---|---|---|
| [`openwhale-pendle`](./openwhale-pendle) | `@openwhaleorg/pendle` | The venue plugin — Pendle V2 (PT/YT markets) and Boros (interest-rate swaps) under one roof: credential types, adapter cells, account views, operator scripts |
| [`openwhale-pendle-strategy`](./openwhale-pendle-strategy) | `@openwhaleorg/pendle-strategy` | Strategies on top of it — the Boros maker-reward strategy first ([docs](./openwhale-pendle-strategy/README.md) · [中文](./openwhale-pendle-strategy/README.zh-CN.md)) |

Both depend on `@openwhaleorg/core` (and the venue plugin on `@openwhaleorg/web3` for the wallet key family). Install either into a running gateway from the Dashboard's Plugins page — by npm name, or by the absolute path of a local checkout.

## Develop

```sh
pnpm install:all   # each package installs on its own — no workspace hoisting, see .npmrc
pnpm build
pnpm test
```

The `link:` devDependencies expect the OpenWhale repository at `../Paratrix/AI/gmtown/openwhale` relative to this folder; point them at your own checkout, or drop them to develop against the published packages. A plugin loaded into a gateway must share that gateway's `@openwhaleorg/core` module instance, which is why local development links rather than installs it.
