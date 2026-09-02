# config-migrations

Committed configuration documents as wrkrs actually wrote or would have
accepted them, so schema migrations keep being exercised against real artifacts
rather than YAML the tests construct for themselves.

- `config-v1.yaml` — schema version 1 with owner comments and empty `providers`
- `config-v1-governance-edit.yaml` — version 1 with a hand edit to governance
- `config-v2.yaml` — schema version 2 with `execution.profile` and empty `providers`
- `config-v2-blocked-providers.yaml` — version 2 whose non-empty `providers` map must block
