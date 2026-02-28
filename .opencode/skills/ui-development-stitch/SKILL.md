---
name: ui-development-stitch
description: Stitch project screen code/image retrieval workflow for UI development. Use when implementing UI from a fixed Stitch project and screen IDs.
compatibility: opencode
---

# UI Development With Stitch

Use this skill when the task is to build UI from a known Stitch project and screen.

## Stitch Instructions

Get the images and code for the following Stitch project's screens:

## Project
Title: vector search
ID: 5810712602617742367

## Screens
1. NamuWiki Vector Search Practice
   ID: f0bd869b839649bc9c50ee8c5fe1244b

Use a utility like `curl -L` to download the hosted URLs.

## Execution Checklist

1. Confirm Stitch MCP is connected and tools are available.
2. Resolve project and screen metadata from the IDs above.
3. Retrieve hosted URLs for both screen image and screen code artifacts.
4. Download artifacts with `curl -L` and store under a deterministic local path.
5. Use downloaded artifacts as the source for UI implementation.

## Output Requirements

- Save raw downloads under `tmp/stitch/vector-search/`.
- Keep original filenames when available; otherwise use `screen-<screen-id>.<ext>`.
- Report downloaded file paths and sizes.
- Do not hardcode secrets in code or docs.

## Command Template

```bash
mkdir -p tmp/stitch/vector-search
curl -L "<hosted-image-url>" -o "tmp/stitch/vector-search/screen-f0bd869b839649bc9c50ee8c5fe1244b.png"
curl -L "<hosted-code-url>" -o "tmp/stitch/vector-search/screen-f0bd869b839649bc9c50ee8c5fe1244b.html"
```
