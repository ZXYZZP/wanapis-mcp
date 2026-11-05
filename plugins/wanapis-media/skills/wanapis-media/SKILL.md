---
name: wanapis-media
description: Generate and edit images and video through WanAPIs, including GPT Image 2.5 Flare/Sunburst, MiniMax H3 with multi-image/frame/video/audio references, local uploads, 2K regeneration and standalone prompt optimization, plus Seedance, Veo, Kling, Midjourney, Seedream and Nano Banana. Use for generation, editing, model discovery and budget estimates. Handles verified native parameters, async polling, billing status and media downloads.
license: MIT
---

# WanAPIs image and video generation

Use the dependency-free CLI `node scripts/wanapis.mjs --help`. Generation and task
queries require `WANAPIS_API_KEY`; public model listing and estimates use the
unauthenticated pricing feed. `WANAPIS_BASE_URL` optionally selects another gateway.

## Estimate before generation

Show the budget and obtain the user's spending approval before submitting a paid
request, unless that spend is already authorized. Do not submit generation merely
to discover parameters or availability.

```sh
node scripts/wanapis.mjs models
node scripts/wanapis.mjs estimate --model minimax-h3 --seconds 4 --resolution 768P --context-ir-enabled false
```

Estimates use CNY and `--group-ratio 1` by default. That multiplier is a user
assumption, not the key's actual routing group, and does not alter generation.
H3 includes duration/priority multipliers and the optional IR fee. Image 2.5 tier
prices are precharges: reference images, dimensions and prompt content can raise
actual usage and cause an additional debit on completion. Do not promise a final
invoice from an estimate; inspect `chargedCny` and usage logs after completion.

## GPT Image 2.5

Both variants are asynchronous. Use `gpt-image-2.5-flare` or
`gpt-image-2.5-sunburst`. Quality and resolution are independent; defaults are
explicitly **low / 1k / one image**.

```sh
node scripts/wanapis.mjs image "a plain ceramic mug on a table" \
  --model gpt-image-2.5-flare --quality low --resolution 1k --count 1 \
  --aspect 1:1 --out ./mug.png
```

- `--quality`: low / medium / high / xhigh / max.
- `--resolution`: 1k / 2k / 4k. Higher quality and resolution multiply the budget.
- `--count`: a positive integer, mapped to `n`; no undocumented maximum is assumed.
- Repeat `--reference-image <public URL>` for editing inputs. References contribute
  to actual usage. Use `--size` or `--aspect` without conflicting values.
- Do not omit quality in raw upstream requests and assume it means low: the service
  may select an automatic tier. This CLI explicitly supplies its documented defaults.

## MiniMax H3

H3 uses native resolution rather than generic `quality`. Defaults are **4 seconds /
768P / 9:16 / fast off / IR on**.

```sh
node scripts/wanapis.mjs video "a paper plane glides over a field" \
  --model minimax-h3 --resolution 768P --seconds 4 --ratio 16:9 \
  --fast-mode false --context-ir-enabled false --out ./clip.mp4
```

Resolution: 480p / 768P / 1080p / 2K. Duration: integer 4–30 seconds, but 2K permits
at most 15 seconds. Ratios: 21:9 / 16:9 / 4:3 / 1:1 / 3:4 / 9:16.

H3 accepts up to 9 images (reference images plus one `first_frame` and one
`last_frame`), up to 3 reference videos and up to 3 audio clips. Repeat
`--reference-image`, `--reference-video` and `--reference-audio`; use
`--first-frame` / `--last-frame` for explicit frame roles. A value may be a public
URL, a data URI, an existing `asset_id`, or a local file path — local files are
uploaded once and replaced by an opaque asset ID, and the remaining uploads bind to
the same account. `--image <...>` remains the legacy single-image form.

```sh
node scripts/wanapis.mjs upload ./motion.mp4 --media-type video
node scripts/wanapis.mjs video "the same character walks into the rain" \
  --model minimax-h3 --reference-image ./character.png --reference-video ./motion.mp4 \
  --reference-audio ./rain.mp3 --resolution 768P --seconds 4
```

`--fast-mode true` doubles the output and billable reference-material components;
clips from 16 seconds double the entire video component. IR is a separate fee per
request and is not doubled. First five images and audio have no material fee;
extra images and reference-video seconds are billed. The service reserves the
maximum input allowance before submission and refunds the difference after
verified usage. `pending_usage` means the reservation is not yet the final charge.

### Regeneration and prompt optimization

2K regeneration starts from one of your successful 768P H3 originals. Content mode
requires the original final prompt and every original reference material, unchanged;
source mode is available only when the task's eligibility lists it.

```sh
node scripts/wanapis.mjs regenerate <source_task_id> --mode content \
  --prompt "<original final prompt>" --reference-image ./original.png --out ./regen.mp4
node scripts/wanapis.mjs optimize "make it cinematic" --seconds 4 --ratio 16:9
```

`optimize` is a text task (check it with `task <id> --kind prompt`), not a video. When
using its text for a video, pass `--context-ir-enabled false` to avoid another IR fee.
Regeneration and optimization are separate paid requests; the original generation
remains billed.

## Seedance

Seedance 2.5 / 2.0 / 2.0-fast / 2.0-mini accept the same media shape, but their
upstreams only fetch public URLs. Local files are uploaded to the gateway's
temporary media relay and replaced with a signed URL before submission.

```sh
node scripts/wanapis.mjs video "the character turns toward the camera" \
  --model seedance-2.0-mini --quality low --seconds 5 --aspect 16:9 \
  --reference-image ./character.png --first-frame ./opening.png \
  --last-frame ./ending.png --generate-audio true --out ./clip.mp4
```

`--quality` maps to 480p / 720p / 1080p; `--seconds` is 4–15. Media limits are 9
images including frames, 3 reference videos and 3 audio clips. Video/audio
references cannot be combined with first/last frames. Uploaded URLs expire after
about six hours; upload again for a much later task. H3 `asset_id`s are not
accepted by Seedance.

## Existing adapters

Existing Seedance, Veo, Kling, Vidu, HappyHorse, Grok, Seedream, Nano Banana,
GPT Image and Midjourney adapters retain their `low` / `medium` / `high` mappings.
Use `reference/models.md` for capabilities and `models` for the current catalog
intersection. A newly advertised model is not considered supported until its
protocol adapter is verified. A public listing does not prove key permissions or
that a channel is healthy.

```sh
node scripts/wanapis.mjs image "a red apple" --model gpt-image-2 --quality low --out apple.png
node scripts/wanapis.mjs video "a paper plane" --model seedance-2.0-mini --quality low --seconds 5 --out clip.mp4
```

## Async tasks and files

The CLI submits once, polls, and optionally downloads. If polling is interrupted,
recover the existing task rather than submitting another paid generation:

```sh
node scripts/wanapis.mjs task <task_id> --kind video --out ./clip.mp4
```

Video URLs require authentication; image CDN URLs may be public. Use `--out` to
keep a file, because result URLs expire with the upstream result. H3 `--reference-*`
and `--first-frame`/`--last-frame` accept local paths (uploaded automatically) as
well as public URLs or existing asset IDs. Seedance also accepts local paths; the
CLI uploads them to the gateway's temporary relay and uses the signed URL. H3
uploads return an `asset_id` for reuse; Seedance URLs expire after about six hours,
so upload again rather than reusing an expired link. Uploading is free.

Cancelling the client does not cancel upstream work or its charge. Do not retry a
slow submission to make it faster. A failed or unknown submission needs inspection
before another paid request; respect the user's existing spend authorization.
