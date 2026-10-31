# Changelog

## 0.1.1 — 2026-10-31

- Validate each tool's declared input schema before making an HTTP request. Missing required fields, invalid types and unsupported enum values return a tool error.
- Keep completed local image jobs that returned a `job_id` available for repeated checks and download retries until 30 minutes after submission. These jobs remain in memory and do not survive a server restart.
- Extract image URLs from the nested asynchronous task response envelope, including `data.data.data.result.images[].url[]`, so successful image tasks can be downloaded.
- Require MCP SDK 1.30.0 or newer for the schema validator.
