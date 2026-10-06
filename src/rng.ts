// 确定性伪随机：FNV-1a 哈希种子字符串 -> mulberry32 -> Fisher-Yates 无重复取样。
// 只依赖种子字符串，与时间、进程、平台无关。

export function hashSeed(seed: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 从 candidates 中确定性无重复取样 count 个元素（不修改入参数组）。 */
export function sampleDeterministic<T>(candidates: readonly T[], count: number, seed: string): T[] {
  if (count < 0 || count > candidates.length) {
    throw new Error(`cannot sample ${count} from ${candidates.length}`);
  }
  const arr = candidates.slice();
  const rand = mulberry32(hashSeed(seed));
  for (let i = 0; i < count; i++) {
    const j = i + Math.floor(rand() * (arr.length - i));
    const tmp = arr[i];
    arr[i] = arr[j];
    arr[j] = tmp;
  }
  return arr.slice(0, count).sort((a, b) => (a as number) - (b as number));
}
