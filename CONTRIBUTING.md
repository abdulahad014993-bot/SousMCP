# Contributing to SousMCP

## Getting started

```bash
git clone https://github.com/abdulahad014993/SousMCP.git
cd SousMCP
npm install
npm run build
```

## Project structure

```
packages/
├── proxy/   — core daemon (TypeScript, Node.js)
├── shared/  — types shared across packages
└── ui/      — React dashboard (Vite, WIP)
```

## Workflow

1. Fork the repo and create a feature branch from `main`
2. Make your changes
3. Run `npm run lint` — must pass with zero errors
4. Run `npm run build` — must compile cleanly
5. Open a pull request with a clear description of what and why

## Code style

- TypeScript strict mode throughout
- No comments unless the *why* is non-obvious
- Prefer editing existing files over creating new ones
- No half-finished implementations — complete the feature or open a draft PR

## Reporting bugs

Open a GitHub Issue with:
- Node.js version (`node --version`)
- Steps to reproduce
- Expected vs actual behaviour
