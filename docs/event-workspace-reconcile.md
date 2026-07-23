# Event Workspace Reconcile

Event Workspace compares local media folders with a DigitalOcean Spaces recording prefix and prepares guarded queue jobs for files that are still missing. Reconcile is read-only. It does not upload, move, rename, or delete remote objects.

## Manifest

The app opens a local JSON manifest instead of shipping client or event presets. A manifest contains non-secret routing data:

```json
{
  "client": "Example Organization",
  "eventName": "sample-event",
  "eventPrefix": "sample-event",
  "year": 2026,
  "eventNumber": 1,
  "remote": "media",
  "bucket": "media-archive",
  "endpointHost": "nyc3.digitaloceanspaces.com",
  "recordingsPrefix": "sample-event/recordings",
  "stages": ["Main", "Talk", "Workshop"],
  "days": ["Day 1", "Day 2", "Day 3"],
  "localRoots": [],
  "uploadDefaults": {
    "publicRead": false,
    "sizeOnly": true,
    "transfers": 4,
    "chunkSize": "64M",
    "uploadConcurrency": 4,
    "retries": 20,
    "retriesSleep": "30s",
    "lowLevelRetries": 60
  }
}
```

The app validates and bounds the manifest before use. It rejects credential-shaped fields, unsafe remote names, path traversal, malformed JSON, and oversized files. The selected local manifest path is not retained in application state.

Private manifests must remain outside the repository. Do not put access keys, secret keys, webhook URLs, raw logs, or other secrets in a manifest.

## Recording Layout

The generic recording layout is:

```text
<event>/
  recordings/
    assets/
      Main/
      Talk/
      Workshop/
    raw/
      Main/
        Day 1/
          Audio/
          Cameras/
          Mix/
        Day 2/
          Audio/
          Cameras/
          Mix/
        Day 3/
          Audio/
          Cameras/
          Mix/
      Talk/
      Workshop/
    edits/
      Main/
      Talk/
      Workshop/
```

The stage and day arrays in the manifest define the event's lanes. Mapping rules must keep every inferred destination below `recordingsPrefix`.

## Workflow

1. Open **Advanced** and select **Open manifest**.
2. Review the manifest summary and remote destination.
3. Add one or more local roots.
4. Run **Reconcile**.
5. Resolve ambiguous files instead of treating them as missing.
6. Select **Queue Missing** to add safe candidates to the normal transfer shelf.
7. Review the pre-check and explicitly start the upload.
8. Wait for post-transfer verification before treating the job as complete.

## Results

- `matched`: destination exists with the same byte size.
- `missing`: destination does not exist.
- `sizeMismatch`: destination exists with a different byte size.
- `ambiguous`: the app cannot infer one safe destination.

Remote `.keep` objects are folder markers and are ignored as media during reconcile.

## Safety Rules

- Reconcile uses read-only remote listing and size checks.
- Credential-like local files are excluded before queue planning.
- Queue candidates must remain under the manifest's recording prefix.
- Ambiguous files are never queued automatically.
- Queue creation does not start a transfer.
- Existing verification and durable recovery rules apply to every queued job.

See [examples/sample-event-manifest.json](../examples/sample-event-manifest.json) for a complete fictional example.
