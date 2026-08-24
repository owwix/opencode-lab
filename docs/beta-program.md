# Beta program

The `v0.1.0-beta.1` cohort targets approximately ten founder/operators using
unrelated repositories. Participation is opt-in; no product telemetry is sent.

Before inviting a user, the maintainer records a five-repository local dogfood
report without modifying those repositories:

```bash
npm run release:dogfood -- /path/one /path/two /path/three /path/four /path/five
```

For each beta participant, record only consented operational outcomes: supported
Mac/Docker versions, setup duration, launch success or actionable failure,
upgrade/rollback result, and whether an external session completed. Never copy
project code, prompts, credentials, or agent transcripts into the cohort log.

The beta is ready to tag only after the Phase 4 gate passes, the tag is signed,
the changelog and migration manifest name the version, fresh-clone setup stays
under 15 minutes on supported macOS/Apple silicon, and update, rollback, and
uninstall recovery have been exercised. Recruitment and tag publication remain
explicit owner actions rather than automated side effects of a pull request.
