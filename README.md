# @wanapis/mcp

Already using WanAPIs for Claude Code or Codex? Add one line and the **same key**
generates images and video — no second account, no second bill.

## Why this exists

Every image/video model wants different parameters:

| Family | Quality | Aspect | Duration |
|---|---|---|---|
| Seedance | `resolution` 480p/720p/1080p | `size` | `duration` 4–15 |
| **Kling** | **`mode`** std/pro/4k | **`aspect_ratio`** | `duration` 3–15 |
| Veo 3.1 | `resolution` | — | billed per call |
| Midjourney | `--q .25` in the prompt | `--ar 16:9` in the prompt | — |

This server translates shared options (`quality` / `aspect` / `seconds`) for
existing adapters. Models with independent settings expose those settings directly:
GPT Image 2.5 has separate `quality` and `resolution`, and MiniMax H3 has native
`resolution`, duration, priority and IR options.

## Setup

Get your key at [wanapis.com](https://wanapis.com) (or wanapi.ai).

**Claude Code**

```bash
claude mcp add wanapis --env WANAPIS_API_KEY=sk-xxx -- npx -y @wanapis/mcp
```

**Codex / Cursor / Windsurf** — add to your MCP config:

```json
{
  "mcpServers": {
    "wanapis": {
      "command": "npx",
      "args": ["-y", "@wanapis/mcp"],
      "env": { "WANAPIS_API_KEY": "sk-xxx" }
    }
  }
}
```

Optional: `WANAPIS_BASE_URL` if you run a self-hosted gateway.

## Tools

| Tool | What it does |
|---|---|
| `wanapis_generate_image` | Generate an image. Returns URLs if it finishes fast, else a `job_id`. Midjourney returns 4 per call. |
| `wanapis_generate_video` | Start a video job. Returns `task_id` immediately. H3 and Seedance accept multiple images, frame roles, reference video/audio and local files. |
| `wanapis_upload_media` | Upload one local image/video/audio file for H3 (opaque `asset_id`) or Seedance (temporary signed URL); free, no task created. |
| `wanapis_regenerate_video` | Create a 2K regeneration from one of your successful 768P H3 tasks (`source` or `content` mode). |
| `wanapis_optimize_prompt` | Standalone H3 prompt optimization: a text task, billed separately. |
| `wanapis_check_task` | Poll a job (`kind`: image, video or prompt). Returns status, progress, billing (`reserved`/`charged`/`refunded` CNY), media URLs or prompt text. Pass `save_dir` to download. |
| `wanapis_estimate_cost` | A budget from public live prices, with explicit settings and an assumed group multiplier. H3 media returns a reservation upper bound. |
| `wanapis_list_models` | Current public catalog entries with verified adapters, native options and prices. |

### GPT Image 2.5

Use `gpt-image-2.5-flare` or `gpt-image-2.5-sunburst`. Both submit an async task;
call `wanapis_check_task` with `kind: "image"` and the returned `task_id`.

```json
{"model":"gpt-image-2.5-flare","prompt":"a plain ceramic mug","quality":"low","resolution":"1k","count":1,"aspect":"1:1"}
```

- `quality`: `low`, `medium`, `high`, `xhigh`, `max`.
- `resolution`: `1k`, `2k`, `4k`, independent of quality.
- `count`: a positive integer, translated to `n`.
- `reference_images`: URLs for image editing; `aspect` or `size` controls the image size. Conflicting aliases are rejected.
- MCP defaults explicitly to **low / 1k / one image**. This avoids the service choosing an automatic quality tier when quality is omitted upstream.

### MiniMax H3

Use `minimax-h3`; it returns a video `task_id` and uses the same polling/download tool.

```json
{"model":"minimax-h3","prompt":"a paper plane glides over a field","resolution":"768P","seconds":4,"ratio":"9:16","fast_mode":false,"context_ir_enabled":true}
```

Resolution is `480p`, `768P`, `1080p` or `2K`; duration is an integer from 4–30 seconds,
or at most 15 seconds at 2K. Ratios: `21:9`, `16:9`, `4:3`, `1:1`, `3:4`, `9:16`.
H3 does not use the generic `quality` option and has no 4K tier. Defaults are
**4 seconds / 768P / 9:16 / fast off / IR on**.

Media inputs (all optional):

```json
{
  "model": "minimax-h3",
  "prompt": "the same character walks into the rain",
  "reference_images": ["./character.png", "https://cdn.example/style.webp"],
  "first_frame": "./opening.png",
  "last_frame": "./ending.png",
  "reference_videos": ["./motion.mp4"],
  "reference_audio": ["./rain.mp3"],
  "resolution": "768P", "seconds": 4, "ratio": "16:9", "context_ir_enabled": false
}
```

- Up to 9 images including one `first_frame` and one `last_frame`, up to 3
  `reference_videos` and up to 3 `reference_audio`.
- Each value may be a public URL/data URI, an existing `asset_id`, or a local file
  path. Local files are uploaded automatically and replaced by an opaque asset ID;
  subsequent uploads bind to the same account. Uploading is free.
- `image_url` remains the legacy single-image form and cannot be mixed with
  `reference_images` or frame roles.
- First five images and audio have no material fee; extra images and
  reference-video seconds are billed. The reservation covers the protocol input
  upper bound and settles to verified usage.

### Seedance

Seedance 2.5 / 2.0 / 2.0-fast / 2.0-mini accept the same style of media inputs,
but their upstreams only fetch public URLs. The server handles this for you: local
files are uploaded to the gateway's temporary media relay and replaced with a
signed URL before submission.

```json
{
  "model": "seedance-2.0-mini",
  "prompt": "the character turns toward the camera",
  "reference_images": ["./character.png"],
  "first_frame": "./opening.png",
  "last_frame": "./ending.png",
  "reference_videos": ["./motion.mp4"],
  "reference_audio": ["./rain.mp3"],
  "seconds": 5,
  "aspect": "16:9",
  "quality": "medium",
  "generate_audio": true,
  "return_last_frame": true,
  "seed": 42
}
```

- `quality` maps to 480p / 720p / 1080p; `seconds` is 4–15.
- Up to 9 images including frames, 3 reference videos and 3 audio clips.
  `reference_images` and frame roles use typed roles when needed; video and audio
  cannot be combined with first/last frames.
- Local files are uploaded once to a signed URL valid for about six hours. If a
  task is submitted much later, upload again rather than reusing an expired URL.
- H3 `asset_id`s are not accepted by Seedance; use a URL or a local file.

### H3 regeneration and prompt optimization

`wanapis_regenerate_video` creates a new 2K task from one of your successful 768P
H3 originals. `mode: "source"` uses the source task when its eligibility lists
source mode. `mode: "content"` requires the original final prompt and **every**
original reference material, unchanged; local paths are uploaded automatically.
Regeneration is a new paid request; the original generation remains billed.

`wanapis_optimize_prompt` creates a standalone text task (`object:
"prompt_optimization"`), polled with `kind: "prompt"`. It is a separate paid
request. When using the returned prompt for a video, set `context_ir_enabled:
false` to avoid a second IR charge.

### Estimates are budgets

`wanapis_estimate_cost` takes the same native settings. Optional `group_ratio`
(default `1`) is a **budget assumption**; it neither selects a generation group nor
discovers the API key's billing route. Results include CNY, settings, calculation
basis, price version and, for the new models, component charges.

For H3, the calculation is `(price per second × seconds × duration multiplier ×
priority multiplier + IR fee) × assumed group multiplier`. Long clips (16–30 seconds)
double the whole video component; priority doubles it again. Neither doubles the
per-request IR fee. Rates and multipliers are read from the current public catalog;
missing pricing metadata returns an unavailable estimate instead of guessing a tier.

With H3 reference media, the estimate is a **reservation upper bound**: output,
extra images (after the first five) and reference-video seconds at the protocol
input bound (16s for one video, 15s for multiple), all with the duration/priority
multipliers, plus IR. The final reference-video charge uses verified input seconds
and can be lower; a successful task refunds the difference. `pending_usage` means
that settlement has not completed, so `chargedCny` is null and the reservation is
not the final price.

Image 2.5 estimates are **tier precharges**, computed from quality × resolution ×
image count. Final actual usage may cost more: reference images, dimensions and
prompt content can increase consumption, with an additional charge at settlement.
A chosen low tier is not a final-price guarantee. Read `costCny` from the completed
task and the account usage logs for the amount actually billed.

## Notes worth knowing

- **Async results stay out of the tool timeout.** Videos and async image adapters
  (including Image 2.5) return a gateway task ID. Synchronous image adapters can
  take longer than the timeout most MCP clients enforce. For those adapters,
  `generate_image` waits 50s for a fast result and otherwise hands back a
  `job_id` while the request keeps running in the background. Either way the
  request is sent once and billed once. Local image jobs returned as a `job_id`
  remain queryable for 30 minutes from submission, so you can check the result first and then call
  `check_task` again with `save_dir`, including after a download error. Jobs are
  kept in memory and do not survive a server restart.
- **Video URLs need your API key; image URLs do not.** Video results are served
  through the gateway's own media proxy, so opening one in a browser returns
  401 — don't hand the raw link to a user. Images come back as upstream CDN
  links that anyone can open. `save_dir` on `check_task` sidesteps the
  difference by downloading either kind to disk.
- **Result URLs expire** once the upstream result does (roughly 24h). Download
  what you want to keep.
- **Local media is uploaded, not forwarded as a path.** For H3 the server reads
  the file and uses an opaque `asset_id` bound to the account and credential. For
  Seedance it uses the gateway's temporary media relay, which returns a signed
  public URL (about six hours) for the upstream to fetch. The local path never
  reaches the gateway.
- **Images come back as URLs, never base64.** Inline image data would blow out
  an agent's context window.
- **The estimate is a budget, not a quote.** Upstreams don't always honour the
  exact request — a 4-second video came back as 5 seconds and was billed for 5.
  Once a task finishes, `check_task` reports `costCny` (what was actually
  charged) and `actual` (the specs really produced). H3 may report
  `billing.status: "pending_usage"` after the video succeeds; then `costCny` is
  null, `billing.reservedCny` is only a hold, and the final charge follows
  verified usage.
- **Cancelling doesn't stop the meter.** Disconnecting mid-request does not
  cancel work upstream; the generation completes and is billed. Prefer polling
  over killing the call.
- **Midjourney is async-only** and returns 4 images per generation (its 2×2 grid,
  split into separate URLs).

## Models

Verified video adapters: `seedance-2.5` / `2.0` / `2.0-fast` / `2.0-mini`,
`veo3.1-quality` / `fast` / `lite`, `kling-v3` / `v2-6`, `viduq3`,
`happyhorse-1.0`, `grok-video`, `minimax-h3`.

Verified image adapters: `gpt-image-2`, `gpt-image-2-official`,
`gpt-image-2.5-flare`, `gpt-image-2.5-sunburst`, `seedream-5-0-pro` / `lite`,
`seedream-4-5`, `nano-banana-pro`, `nano-banana-2`, `midjourney`.

Run `wanapis_list_models` for the intersection of these adapters and the current
public catalog. Unsupported new models are not guessed from endpoint labels;
removed models disappear from this list. Public visibility does not establish
that a particular API key can use the listed group or that a channel is healthy.
An unavailable or malformed catalog reports an error instead of displaying an
unverified static list. Tool discovery remains available offline.

## Standalone Skill

The canonical Skill is `plugins/wanapis-media/skills/wanapis-media`. Its CLI is
zero-dependency and supports the same native options (hyphenated flags):

```sh
node scripts/wanapis.mjs estimate --model minimax-h3 --seconds 16 --fast-mode true
node scripts/wanapis.mjs video "a paper plane" --model minimax-h3 --resolution 768P --seconds 4 --context-ir-enabled false --out clip.mp4
node scripts/wanapis.mjs image "a ceramic mug" --model gpt-image-2.5-flare --quality low --resolution 1k --count 1 --out mug.png
```

These are paid generation commands when run with a real key. Estimate and confirm
spend first. Model, catalog and pricing helpers are generated from MCP source with
`npm run sync:skill`; tests reject stale embedded helpers. `npm run build:skill-zip`
regenerates the standalone bundle from that canonical source.

## License

MIT
