# Resolve Merge Conflicts

Inline helper for prep-pr.md **Stage 5** (branch update). You are resolving merge
conflicts on a PR's own feature branch (`{{HEAD_BRANCH}}`). Pushes here go ONLY
to that feature branch — never to `{{BASE_BRANCH}}`, a new remote, or via
force-push (those ALWAYS stop and escalate to ESCALATIONS.md; see the harness preamble).

## Steps

1. **Identify conflicts**:
   ```bash
   git diff --name-only --diff-filter=U
   ```

2. **For each conflicted file**:
   - Read both versions
   - Resolve by preferring the PR branch's intent (the feature being added)
   - Keep base branch structural changes (renames, formatting) where they don't conflict with the feature
   - When in doubt, keep the PR branch version and note the resolution

3. **After resolving all conflicts**:
   ```bash
   git add .
   git commit -m "chore: resolve merge conflicts"
   ```

4. **Verify**:
   - Run lint to ensure no syntax errors
   - Run quick tests to ensure nothing is broken
   - If lint/tests fail, fix and commit again

5. **Push to the PR's own feature branch**:
   ```bash
   git push origin HEAD:{{HEAD_BRANCH}}
   ```

## Output

- `RESULT: RESOLVED` — All conflicts resolved, lint passes, pushed to the feature branch
- `RESULT: STUCK: [reason]` — Could not resolve conflicts automatically (explain which files and why)

## Rules

- NEVER drop changes from either side silently — always explain your resolution logic
- If a conflict involves generated files (lock files, etc.), regenerate them rather than manually merging
- If a conflict is in test expectations, prefer the PR branch values and re-run tests to verify
