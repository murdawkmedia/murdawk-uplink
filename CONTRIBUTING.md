# Contributing

Thanks for helping improve Murdawk Uplink. Transfer and credential changes can affect real data, so small, reviewable pull requests are preferred.

1. Do not include credentials, connection packages, local manifests, logs, or personal paths.
2. Run `npm ci`, `npm test`, and `npm run ui:smoke` from `app/`.
3. Use fictional connection and event data in tests and documentation.
4. Describe transfer-safety and credential-boundary changes in the pull request.

Use dry runs when changing rclone command construction. Tests and CI must not configure rclone, contact a real DigitalOcean Space, or mutate remote data.

By submitting a contribution, you agree that it is licensed under the Apache License 2.0.
