# Pulumi State Management

This directory contains exported Pulumi state files for version control.

## Purpose

Pulumi state files are exported here to:
1. Enable state recovery if the backend is lost
2. Track infrastructure changes in git history
3. Support CI/CD pipelines with state import/export

## Files

- `local.json` - Local development stack state (optional, not committed)
- `prod.json` - Production stack state (committed, encrypted secrets)

## Workflow

### Export state (after successful deploy)

```bash
cd infra/pulumi
pulumi stack export --stack prod > ../state/prod.json
```

### Import state (before deploy in CI)

```bash
cd infra/pulumi
pulumi stack import --stack prod < ../state/prod.json
```

### CI/CD Flow

1. **Import**: Load state from git before operations
2. **Preview**: Show planned changes
3. **Up**: Apply changes (with approval gate)
4. **Export**: Save updated state
5. **Commit**: Push state changes back to git

## Security Notes

- State files contain encrypted secrets (using Pulumi's encryption)
- The encryption salt is stored in `Pulumi.<stack>.yaml`
- Never commit unencrypted secrets
- Treat state files as sensitive (they reveal infrastructure structure)

## Local Development

For local development, state is typically stored in `~/.pulumi` and doesn't
need to be exported here. The `local.json` file is gitignored.
