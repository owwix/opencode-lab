---
description: Validate, commit, and push the current branch
agent: lab
---

Publish $ARGUMENTS. Review the current branch and diff, scan for accidental
secrets, run the relevant verification, and stop on material failures. Commit
only the intended files with a clear conventional message. Then use
`github_status` and, after the user approves the publish action, `github_push`
to push the current non-protected branch through the host credential relay.
Use `github_open_pr` only when the user explicitly asks for a pull request.
Never run direct `git push`, force-push, merge, deploy, or rewrite shared history.
Report the commit, remote branch, checks, and anything intentionally excluded.
