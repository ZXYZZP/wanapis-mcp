import { IMAGE_MODELS, VIDEO_MODELS, normalizeImageOptions, normalizeVideoOptions } from './models.js';

const QUOTA_PER_CNY = 500000;
const PRICE_NOTE = 'Public catalog budget with an assumed group multiplier; the API key route and final charge are not established by this estimate.';
const finiteRate = (value) => typeof value === 'number' && Number.isFinite(value) && value >= 0;

/** Validate native parameters before loading a catalog, just as generation does. */
export function normalizeEstimateOptions(model, options = {}) {
  const groupRatio = options.group_ratio ?? 1;
  if (!finiteRate(groupRatio)) throw new Error('group_ratio must be a finite non-negative number');
  let settings;
  if (IMAGE_MODELS[model]?.family === 'gptimage25') settings = normalizeImageOptions(model, options);
  else if (VIDEO_MODELS[model]?.family === 'h3') settings = normalizeVideoOptions(model, options);
  else {
    if (options.quality !== undefined && !['low', 'medium', 'high'].includes(options.quality)) throw new Error('quality must be low, medium or high for this model');
    for (const field of ['resolution', 'ratio', 'fast_mode', 'context_ir_enabled']) {
      if (options[field] !== undefined) throw new Error(`${field} is not supported for ${model}`);
    }
    if (options.count !== undefined && (!Number.isSafeInteger(options.count) || options.count < 1)) throw new Error('count must be a positive integer');
    settings = { ...options, quality: options.quality ?? 'medium' };
    delete settings.group_ratio;
  }
  return { settings, groupRatio };
}

function unavailable(model, groupRatio, note, settings) {
  return { model, estimate: null, currency: 'CNY', group_ratio: groupRatio,
    group_ratio_source: 'user_assumption', settings, note };
}

// Decimal retail prices must round once, half-up, at the gateway's quota precision.
function decimal(value) {
  if (typeof value === 'object') return value;
  const [mantissa, exponent = '0'] = String(value).split(/e/i);
  const [whole, fraction = ''] = mantissa.split('.');
  const scale = fraction.length - Number(exponent);
  const units = BigInt(whole + fraction);
  return scale >= 0 ? { units, scale } : { units: units * 10n ** BigInt(-scale), scale: 0 };
}

function product(...values) {
  return values.map(decimal).reduce((a, b) => ({ units: a.units * b.units, scale: a.scale + b.scale }), { units: 1n, scale: 0 });
}

function sum(a, b) {
  a = decimal(a); b = decimal(b);
  const scale = Math.max(a.scale, b.scale);
  return { units: a.units * 10n ** BigInt(scale - a.scale) + b.units * 10n ** BigInt(scale - b.scale), scale };
}

function quoted(model, rawAmount, groupRatio, details) {
  const amount = product(rawAmount, groupRatio, QUOTA_PER_CNY);
  const denominator = 10n ** BigInt(amount.scale);
  const rounded = amount.units / denominator + (amount.units % denominator * 2n >= denominator ? 1n : 0n);
  if (rounded < 0n || rounded > BigInt(Number.MAX_SAFE_INTEGER)) {
    return unavailable(model, groupRatio, 'Price calculation is outside the supported numeric range', details.settings);
  }
  const quota = Number(rounded);
  return { model, estimate: quota / QUOTA_PER_CNY, estimated_quota: quota,
    currency: 'CNY', group_ratio: groupRatio, group_ratio_source: 'user_assumption',
    ...details };
}

function legacyPrice(entry, { quality, seconds, count }) {
  const tier = { low: '480p', medium: '720p', high: '1080p' };
  const imageTier = { low: '1K', medium: '2K', high: '4K' };
  const video = entry.video_pricing;
  if (video && seconds > 0) {
    const rate = video[tier[quality]] ?? video['*'] ?? Object.values(video)[0];
    if (finiteRate(rate) && rate > 0) return { amount: rate * seconds, basis: `${rate}/s × ${seconds}s` };
  }
  const image = entry.image_pricing;
  if (image) {
    const rate = image[imageTier[quality]];
    if (finiteRate(rate) && rate > 0) return { amount: rate * (count ?? 1), basis: `${rate} × ${count ?? 1}` };
  }
  if (finiteRate(entry.model_price) && entry.model_price > 0) {
    if (seconds > 0) return { amount: entry.model_price * seconds, basis: `${entry.model_price}/s × ${seconds}s` };
    return { amount: entry.model_price * (count ?? 1), basis: `${entry.model_price} × ${count ?? 1}` };
  }
  return null;
}

