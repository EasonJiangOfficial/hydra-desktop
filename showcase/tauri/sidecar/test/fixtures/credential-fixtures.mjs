// Deterministic strings for the shape classifiers. The padding is synthetic and no
// fixture comes from an account, integration, provider or environment variable.
export function credentialFixture(prefix, length, padding = 'TESTFIXTURE') {
  return prefix + padding.repeat(Math.ceil(length / padding.length)).slice(0, length);
}

// A file format marker without any key data.
export function privateKeyHeader(kind) {
  return `-----BEGIN ${kind ? `${kind} ` : ''}PRIVATE KEY-----`;
}
