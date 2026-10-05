// Tiny in-memory sliding-window rate limiter (single-process app, so no shared store is needed).
const buckets = new Map(); // key -> [timestamps]

function hit(key, max, windowMs) {
  const now = Date.now();
  const arr = (buckets.get(key) || []).filter((t) => now - t < windowMs);
  arr.push(now);
  buckets.set(key, arr);
  if (buckets.size > 5000) for (const [k, v] of buckets) if (!v.some((t) => now - t < windowMs)) buckets.delete(k);
  return arr.length <= max;            // true = allowed
}

// Express middleware factory: limit(name, max, windowMs) keyed by client IP
function limit(name, max, windowMs) {
  return (req, res, next) => {
    if (hit(`${name}:${req.ip}`, max, windowMs)) return next();
    res.setHeader('Retry-After', Math.ceil(windowMs / 1000));
    res.status(429).json({ error: 'Too many requests — try again later' });
  };
}

module.exports = { hit, limit };
