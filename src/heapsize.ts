// a heap size: bytes, or k, m or g (NaN when malformed)
export function heapSize(s: string): number {
  const unit = { k: 2 ** 10, m: 2 ** 20, g: 2 ** 30 }[s.slice(-1).toLowerCase()];
  return unit ? Number(s.slice(0, -1)) * unit : Number(s);
}
