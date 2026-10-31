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
| `wanapis_generate_video` | Start a video job. Returns `task_id` immediately. |
| `wanapis_check_task` | Poll a job. Returns status, progress, **the real amount billed**, and media URLs. Pass `save_dir` to download the files. |
| `wanapis_estimate_cost` | A budget from public live prices, with explicit settings and an assumed group multiplier. |
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
Use `image_url` for one opening frame. MCP sends the documented `input_reference`
object. H3 does not use the generic `quality` option, has no 4K tier, and does not
accept multiple reference images. Defaults are **4 seconds / 768P / 9:16 / fast off / IR on**.

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
- **Images come back as URLs, never base64.** Inline image data would blow out
  an agent's context window.
- **The estimate is a budget, not a quote.** Upstreams don't always honour the
  exact request — a 4-second video came back as 5 seconds and was billed for 5.
  Once a task finishes, `check_task` reports `costCny` (what you were actually
  charged) and `actual` (the specs really produced).
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
