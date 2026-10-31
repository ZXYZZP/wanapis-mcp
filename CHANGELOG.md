# Changelog

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
