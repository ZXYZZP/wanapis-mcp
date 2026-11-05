# Changelog

## 0.1.3 — 2026-11-05

- Seedance: accept the canonical `image_urls` / `image_with_roles` / `video_urls` / `audio_urls` media shape, including first/last frames, up to 9 images, 3 reference videos and 3 audio clips. Local files are uploaded to the gateway's temporary media relay and replaced with a signed public URL; H3 `asset_id`s are rejected.
- H3: accept up to 9 images including explicit first/last frames, up to 3 reference videos and 3 reference audio clips. Local media is uploaded once to an opaque `asset_id`; URLs, data URIs and existing assets are passed through. The legacy single `image_url` remains supported.
- Add `wanapis_upload_media`, `wanapis_regenerate_video` (2K source/content modes) and `wanapis_optimize_prompt` (standalone text task). `wanapis_check_task` accepts `kind: "prompt"` and reports billing status, reserved/charged/refunded CNY and prompt text.
- H3 media estimates return a reservation upper bound: extra images after the first five and reference-video seconds at the protocol input bound, with duration/priority multipliers and IR; pending settlement is not displayed as a final charge.
- The standalone Skill CLI gains `upload`, `regenerate`, `optimize`, frame/reference flags, `task --kind prompt` and the same reservation billing output. Help and model reference updated.

## 0.1.2 — 2026-10-31

- Add asynchronous GPT Image 2.5 Flare/Sunburst adapters with independent quality and resolution, image count and reference images. Defaults explicitly use low quality, 1k and one image.
- Add MiniMax H3 with native resolution, ratio, integer duration, single opening-frame image, priority mode and IR options. Defaults use four seconds, 768P, priority off and IR on.
- Estimate the new models using public tier ratios and H3 duration/priority/IR metadata. Show CNY, specifications and the assumed group multiplier; describe image tier amounts as precharges that can increase with actual usage.
- List only current public catalog entries with verified adapters, without sending the API key to the public pricing endpoint. Unknown or incompatible native options fail before any HTTP request.
- Synchronize the standalone Skill from the canonical MCP model/catalog/pricing helpers, extend CLI and protocol regression tests, and parse nested async-image results in the Skill.

## 0.1.1 — 2026-10-31

- Validate each tool's declared input schema before making an HTTP request. Missing required fields, invalid types and unsupported enum values return a tool error.
- Keep completed local image jobs that returned a `job_id` available for repeated checks and download retries until 30 minutes after submission. These jobs remain in memory and do not survive a server restart.
- Extract image URLs from the nested asynchronous task response envelope, including `data.data.data.result.images[].url[]`, so successful image tasks can be downloaded.
- Require MCP SDK 1.30.0 or newer for the schema validator.
