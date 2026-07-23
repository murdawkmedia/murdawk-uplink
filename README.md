# Murdawk Uplink

Murdawk Uplink is a desktop file browser and resumable transfer manager for DigitalOcean Spaces, powered by rclone. It uploads, downloads, verifies, and recovers large media transfers through a Drive-style interface.

## Features

- Browse multiple DigitalOcean Spaces from one desktop app.
- Drag files and folders into the current remote folder.
- Pre-check every upload, transfer it with retries, and verify the remote result.
- Download mixed selections of files and folders into one local destination.
- Pause supported transfers and recover interrupted work after a restart or power loss.
- Preview PNG, JPEG, WebP, GIF, and AVIF images without exposing storage credentials to the renderer.
- Import and export connection packages, with optional password-encrypted credentials.
- Reconcile manifest-driven event folders and queue only missing files.
- Inspect durable activity, local redacted logs, progress, speed, and practical ETAs.
- Expose a narrow local API and MCP adapter for browsing and queue preparation.

Uploads do not start from the local API, MCP, or event reconcile screen. A person reviews and starts transfer work in the app.

## Requirements

- Windows 10 or later
- Node.js 22 or later for development
- [rclone](https://rclone.org/) available on `PATH`
- A DigitalOcean Spaces account and an rclone S3 profile

## Install

Clone the repository, install dependencies, and start the development build:

```powershell
git clone https://github.com/murdawkmedia/murdawk-uplink.git
Set-Location .\murdawk-uplink\app
npm ci
npm start
```

To create a desktop shortcut for the installed app or development checkout:

```powershell
Set-Location ..
powershell -ExecutionPolicy Bypass -File .\scripts\install-desktop-shortcut.ps1
```

The installer script prefers an installed per-user build and otherwise uses the repository-relative launcher. It does not embed the checkout location in source control.

## Connections

Open **Connections** to add an existing rclone profile or create a DigitalOcean Spaces profile. Uplink stores only non-secret connection metadata such as the profile name, Space name, endpoint, and display name. Credentials stay in the user's local rclone configuration.

Connection exports omit credentials by default. A user may explicitly include credentials in a password-encrypted package after acknowledging the warning. Import shows a connection preview and requires confirmation before saving anything locally.

Fictional example values used by the project are:

```text
Connection name: Media Archive
rclone profile: media
Space: media-archive
Endpoint: nyc3.digitaloceanspaces.com
```

## Transfers And Recovery

Open a destination folder, then drag files or folders into the Explorer or use **Upload files** and **Upload folder**. The transfer shelf shows each job moving through clear stages:

```text
Checking -> Ready -> Uploading -> Verifying -> Complete
```

Folders upload as a package by default, so a local `assets` folder becomes `destination/assets/...`. Empty leaf folders are represented by verified `.keep` objects.

Queue state and run history are durable. Interrupted or paused work never resumes blindly: **Check and resume** performs a fresh remote pre-check, skips matching objects, and transfers what is still needed. A full progress bar is not treated as completion until verification succeeds.

Downloads use the same transfer shelf and recovery model. Select files and folders together, choose **Download**, and select a local destination.

## Event Manifests

Event manifests describe an event prefix, recording stages, days, local roots, and non-secret transfer defaults. Open **Advanced**, choose **Open manifest**, select local roots, and run **Reconcile**. Reconcile is read-only and separates matched, missing, size-mismatched, and ambiguous files. **Queue Missing** prepares guarded jobs without starting an upload.

A fictional example is available at [examples/sample-event-manifest.json](examples/sample-event-manifest.json). Private manifests and local media paths should remain outside the repository.

The CLI can also create and use a generic manifest:

```powershell
Set-Location .\app
npm run cli -- event manifest --output '..\sample-event.json'
npm run cli -- event reconcile --manifest '..\sample-event.json' --local-root '<local event root>' --output '.runs\sample-event-reconcile'
npm run cli -- event queue-missing --manifest '..\sample-event.json' --reconcile '.runs\sample-event-reconcile\reconcile.json' --dry-run
```

See [Event Workspace Reconcile](docs/event-workspace-reconcile.md) for the manifest shape and safety rules.

## Local API And MCP

The app can create a revocable local API key and one-time MCP configuration from **Connections > Automation access**. The service binds only to `127.0.0.1` and exposes an allowlisted set of read and queue-preparation capabilities. It does not expose credentials or destructive remote operations.

Keys are shown once. Revoke and replace a lost key rather than trying to recover it.

## CLI

The local CLI shares the app's rclone credential boundary:

```powershell
Set-Location .\app
npm run cli -- check
npm run cli -- list 'sample-event/recordings' --json
npm run cli -- inventory 'sample-event/recordings/raw'
npm run cli -- dry-run --source '<local path>' --prefix 'sample-event/recordings/raw' --filter all --folder-mode package
npm run cli -- upload --source '<local path>' --prefix 'sample-event/recordings/raw' --json
npm run cli -- status --job '<job-id>' --json
```

The CLI intentionally omits delete, purge, move, and rename operations.

## Security

Never commit credentials, connection packages, private manifests, local logs, or personal paths. See [SECURITY.md](SECURITY.md) for the credential boundary, connection-package behavior, and private vulnerability reporting process.

## Building

From `app/`:

```powershell
npm ci
npm run pack
```

`npm run pack` creates an unpacked Windows build under the ignored `dist/` directory. `npm run dist` creates installer and portable artifacts.

## Testing

From `app/`:

```powershell
npm test
npm run ui:smoke
npm audit --audit-level=low
```

The UI smoke test runs against a mocked local Electron environment. It does not configure rclone or access a remote Space.

## Contributing

Read [CONTRIBUTING.md](CONTRIBUTING.md) before opening a pull request. Transfer safety, credential handling, and fictional test data are release requirements.

## License

Murdawk Uplink is licensed under the [Apache License 2.0](LICENSE).
