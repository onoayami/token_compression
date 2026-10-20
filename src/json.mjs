export const stripBOM = text => text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;

export function parseJSON(text, label = 'JSON') {
  try { return JSON.parse(stripBOM(text)); }
  catch { throw new Error(`${label} is invalid JSON; check BOM, trailing commas and UTF-8 encoding`); }
}
