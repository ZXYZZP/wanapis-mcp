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

Asking an agent to remember that is unrealistic. This server exposes **one
vocabulary** (`quality` / `aspect` / `seconds`) and translates it per model.

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
| `wanapis_estimate_cost` | **What it will cost, before you run it.** |
| `wanapis_list_models` | Models with live pricing and resolution tiers. |

### Cost estimates are real

`wanapis_estimate_cost` reads the live pricing feed — the same source the
server bills from, so the estimate matches your invoice:

```
seedance-2.0-mini  480p × 4s  →  0.5580   (0.1395/s × 4s)
kling-v2-6         720p × 5s  →  1.6745   (0.3349/s × 5s)
gpt-image-2        1K         →  0.1200   (0.12 × 1)
```

Verified end to end against real billing: the seedance job above was charged
0.6975 — exactly `0.1395 × 5`, the five seconds the upstream actually produced.

## Notes worth knowing

- **Nothing blocks for minutes.** Video is async by design (60–150s). Images use
  the gateway's synchronous endpoint, but generation measured 25s–5min in
  practice — longer than the tool timeout most MCP clients enforce. So
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

Videos: `seedance-2.5` / `2.0` / `2.0-fast` / `2.0-mini`, `veo3.1-quality` /
`fast` / `lite`, `kling-v3` / `v2-6`, `viduq3`, `happyhorse-1.0`, `grok-video`

Images: `gpt-image-2`, `gpt-image-2-official`, `seedream-5-0-pro` / `lite`,
`seedream-4-5`, `nano-banana-pro`, `nano-banana-2`, `midjourney`

Run `wanapis_list_models` for current pricing.

## License

MIT
