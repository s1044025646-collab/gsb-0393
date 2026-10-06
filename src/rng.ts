// 公开的确定性伪随机算法：
// 1) 种子字符串经 FNV-1a(32) 哈希得到 32 位整数；
// 2) 以 splitmix32 生成伪随机流；
// 3) 对候选位置做 Fisher-Yates 部分洗牌取样。
// 同一种子在任何进程、任何时刻产生完全相同序列。

export function fnv1a32(input: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export function splitmix32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x9e3779b9) >>> 0;
    let z = state;
    z = Math.imul(z ^ (z >>> 16), 0x21f0aaad);
    z = Math.imul(z ^ (z >>> 15), 0x735a2d97);
    z = (z ^ (z >>> 15)) >>> 0;
    return z;
  };
}

export function rngFromSeed(seed: string): () => number {
  return splitmix32(fnv1a32(seed));
}

// 从 [0, n) 中无重复取样 k 个，返回升序数组。k <= n 由调用方保证。
export function sample(seed: string, n: number, k: number): number[] {
  const next = rngFromSeed(seed);
  const arr = new Array<number>(n);
  for (let i = 0; i < n; i++) arr[i] = i;
  for (let i = 0; i < k; i++) {
    const j = i + (next() % (n - i));
    const t = arr[i]; arr[i] = arr[j]; arr[j] = t;
  }
  return arr.slice(0, k).sort((a, b) => a - b);
}
