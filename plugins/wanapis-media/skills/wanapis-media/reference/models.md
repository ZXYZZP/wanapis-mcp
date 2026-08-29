# Model reference

Capabilities and parameters only — **prices are not listed here because they change.**
Run `node scripts/wanapis.mjs models` for the live pricing feed, or
`estimate` for a specific configuration.

## Video

| Model | Billing | Duration | Notes |
|---|---|---|---|
| `seedance-2.5` | per second | 4–15s | Newest generation; best quality and shot consistency |
| `seedance-2.0` | per second | 4–15s | Standard quality tier |
| `seedance-2.0-fast` | per second | 4–15s | Faster, cheaper; good for drafts |
| `seedance-2.0-mini` | per second | 4–15s | Cheapest. Use for iterating on a prompt |
| `veo3.1-quality` | **per call** | fixed | Google Veo 3.1. 4K with synchronised audio. Expensive |
| `veo3.1-fast` | per call | fixed | Veo 3.1, speed tier |
| `veo3.1-lite` | per call | fixed | Veo 3.1, cheapest tier |
| `kling-v3` | per second | 3–15s | Best human motion |
| `kling-v2-6` | per second | 3–15s | Value tier |
| `viduq3` | per second | — | Vidu Q3 |
| `happyhorse-1.0` | per second | — | Alibaba ATH |
| `grok-video` | per second | fixed 6s | xAI |

**Per-second vs per-call matters for cost.** A per-second model at 15 seconds costs
roughly 3× the same model at 5 seconds; a per-call model costs the same either way.

## Image

| Model | Sync? | Notes |
|---|---|---|
| `gpt-image-2` | sync | Workhorse. Returns the image directly |
| `gpt-image-2-official` | async | Higher fidelity, quality/resolution tiers |
| `seedream-5-0-pro` | async | Strongest Seedream, 1K/2K |
| `seedream-5-0-lite` | async | Lighter Seedream |
| `seedream-4-5` | async | Previous generation |
| `nano-banana-pro` | sync | Gemini 3 Pro Image. 1K/2K/4K |
| `nano-banana-2` | sync | Gemini 3.1 Flash Image |
| `midjourney` | async | Returns **4 images** per call, billed once |

## Quality mapping

You pass `low` / `medium` / `high`. The script translates:

| Family | low | medium | high |
|---|---|---|---|
| Seedance / grok-video | 480p | 720p | 1080p |
| Veo | 720p | 1080p | 4k |
| Kling (`mode`, not resolution) | std | pro | 4k |
| Vidu | 540p | 720p | 1080p |
| Seedream | 1K | 1K | 2K |
| Nano Banana / GPT-Image | 1K | 2K | 4K |
| Midjourney | `--q .25` in prompt | default | default |

Kling is the one that trips people up: it has no `resolution` field at all, and its
aspect field is `aspect_ratio` rather than `size`. Midjourney has no parameter fields
whatsoever — everything goes in the prompt as `--ar` / `--q` flags.

## Image-to-video

Pass `--image <url>` to `video`. The URL must be publicly reachable; a local path
will not work. Supported by the Seedance and Kling families.

## Aspect ratios

`--aspect` takes a ratio such as `16:9`, `9:16`, `1:1`, `4:3`. Note this is a
**ratio, not a pixel size** — passing `1920x1080` will be rejected.

## Async behaviour

Video is always async. Images are async for the models marked above. The script
handles submit-and-poll for both, so you do not need to care unless a poll is
interrupted — in that case recover with:

```bash
node scripts/wanapis.mjs task <task_id> --kind video --out ./out.mp4
```

Results stay retrievable for roughly 24 hours.