export function estimateCost(catalog, model, options = {}) {
  const { settings, groupRatio } = normalizeEstimateOptions(model, options);
  const entry = catalog.entries.get(model);
  if (!entry) return unavailable(model, groupRatio, 'Model is absent from the public pricing catalog', settings);
  if (IMAGE_MODELS[model]?.family === 'gptimage25') {
    const ratios = entry.image_tier_ratios;
    const quality = settings.quality === 'low' ? 1 : ratios?.[`quality:${settings.quality}`];
    const resolution = settings.resolution === '1k' ? 1 : ratios?.[`resolution:${settings.resolution}`];
    if (![entry.model_price, quality, resolution].every(finiteRate)) {
      return unavailable(model, groupRatio, 'Image tier pricing is missing or invalid', settings);
    }
    return quoted(model, product(entry.model_price, quality, resolution, settings.count), groupRatio, {
      basis: `${entry.model_price} × quality ${quality} × resolution ${resolution} × ${settings.count} images × group ${groupRatio}`,
      estimate_kind: 'tier_precharge', pricing_version: catalog.pricing_version, settings,
      breakdown: { base_image_price: entry.model_price, quality_multiplier: quality, resolution_multiplier: resolution, count: settings.count },
      note: `${PRICE_NOTE} Image tasks settle on actual usage; references, dimensions and prompt content can increase the charge beyond this tier precharge.`,
    });
  }
  if (VIDEO_MODELS[model]?.family === 'h3') {
    const meta = entry.video_pricing_meta;
    const rate = entry.video_pricing?.[settings.resolution];
    if (!meta || typeof meta.version !== 'string' || !Array.isArray(meta.resolutions) || !meta.resolutions.includes(settings.resolution) ||
        !Array.isArray(meta.ratios) || !meta.ratios.includes(settings.ratio) ||
        !Number.isSafeInteger(meta.long_from) || meta.long_from < 1 ||
        ![rate, meta.long_multiplier, meta.fast_mode?.multiplier, meta.context_ir?.price].every(finiteRate) ||
        meta.long_multiplier < 1 || meta.fast_mode.multiplier < 1 || meta.context_ir.unit !== 'request') {
      return unavailable(model, groupRatio, 'H3 pricing metadata is missing or incompatible', settings);
    }
    const maximum = meta.max_seconds_by_resolution?.[settings.resolution];
    if (!Number.isSafeInteger(meta.min_seconds) || !Number.isSafeInteger(meta.max_seconds) || !Number.isSafeInteger(maximum) ||
        settings.seconds < meta.min_seconds || settings.seconds > Math.min(meta.max_seconds, maximum)) {
      return unavailable(model, groupRatio, 'H3 pricing metadata does not cover this duration', settings);
    }
    const long = settings.seconds >= meta.long_from ? meta.long_multiplier : 1;
    const fast = settings.fast_mode ? meta.fast_mode.multiplier : 1;
    const ir = settings.context_ir_enabled ? meta.context_ir.price : 0;
    const video = rate * settings.seconds * long * fast;
    return quoted(model, sum(product(rate, settings.seconds, long, fast), ir), groupRatio, {
      basis: `(${rate}/s × ${settings.seconds}s × long ${long} × fast ${fast} + IR ${ir}) × group ${groupRatio}`,
      estimate_kind: 'specification_budget', pricing_version: meta.version, settings,
      breakdown: { price_per_second: rate, seconds: settings.seconds, long_multiplier: long, fast_multiplier: fast, video_fee: video, ir_fee: ir },
      note: PRICE_NOTE,
    });
  }
  const price = legacyPrice(entry, settings);
  if (!price) return unavailable(model, groupRatio, 'No price configured for this model', settings);
  // Preserve the legacy four-decimal display while identifying it as a budget.
  return { model, estimate: Number((price.amount * groupRatio).toFixed(4)), currency: 'CNY',
    basis: `${price.basis} × group ${groupRatio}`, settings, group_ratio: groupRatio,
    group_ratio_source: 'user_assumption', estimate_kind: 'budget', pricing_version: catalog.pricing_version, note: PRICE_NOTE };
}
