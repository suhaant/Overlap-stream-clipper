/**
 * Logistic regression, written out rather than depended on.
 *
 * Needed only to reimplement LIGHTOR's baseline honestly: the paper combines
 * three normalised chat features with logistic regression, and comparing
 * against something else would not be comparing against the paper. Batch
 * gradient descent is ample for three features.
 */

const sigmoid = (z) => 1 / (1 + Math.exp(-Math.max(-30, Math.min(30, z))));

/** Column-wise min/max, so features on different scales train evenly. */
export function fitScaler(rows, keys) {
  const min = {}, max = {};
  for (const k of keys) { min[k] = Infinity; max[k] = -Infinity; }
  for (const r of rows) {
    for (const k of keys) {
      const v = r[k] ?? 0;
      if (v < min[k]) min[k] = v;
      if (v > max[k]) max[k] = v;
    }
  }
  return { keys, min, max };
}

export function applyScaler(scaler, row) {
  return scaler.keys.map(k => {
    const span = scaler.max[k] - scaler.min[k];
    if (!Number.isFinite(span) || span === 0) return 0;
    return ((row[k] ?? 0) - scaler.min[k]) / span;
  });
}

/**
 * Fit weights by gradient descent.
 *
 * `posWeight` upweights the positive class. Positives are about 2.6% of
 * windows, and without it the fastest way to reduce loss is to predict zero
 * for everything, which gets 97% accuracy and finds nothing.
 */
export function fit(X, y, { epochs = 400, lr = 0.5, l2 = 1e-4, posWeight = null } = {}) {
  const n = X.length;
  if (!n) throw new Error('fit: no rows');
  const d = X[0].length;
  const w = new Array(d).fill(0);
  let b = 0;

  const positives = y.reduce((s, v) => s + v, 0);
  const pw = posWeight ?? (positives ? (n - positives) / positives : 1);

  for (let epoch = 0; epoch < epochs; epoch++) {
    const gw = new Array(d).fill(0);
    let gb = 0, wsum = 0;

    for (let i = 0; i < n; i++) {
      const weight = y[i] === 1 ? pw : 1;
      let z = b;
      for (let j = 0; j < d; j++) z += w[j] * X[i][j];
      const err = (sigmoid(z) - y[i]) * weight;
      for (let j = 0; j < d; j++) gw[j] += err * X[i][j];
      gb += err;
      wsum += weight;
    }

    for (let j = 0; j < d; j++) w[j] -= lr * (gw[j] / wsum + l2 * w[j]);
    b -= lr * (gb / wsum);
  }

  return { w, b };
}

export const predict = (model, x) => {
  let z = model.b;
  for (let j = 0; j < x.length; j++) z += model.w[j] * x[j];
  return sigmoid(z);
};
