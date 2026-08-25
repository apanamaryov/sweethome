export function downloadFileName(cam: string, fromMs: number): string {
  const d = new Date(fromMs);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${cam}_${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}.mp4`;
}
