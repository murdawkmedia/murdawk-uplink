# Verified Job Notifications

Purpose: make Murdawk Uplink stop depending on a human or agent babysitting long uploads.

This feature turns every upload into a durable job with a final verified outcome. Notification delivery happens only after the app knows whether the upload truly completed.

## Goals

- Notify a person or agent when an upload finishes.
- Send success only after remote verification passes.
- Send failure when upload, verification, checksum, or notification delivery fails.
- Keep credentials out of Git and out of logs.
- Give Codex, Claude Code, OpenClaw, Hermes, and similar agents a clean machine-readable status surface.

## Job Model

Each upload creates a local job record under an ignored local run directory.

The job stores:

- job id
- source path and file size
- destination prefix
- filter mode and include filter, when custom
- started/completed timestamps
- rclone exit state
- verification result
- checksum result, when enabled
- generated public URLs
- notification delivery attempts

Run logs remain local and ignored by Git under `.runs/logs/<job-id>.log`.

## Pause, Close, And Recovery

`Pause all uploads` applies only to an active check or upload lifecycle owned by the current Uplink window. Uplink first durably saves the queue and a `paused` run record, then stops the current rclone child if one exists; childless planning is held before it can start one. If persistence fails, the pause is rolled back and the lifecycle continues.

When closing during pausable work, the dialog offers:

- `Keep uploading`: keep the app and transfer open. This is the safe default.
- `Pause and close`: persist paused state, stop the owned process, then close.
- `Cancel close`: return to the app without changing the transfer.

After an app restart or power loss, unfinished dry checks and orphaned precheck, upload, or verification work are shown as interrupted. A pause that was already durable or still committing restores as paused instead. Neither state resumes automatically: `Check and resume` starts with a fresh remote pre-check. Completed remote objects with matching sizes are skipped, while provider-managed or rclone partial objects may be retransferred. When a resumed job succeeds, that successful descendant supersedes the original Activity action so it cannot be queued again from the stale record.

## Activity And Logs

The top-level `Activity` view is the everyday durable history. It shows recent run status, source, destination, timestamps, verification, transfer details, and available recovery actions.

Advanced contains the detailed local logs for diagnosis. Log output is credential-redacted and retained locally; Activity remains the simpler place to confirm outcomes or choose `Check and resume`.

## Verification Levels

Default verification uses SHA-256 after size verification:

- collect local file names and sizes
- fail if selected sources match zero files
- list remote objects with `rclone lsjson`
- require every local file to exist remotely with the exact byte size
- compute local SHA-256
- stream the remote object back with `rclone cat`
- compute remote SHA-256
- require hashes to match before marking checksum verification as passed

Size-only verification remains available when the user explicitly chooses speed over full checksum read-back.

Do not rely on S3 multipart ETags as checksums. Large multipart uploads can produce ETags that are not a simple MD5 of the file.

## Notifications

Webhook is the generic first-class target:

```powershell
npm run cli -- upload --source '<file>' --prefix '<prefix>' --checksum full --notify-webhook '<url>' --json
```

Webhook payload should include:

- job id
- status: `complete`, `failed`, or `warning`
- source file name
- destination prefix
- public URLs
- size verification summary
- checksum summary, when enabled
- error message, when present

Email remains out of scope for the first implementation. Webhook and ntfy are implemented first because they are generic and do not require SMTP credentials.

Future email support should be local-config driven:

```powershell
npm run cli -- upload --source '<file>' --prefix '<prefix>' --notify-email 'person@example.com' --json
```

Email sender settings must come from local environment variables or encrypted local settings, never repo files:

- `MURDAWK_UPLINK_SMTP_HOST`
- `MURDAWK_UPLINK_SMTP_PORT`
- `MURDAWK_UPLINK_SMTP_USER`
- `MURDAWK_UPLINK_SMTP_PASS`
- `MURDAWK_UPLINK_SMTP_FROM`

## GUI

The app includes a notification section:

- webhook URL input
- optional email recipient input
- notify on success toggle
- notify on failure toggle
- checksum mode selector: `size` or `sha256`

The Activity view shows the durable run result, combined verification summary, and available transfer details such as bytes and speed. Separate checksum and notification-delivery details remain in Advanced logs when recorded.

Interrupted, paused, cancelled, or failed runs offer `Check and resume` when recovery is valid. Detailed run output remains in Advanced logs.

## Agent Rules

Agents should:

- prefer `status --json` for checking old or app-driven uploads
- prefer `status --job '<job-id>' --json` when a job id is available
- use `--checksum full` for final masters when bandwidth/time is acceptable
- report a completed upload only when `ok: true`
- reject an empty verification set when sources were selected
- report notification delivery separately from upload verification

Agents should not:

- read `rclone.conf`, `s3cmd.ini`, `.env`, or SMTP secrets
- put webhook URLs with secrets into committed docs
- claim `Transferred: 100%` means success before verification

## Acceptance Tests

- Size-only upload returns `ok: true` only after remote object sizes match.
- Wrong filters that match zero local files return blocked/failed status instead of verified.
- Failed size verification exits nonzero and sends a failure notification when configured.
- Full checksum mode detects a remote/local mismatch.
- Webhook receives a success payload only after verification passes.
- Webhook delivery failure does not relabel a verified upload as failed; it reports notification failure separately.
- GUI stores notification preferences without storing SMTP passwords or DigitalOcean keys.
