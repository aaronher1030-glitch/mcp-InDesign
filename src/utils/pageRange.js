export function parsePageRange(value = 'all', pageCount = 1) {
  if (!Number.isInteger(pageCount) || pageCount < 1) {
    throw new Error('pageCount must be a positive integer');
  }
  if (value === undefined || value === null || String(value).trim() === '') value = 'all';
  if (String(value).trim().toLowerCase() === 'all') {
    return Array.from({ length: pageCount }, (_, index) => index);
  }

  const pages = new Set();
  for (const rawPart of String(value).split(',')) {
    const part = rawPart.trim();
    const range = part.match(/^(\d+)\s*-\s*(\d+)$/);
    if (range) {
      const start = Number(range[1]);
      const end = Number(range[2]);
      if (start < 1 || end < start || end > pageCount) {
        throw new Error(`Page range is invalid: ${part}`);
      }
      for (let page = start; page <= end; page += 1) pages.add(page - 1);
      continue;
    }
    if (!/^\d+$/.test(part)) throw new Error(`Invalid page entry: ${part}`);
    const page = Number(part);
    if (page < 1) throw new Error(`Page must be a positive integer: ${part}`);
    if (page > pageCount) throw new Error(`Page is out of range: ${part}`);
    pages.add(page - 1);
  }
  return [...pages].sort((a, b) => a - b);
}
