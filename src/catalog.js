import { IMAGE_MODELS, VIDEO_MODELS, modelCapabilities } from './models.js';

/** Keep routing metadata without treating anonymous visibility as token permission. */
export function parseCatalog(payload) {
  if (!payload || payload.success === false || !Array.isArray(payload.data)) {
    throw new Error('Invalid pricing catalog: expected a successful data array');
  }
  const entries = new Map();
  for (const row of payload.data) {
    if (!row || typeof row !== 'object' || typeof row.model_name !== 'string' || !row.model_name) {
      throw new Error('Invalid pricing catalog model entry');
    }
    if (entries.has(row.model_name)) throw new Error(`Ambiguous pricing catalog entry: ${row.model_name}`);
    entries.set(row.model_name, row);
  }
  return {
    entries, pricing_version: payload.pricing_version ?? null,
    group_ratio: payload.group_ratio ?? {}, usable_group: payload.usable_group ?? {},
    auto_groups: payload.auto_groups ?? [],
  };
}

export function listCatalogModels(catalog, kind = 'all') {
  if (!['image', 'video', 'all'].includes(kind)) throw new Error('kind must be image, video or all');
  const rows = [];
  for (const [models, k] of [[VIDEO_MODELS, 'video'], [IMAGE_MODELS, 'image']]) {
    if (kind !== 'all' && kind !== k) continue;
    for (const [id, spec] of Object.entries(models)) {
      const entry = catalog.entries.get(id);
      if (!entry) continue;
      rows.push({
        model: id, kind: k, note: spec.note, price: entry.model_price ?? null,
        tiers: entry.video_pricing ?? entry.image_pricing ?? null,
        image_tier_ratios: entry.image_tier_ratios ?? null,
        video_pricing_meta: entry.video_pricing_meta ?? null,
        enable_groups: entry.enable_groups ?? [], capabilities: modelCapabilities(id),
      });
    }
  }
  return rows;
}
