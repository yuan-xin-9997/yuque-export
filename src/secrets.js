const secrets = new Set()
export function rememberSecret(value) {
  if (typeof value === 'string' && value) {
    secrets.add(value)
    secrets.add(encodeURIComponent(value))
  }
}
export function redact(value) {
  let text = String(value)
  for (const secret of [...secrets].sort((a, b) => b.length - a.length)) text = text.split(secret).join('[REDACTED]')
  return text.replace(/(cookie\s*[:=]\s*)[^\r\n]+/gi, '$1[REDACTED]')
}

export function publicConfig(value) {
  if (Array.isArray(value)) return value.map(publicConfig)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(Object.entries(value).map(([key, item]) =>
    [key, /token|cookie|authorization|password/i.test(key) ? '[REDACTED]' : publicConfig(item)]))
}
