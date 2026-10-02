/**
 * PRD 15.14：中文文件名下载不乱码。
 * 老浏览器只认 filename，新浏览器优先 filename*，因此双写；控制字符与引号一律剔除。
 */
export function contentDisposition(filename: string, mode: 'attachment' | 'inline' = 'attachment'): string {
  const cleaned = (filename ?? '').replace(/[\r\n"]/g, '').trim() || 'download';
  const ascii = cleaned
    .normalize('NFKD')
    .replace(/[^\x20-\x7e]/g, '_')
    .replace(/["\\;]/g, '_');
  const encoded = encodeURIComponent(cleaned).replace(/'/g, '%27');
  return `${mode}; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}
