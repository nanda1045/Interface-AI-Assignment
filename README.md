# CorePoint Computer-Use Automation

An end-to-end computer-use system that discovers a workflow with an LLM, saves it as a typed capability, and replays it deterministically against a deliberately hostile legacy banking UI.

The implementation is being built in reviewable phases. Setup and the complete demo path will be documented here as each vertical slice lands.

## Mock application

```bash
corepack pnpm install
corepack pnpm app
```

- Tenant A: <http://localhost:4478/login>
- Tenant B: <http://localhost:4479/login>
- Demo credentials: `teller1` / `training-only`

All data is fictional. The app is intentionally built with iframes, nested tables, full-page navigation, sparse semantics, and no test IDs.
