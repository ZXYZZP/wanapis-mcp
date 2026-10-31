---
name: wanapis-media
description: Generate images and video through WanAPIs, including GPT Image 2.5 Flare/Sunburst and MiniMax H3, plus Seedance, Veo, Kling, Midjourney, Seedream and Nano Banana. Use for generation, image editing, model discovery and budget estimates. Handles verified native parameters, async polling and media downloads.
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
at most 15 seconds. Ratios: 21:9 / 16:9 / 4:3 / 1:1 / 3:4 / 9:16. `--image <URL>`
provides at most one opening-frame image, sent as an `input_reference` object.
No multiple image inputs, reference video/audio, or 4K tier are supported.

`--fast-mode true` doubles the video component; clips from 16 seconds double the
entire video component. IR is a separate fee per request and is not doubled by
either option. Pass booleans as the literal flag values `true` or `false`.

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
keep a file, because result URLs expire with the upstream result. A local file path
cannot serve as a remote reference image URL.

Cancelling the client does not cancel upstream work or its charge. Do not retry a
slow submission to make it faster. A failed or unknown submission needs inspection
before another paid request; respect the user's existing spend authorization.
