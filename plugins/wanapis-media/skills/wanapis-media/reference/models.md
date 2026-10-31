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
| `minimax-h3` | per second + optional IR | 4–30s; 2K ≤15s | Native resolution/ratio, priority mode and one reference image |

**Per-second vs per-call matters for cost.** A per-second model at 15 seconds costs
roughly 3× the same model at 5 seconds; a per-call model costs the same either way.

## Image

| Model | Sync? | Notes |
|---|---|---|
| `gpt-image-2` | sync | Workhorse. Returns the image directly |
| `gpt-image-2-official` | async | Higher fidelity, quality/resolution tiers |
| `gpt-image-2.5-flare` | async | Independent native quality and resolution; references and image count |
| `gpt-image-2.5-sunburst` | async | Same parameters, editing-focused; references and image count |
| `seedream-5-0-pro` | async | Strongest Seedream, 1K/2K |
| `seedream-5-0-lite` | async | Lighter Seedream |
| `seedream-4-5` | async | Previous generation |
| `nano-banana-pro` | sync | Gemini 3 Pro Image. 1K/2K/4K |
| `nano-banana-2` | sync | Gemini 3.1 Flash Image |
| `midjourney` | async | Returns **4 images** per call, billed once |

## Native settings for Image 2.5 and H3

Image 2.5: `--quality low|medium|high|xhigh|max` and `--resolution 1k|2k|4k`
are independent and multiply in the tier budget. Defaults explicitly use low/1k/1;
`--count` maps to `n`. Repeat `--reference-image URL` for editing. Actual usage may
exceed the tier precharge; references, size and text can cause a completion debit.

H3: `--resolution 480p|768P|1080p|2K`, `--seconds` integer4–30 (2K≤15),
`--ratio 21:9|16:9|4:3|1:1|3:4|9:16`, `--image URL` for at most one opening frame,
`--fast-mode true|false`, `--context-ir-enabled true|false`. Defaults4s/768P/9:16,
fast=false, IR=true. H3 does not use `quality`. Its budget is `(per-second price ×
seconds × long multiplier × priority multiplier + IR fee) × assumed group ratio`.
The per-request IR fee is not doubled. No H3 Max, 4K or multiple reference inputs.

Current prices and H3 metadata come from the public feed. `--group-ratio` affects
estimation only and defaults1; it does not discover or select the key's route.
Missing required prices return an unavailable estimate. The model list is the
intersection of this adapter registry with the current public catalog; it is not
a guarantee of a particular key's permissions or a channel's health.

## Legacy quality mapping

For existing adapters, pass `low` / `medium` / `high`. The script translates:

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
will not work. H3 sends it as a single input_reference object; existing adapters
keep their original request mappings.

## Aspect ratios

`--aspect` takes a ratio such as `16:9`, `9:16`, `1:1`, `4:3`. Note this is a
ratio, not a guaranteed pixel size. For Image 2.5, use its native `--size` when
specifying a size string. H3 restricts ratio to its documented values.

## Async behaviour

Video is always async. Images are async for the models marked above. The script
handles submit-and-poll for both, so you do not need to care unless a poll is
interrupted — in that case recover with:

```bash
node scripts/wanapis.mjs task <task_id> --kind video --out ./out.mp4
```

Results stay retrievable for roughly 24 hours.
