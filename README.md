# reMarkable Daily Sync

Sync Obsidian Daily Notes with a reMarkable tablet on Windows. Notes become rendered PDFs; handwriting is recognized locally through Ollama and merged into Markdown. Highlights become `==highlights==`, and drawings are preserved as images.

## Requirements

- Windows, Obsidian desktop, and a reMarkable account with working cloud sync.
- Ollama running locally with a vision-capable model. The default is `gemma4:26b`; select your installed model in settings.
- Node.js 22+ to build from source. The Windows cloud helper and its source are included.

## Install

Download or clone this repository, then run PowerShell in its folder:

```powershell
npm.cmd ci --ignore-scripts
npm.cmd run build
& .\scripts\install.ps1 -VaultPath 'C:\path\to\your\vault'
```

1. Enable **reMarkable Daily Sync** in Obsidian's Community plugins settings.
2. Open the plugin settings and run the displayed pairing command in PowerShell. Get the one-time code from [reMarkable](https://my.remarkable.com/device/desktop/connect), then enter it in the terminal.
3. Set **Daily Notes root**, **Enroll notes from**, and your local **Gemma model**. Click **Check** under Connections. Reload the plugin after changing connection or model settings.
4. Notes must use this structure (set the root to `Daily Notes` for this example): `Daily Notes/(10) October 2026/October 14, 2026.md`.
5. Export a disposable test note, write on its PDF, and run **Sync now** to review the result.
6. Enable **Apply clear handwriting edits automatically** and turn off **Pause background sync**. Leave **Keep tablet layout until I refresh it** and **Append updated layouts as history pages** off.

## Use

Open the date-named PDF (for example, `2026-10-14`) in the tablet's **Obsidian Daily Notes** folder. Write on the existing pages and let the tablet finish cloud sync. Obsidian checks every minute and after local edits; OCR may take longer depending on your hardware.

Updated notes upload as new date-named PDFs. Previous documents move to **Obsidian Daily Notes/Archive**, retaining their handwriting. Open the latest PDF to continue writing. Unchanged notes do not create revisions.

Keep **Obsidian and Ollama running** on one Windows computer. The reMarkable desktop app does not need to be open. Use **Review tablet changes** for uncertain recognition or conflicting edits; clear edits can save automatically.

## Limits and recovery

### Synthetic notebooks (preview only)

Plugin settings can map an explicit folder to one PDF-backed notebook, including all direct Markdown files. **Preview PDF** opens a local combined PDF with each entry starting on a new page. Daily entries sort by date initially; other folders sort naturally by filename. Newly discovered entries follow existing entries.

Persistent tablet notebook publishing is **not enabled**: safe in-place updates to newer `cPages` documents have not been validated. Adding a mapping reserves its folder and suspends individual PDF publication there, including when paused. Existing handwriting imports continue, and unmapped Daily Notes keep their normal sync. Remove the mapping to resume individual Daily Note publication.

Preview creates no tablet documents, archives nothing, and does not acknowledge notes as published. State upgrades keep an exact v1 backup in the private `backups` folder. Local previews and their source manifests live in `notebook-previews`. Do not manually change validation fields to attempt activation; they cannot bypass the transport gate.

### Current sync limits

- Same-document page appending is supported only for legacy PDF metadata. Newer `cPages` documents require the new-PDF workflow above.
- Avoid inserting, deleting, rotating, or cropping tablet pages. Recognition can make mistakes; test your handwriting before enabling automatic edits.
- Credentials, original tablet files, sync state, and note backups stay in `%LOCALAPPDATA%\RemarkableDailySync\<vault-hash>`. Do not delete this state to reset the plugin or commit it to Git.
- Handwriting is marked processed only after the note is verified saved. Interrupted saves are retried. Cloud rate limits pause requests and retry automatically.
- OCR stays local; note PDFs travel through reMarkable's unofficial cloud API. Enrollment uses the America/Chicago date and English month/day filenames.

## Development

```powershell
npm.cmd run check    # typecheck, tests, build, and plugin smoke test
npm.cmd run package  # also create an installable ZIP in the parent folder
```

Rebuild the cloud helper with `scripts/setup-rmapi.ps1` and Go 1.23+. Third-party licenses and source details are in `licenses/` and `bin/THIRD-PARTY.txt`.
