---
name: wanapis-media
description: Generate images and video through WanAPIs — Seedance, Veo, Kling, Midjourney, Seedream, Nano Banana, GPT-Image. Use when the user asks to create, generate, or render an image or a video, or asks what such a generation would cost. Handles per-model parameter differences, async polling and cost estimates.
license: MIT
---

# WanAPIs image and video generation

One API key reaches every major image and video model. This skill covers picking a
model, translating parameters, polling async jobs and knowing the cost up front.

## Setup

Requires `WANAPIS_API_KEY` in the environment (get one at https://wanapis.com).
Check it is set before doing anything else; if it is missing, tell the user where
to get a key rather than guessing at another provider.

Everything below runs through one dependency-free script:

```bash
node scripts/wanapis.mjs --help
```

## Estimate before you generate

Generation is billed per call. **Always estimate first and show the user the number**
unless they have already approved the spend. Video in particular ranges from ¥0.14
to ¥9 per clip depending on model and resolution.

```bash
node scripts/wanapis.mjs estimate --model seedance-2.0-mini --quality low --seconds 5
# → 0.6975  (0.1395/s × 5s)
```

## Generate an image

```bash
node scripts/wanapis.mjs image "a red apple on a white table" \
  --model gpt-image-2 --quality low --aspect 1:1 --out ./apple.png
```

Takes 25s–5min. The script submits, polls if needed, and downloads the file.

## Generate a video

```bash
node scripts/wanapis.mjs video "a paper plane over a city at dusk" \
  --model seedance-2.0-mini --quality low --seconds 5 --aspect 16:9 --out ./clip.mp4
```

Takes 60–150s. Same submit-poll-download flow.

## Picking a model

| Need | Use |
|---|---|
| Cheapest video draft | `seedance-2.0-mini` |
| Best video quality | `seedance-2.5` or `veo3.1-quality` |
| Natural human motion | `kling-v3` |
| Everyday image | `gpt-image-2` |
| Best image quality | `nano-banana-pro` or `seedream-5-0-pro` |
| Stylised / artistic image | `midjourney` (returns 4 variations) |

`quality` is always `low` / `medium` / `high`; the script maps it to whatever that
model actually calls it (Seedance wants `480p`, Kling wants `std`, Midjourney wants
`--q .25` inside the prompt). Never pass raw provider parameters yourself.

Full catalogue with live pricing: `reference/models.md`, or run
`node scripts/wanapis.mjs models`.

## Things that will bite you

- **Estimates are budgets, not quotes.** Upstreams do not always honour the exact
  request — a 4-second video came back as 5 seconds and was billed for 5. After a
  job finishes the script reports the amount actually charged; use that number when
  reporting cost to the user.
- **Cancelling does not stop billing.** Killing the request mid-flight does not
  cancel work upstream; it completes and is charged anyway. Never "retry to make it
  faster" — you pay for both. Wait, or poll.
- **Video URLs are not shareable, image URLs are.** Video results are served through
  an authenticated proxy and return 401 in a browser; images are public CDN links.
  Always use `--out` to save a file rather than handing a raw video URL to the user.
- **Result URLs expire in roughly 24 hours.** Download anything worth keeping.
- **Midjourney returns 4 images per call** and is billed once for the set.

## When a generation fails

Failures are usually upstream capacity, not a bad request. The script surfaces the
gateway's message. Retrying the same prompt once is reasonable; retrying repeatedly
is not — each attempt is billed. If a model keeps failing, switch models rather than
looping.
