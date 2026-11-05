# Model reference

Capabilities and parameters only — **prices are not listed here because they change.**
Run `node scripts/wanapis.mjs models` for the live pricing feed, or
`estimate` for a specific configuration.

## Video

| Model | Billing | Duration | Notes |
|---|---|---|---|
| `seedance-2.5` | per second | 4–15s | Newest generation; best quality and shot consistency; local upload |
| `seedance-2.0` | per second | 4–15s | Standard quality tier; local upload |
| `seedance-2.0-fast` | per second | 4–15s | Faster, cheaper; good for drafts; local upload |
| `seedance-2.0-mini` | per second | 4–15s | Cheapest. Use for iterating on a prompt; local upload |
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

Seedance: `--quality low|medium|high` maps to 480p/720p/1080p, `--seconds` 4–15,
`--aspect` ratio, `--generate-audio true|false`, `--return-last-frame true|false`
and `--seed N`. Media: up to9 images including `--first-frame` and `--last-frame`,
up to3 `--reference-video`, up to3 `--reference-audio`; video/audio cannot be
combined with first/last frames. Values may be public URLs, data URIs or local
paths. Local paths are uploaded by the CLI to the gateway's temporary relay and
replaced with a signed public URL (about six hours); upload again after expiry.
H3 `asset_id`s are not accepted.

H3: `--resolution 480p|768P|1080p|2K`, `--seconds` integer4–30 (2K≤15),
`--ratio 21:9|16:9|4:3|1:1|3:4|9:16`, `--fast-mode true|false`,
`--context-ir-enabled true|false`. Defaults4s/768P/9:16, fast=false, IR=true.
H3 does not use `quality`. Media: up to9 images including `--first-frame` and
`--last-frame`, up to3 `--reference-video`, up to3 `--reference-audio`; repeat the
flags. Values may be public URLs, data URIs, existing `asset_id`s or local paths
(local files are uploaded automatically; uploading is free). The first five images
and audio have no material fee; extra images and reference-video seconds are
billed. The service reserves the maximum input allowance and settles to verified
usage; `pending_usage` is not the final charge. `--image` remains the legacy single
input_reference form. Content-mode 2K regeneration requires the original final
prompt and all original media; use `regenerate`. Standalone text optimization is
`optimize` (separate paid request). No H3 Max or 4K tier.

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

Pass `--image <url|local path>` to `video` for the legacy single-image form. URLs
must be publicly reachable; local paths are uploaded automatically for H3 and
Seedance. For multiple images, frame roles, reference video or audio, use the
`--reference-*` and `--first-frame`/`--last-frame` flags. Existing non-H3,
non-Seedance adapters keep their original request mappings and still require a
remote URL.

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
